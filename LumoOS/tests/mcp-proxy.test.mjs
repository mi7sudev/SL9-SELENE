// mcp-proxy.test.mjs — end-to-end tests of the MCP tool loop inside the BYOK
// proxy: spawn lumo-server.cjs against a temp data dir + the stub provider,
// drive /byok-api/chat/completions the way the Lumo client does, and assert
// on the SSE stream the client would see plus what the stub provider received.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stub = require(path.join(ROOT, 'tests', 'stub-provider.cjs'));

const UID = 'uid-' + crypto.randomBytes(10).toString('hex');
const PW = 'pw-' + crypto.randomBytes(6).toString('hex');

async function freePort() {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = srv.address().port;
    await new Promise((r) => srv.close(r));
    return p;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumo-mcp-test-'));
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(PW, salt, 32).toString('hex');
fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify({
    testadmin: { uid: UID, salt, hash, displayName: 'Test Admin', createdAt: new Date().toISOString(), role: 'admin', disabled: false },
}));

const stubPort = await freePort();
await stub.listen(stubPort);

// Pre-boot fixtures: the server migrates these legacy JSON stores into its
// SQLite database on first boot (users + admin config are only ever written
// here, before spawn — mid-run server-list changes go through the admin API,
// see setServers below).
function writeServerCfg(entry) {
    fs.writeFileSync(path.join(dataDir, 'mcp-servers.json'), JSON.stringify({
        servers: entry ? [{
            id: 'mcptest', name: 'Fake', transport: 'stdio',
            command: process.execPath, args: [path.join(ROOT, 'tests', 'fake-mcp-server.cjs')],
            env: { FAKE_TOKEN: 'super-secret-token-value' },
            enabled: true, toolPermissions: {},
        }] : [],
    }));
}

const serverPort = await freePort();
// generic control-tool drivers: 'stub-call-ctl:<toolName>:<argsJson>' calls the
// named lumo__ control tool with exact arguments (used to prove real
// connect/disconnect/revoke flows over the live proxy)
const CTL_CONNECT = 'stub-call-ctl:lumo__connection_connect:' + JSON.stringify({ serverId: 'mcphttp2', confirm: true });
const CTL_DISCONNECT = 'stub-call-ctl:lumo__connection_disconnect:' + JSON.stringify({ serverId: 'mcphttp2', confirm: true });
fs.writeFileSync(path.join(dataDir, 'admin-config.json'), JSON.stringify({
    providers: [{ id: 'p1', name: 'Stub', baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: 'sk-stub', models: ['stub-roundtrip', 'stub-no-tools', 'stub-rejects-tools', 'stub-always-tools', 'stub-plain', 'stub-tool-names', 'stub-call-list', 'stub-call-echo', 'stub-call-echo-slow', 'stub-call-delete', 'stub-call-unknown', CTL_CONNECT, CTL_DISCONNECT] }],
    defaultModel: null,
}));

let server;
before(async () => {
    writeServerCfg(true);
    server = spawn(process.execPath, [path.join(ROOT, 'lumo-server.cjs')], {
        env: { ...process.env, LUMO_PORT: String(serverPort), LUMO_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    // wait for readiness
    for (let i = 0; i < 100; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${serverPort}/api/lumo/v1/me`);
            if (r.ok) return;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('lumo-server did not become ready');
});
after(async () => {
    try { server.kill(); } catch { /* already gone */ }
    await stub.close();
});

const chat = async (model, extra = {}) => fetch(`http://127.0.0.1:${serverPort}/byok-api/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-pm-uid': UID },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: true, ...extra }),
});

async function readSse(res) {
    const text = await res.text();
    const frames = [];
    let doneCount = 0;
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') { doneCount++; continue; }
        try { frames.push(JSON.parse(payload)); } catch { /* skip */ }
    }
    return { frames, doneCount, raw: text };
}
const contentOf = (frames) => frames.filter((f) => f.choices?.[0]?.delta?.content).map((f) => f.choices[0].delta.content).join('');
const zapOf = (frames) => frames.filter((f) => f.choices?.[0]?.delta?.zap_tool).map((f) => f.choices[0].delta.zap_tool);

test('full MCP round-trip: tool advertised, executed, result fed back, final answer streamed', async () => {
    const res = await chat('stub-roundtrip');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('x-byok-proxy'), '1');
    const { frames, doneCount, raw } = await readSse(res);
    const content = contentOf(frames);
    // the stub echoes the tool message contents in its final round
    assert.match(content, /FINAL:[\s\S]*echo: hi from stub/);
    assert.match(content, /untrusted external data/); // framing reached the model
    assert.equal(doneCount, 1);
    assert.ok(raw.trimEnd().endsWith('data: [DONE]'), 'stream must end with the DONE sentinel');

    const zaps = zapOf(frames);
    assert.equal(zaps.length, 2);
    assert.equal(zaps[0].status, 'start');
    assert.equal(zaps[0].name.endsWith('__echo'), true);
    assert.deepEqual(zaps[0].args, { text: 'hi from stub' });
    assert.equal(zaps[1].status, 'done');
    assert.match(zaps[1].result, /echo: hi from stub/);

    // round 1 must have advertised the fake server's two tools, qualified,
    // plus the 4 reserved-prefixed connection control-plane tools (lumo__*)
    assert.equal(stub.lastBody.model, 'stub-roundtrip');
    const lastTools = stub.lastBody.tools; // last call = final round, tools still present
    assert.ok(Array.isArray(lastTools) && lastTools.length === 2 + 4);
    const dataTools = lastTools.filter((t) => !t.function.name.startsWith('lumo__'));
    const controlTools = lastTools.filter((t) => t.function.name.startsWith('lumo__'));
    assert.equal(dataTools.length, 2);
    assert.equal(controlTools.length, 4);
    assert.deepEqual(
        controlTools.map((t) => t.function.name).sort(),
        ['lumo__connection_connect', 'lumo__connection_disconnect', 'lumo__connection_status', 'lumo__connections_list'],
    );
    assert.match(dataTools[0].function.name, /^[a-z0-9_-]+__[a-zA-Z0-9_-]+$/);
    assert.equal(dataTools[0].function.name.length <= 64, true);
    assert.equal(dataTools[0].function.name.endsWith('__echo'), true);
    assert.equal(dataTools[1].function.name.endsWith('__fail'), true);
    assert.equal(stub.lastBody.tool_choice, 'auto');
});

test('system note + tool messages shape what the provider receives', async () => {
    // stub-roundtrip already ran; inspect what the final round carried
    const msgs = stub.lastBody.messages;
    assert.equal(msgs[0].role, 'system');
    assert.match(msgs[0].content, /MCP|untrusted data/i);
    const assistant = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.ok(assistant, 'assistant tool_calls message present');
    assert.equal(assistant.tool_calls[0].id, 'call_stub_1');
    const toolMsg = msgs.find((m) => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, 'call_stub_1');
    assert.match(toolMsg.content, /echo: hi from stub/);
});

test('non-stream (title generation) never receives tools', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/byok-api/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pm-uid': UID },
        body: JSON.stringify({ model: 'stub-plain', messages: [{ role: 'user', content: 'title please' }], stream: false }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.match(json.choices[0].message.content, /tools=no/);
});

test('provider that rejects tools: strip-retry continues as plain chat', async () => {
    const res = await chat('stub-rejects-tools');
    assert.equal(res.status, 200);
    const { frames, doneCount } = await readSse(res);
    assert.match(contentOf(frames), /ok-no-tools/);
    assert.equal(doneCount, 1);
});

test('model that keeps calling tools: round limit stops the loop', async () => {
    const res = await chat('stub-always-tools');
    assert.equal(res.status, 200);
    const { frames, doneCount } = await readSse(res);
    // MAX_MCP_ROUNDS = 5: rounds 1-4 execute their tool calls, the 5th
    // round's tool_calls are refused and the loop stops with the notice.
    const zaps = zapOf(frames);
    assert.equal(zaps.filter((z) => z.status === 'start').length, 4);
    assert.match(contentOf(frames), /round limit/);
    assert.equal(doneCount, 1);
});

test('tool error surfaces as an error card and a tool message the model can recover from', async () => {
    // the fake server's `fail` tool: force it by disabling `echo` via permissions
    const putRes = await fetch(`http://127.0.0.1:${serverPort}/api/lumo/v1/admin/mcp/servers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-pm-uid': UID },
        body: JSON.stringify({ Server: { id: 'mcptest', name: 'Fake', transport: 'stdio', command: process.execPath, args: [path.join(ROOT, 'tests', 'fake-mcp-server.cjs')], env: { FAKE_TOKEN: 'super-secret-token-value' }, toolPermissions: { echo: 'off', fail: 'on' } } }),
    });
    assert.equal(putRes.status, 200);
    // stub-roundtrip with echo off: no usable tools for that model? fail is still on,
    // so tools ARE advertised, but the stub calls tools[0] which is now `fail`.
    // (stub always invokes the first advertised tool)
    const res = await chat('stub-roundtrip');
    assert.equal(res.status, 200);
    const { frames } = await readSse(res);
    const zaps = zapOf(frames);
    assert.equal(zaps[1].status, 'error');
    assert.match(zaps[1].result, /failed/);
    assert.match(contentOf(frames), /Tool error: Tool "fail" failed/);
});

test('admin API: server view exposes envKeys, never env values', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/lumo/v1/admin/mcp/servers`, {
        headers: { 'x-pm-uid': UID },
    });
    assert.equal(res.status, 200);
    const { Code, Servers } = await res.json();
    assert.equal(Code, 1000);
    assert.equal(Servers.length, 1);
    assert.deepEqual(Servers[0].envKeys, ['FAKE_TOKEN']);
    assert.equal(JSON.stringify(Servers).includes('super-secret-token-value'), false);
    assert.equal(Servers[0].tools.some((t) => t.name === 'echo' && t.enabled === false), true);
});

test('removing the last MCP server restores the pure passthrough', async () => {
    const del = await fetch(`http://127.0.0.1:${serverPort}/api/lumo/v1/admin/mcp/servers`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-pm-uid': UID },
        body: JSON.stringify({ id: 'mcptest' }),
    });
    assert.equal(del.status, 200);
    const res = await chat('stub-plain');
    assert.equal(res.status, 200);
    const { frames, doneCount } = await readSse(res);
    assert.equal(contentOf(frames), 'TOOLS:no'); // provider saw no tools field
    assert.equal(doneCount, 1);
    assert.equal(zapOf(frames).length, 0);
    // passthrough must not add zap frames or a system note
    const msgs = stub.lastBody.messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
});

test('unauthenticated BYOK requests are still rejected', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/byok-api/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'stub-plain', messages: [{ role: 'user', content: 'x' }], stream: true }),
    });
    assert.equal(res.status, 401);
});

test('non-admin cannot reach MCP admin APIs', async () => {
    // make a regular user
    const su = await fetch(`http://127.0.0.1:${serverPort}/api/local/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'plainuser', password: 'pw-plain-123', displayName: 'Plain' }),
    });
    assert.equal(su.status, 200);
    const { UID: plainUid } = await su.json();
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/lumo/v1/admin/mcp/servers`, {
        headers: { 'x-pm-uid': plainUid },
    });
    assert.equal(res.status, 403);
});

// ══════════ connection plane + zap_mcp mute preference ══════════

const { createFakeMcpHttpServer } = require(path.join(ROOT, 'tests', 'fake-mcp-http-server.cjs'));
const adminHeaders = { 'Content-Type': 'application/json', 'x-pm-uid': UID };
let fakeHttp = null;
let fakeHttpPort = 0;

// the canonical stdio fixture, restored between test groups via the admin API
const STDIO_FAKE = {
    id: 'mcptest', name: 'Fake', transport: 'stdio',
    command: process.execPath, args: [path.join(ROOT, 'tests', 'fake-mcp-server.cjs')],
    env: { FAKE_TOKEN: 'super-secret-token-value' },
    enabled: true, toolPermissions: {},
};

// The SQLite store is the single source of truth now — rewriting
// mcp-servers.json mid-run would be inert, so the old file-writer fixtures go
// through the real admin API instead (GET current list -> DELETE all -> PUT
// the targets). A hand-planted id like "lumo" is filtered on read, so it
// survives this helper invisibly and harmlessly.
async function setServers(servers) {
    const cur = await fetch(`http://127.0.0.1:${serverPort}/api/lumo/v1/admin/mcp/servers`, { headers: adminHeaders });
    assert.equal(cur.status, 200);
    const { Servers } = await cur.json();
    for (const s of Servers) {
        const del = await fetch(`http://127.0.0.1:${serverPort}/api/lumo/v1/admin/mcp/servers`, {
            method: 'DELETE', headers: adminHeaders, body: JSON.stringify({ id: s.id }),
        });
        assert.equal(del.status, 200, `DELETE ${s.id}`);
    }
    for (const entry of servers) {
        const put = await fetch(`http://127.0.0.1:${serverPort}/api/lumo/v1/admin/mcp/servers`, {
            method: 'PUT', headers: adminHeaders, body: JSON.stringify({ Server: entry }),
        });
        assert.equal(put.status, 200, `PUT ${entry.id}: ${JSON.stringify(await put.json())}`);
    }
}

async function useHttpServer(auth, toolPermissions) {
    await setServers([{
        id: 'mcphttp', name: 'FakeHttp', transport: 'http',
        url: `http://127.0.0.1:${fakeHttpPort}/mcp`,
        enabled: true, trustedLocal: true, auth,
        authHeaderName: 'Authorization', authHeaderPrefix: 'Bearer',
        toolPermissions: toolPermissions || {},
    }]);
}

test('zap_mcp malformed values are ignored and stripped from every provider body', async () => {
    await setServers([STDIO_FAKE]);
    const cases = [
        { zap_mcp: null }, { zap_mcp: 'x' }, { zap_mcp: 42 }, { zap_mcp: [] },
        { zap_mcp: {} }, { zap_mcp: { off: 'mcptest' } }, { zap_mcp: { off: null } },
        { zap_mcp: { off: [123, null, {}] } }, { zap_mcp: { off: ['x'.repeat(80)] } },
        { zap_mcp: { off: Array.from({ length: 70 }, (_, i) => `s${i}`) } },
    ];
    for (const extra of cases) {
        const res = await chat('stub-tool-names', extra);
        assert.equal(res.status, 200, `case ${JSON.stringify(extra)}`);
        const { frames } = await readSse(res);
        assert.match(contentOf(frames), /NAMES:mcptest__/, `case ${JSON.stringify(extra)}`);
        // the control field never reaches the provider (or its retry bodies)
        assert.equal(stub.lastBody.zap_mcp, undefined, `case ${JSON.stringify(extra)}`);
    }
});

test('valid mute list removes a server from this request only (no cross-request leakage)', async () => {
    let res = await chat('stub-tool-names', { zap_mcp: { off: ['mcptest'] } });
    let { frames } = await readSse(res);
    assert.equal(contentOf(frames), 'NAMES:none'); // data tools muted
    assert.equal(zapOf(frames).length, 0);
    // control tools are still advertised (connection management stays available)
    assert.ok(stub.lastBody.tools.every((t) => t.function.name.startsWith('lumo__')));

    res = await chat('stub-tool-names');
    ({ frames } = await readSse(res));
    assert.match(contentOf(frames), /NAMES:mcptest__echo/);

    // concurrent requests with different mute lists must not affect each other
    const [muted, unmuted] = await Promise.all([
        chat('stub-tool-names', { zap_mcp: { off: ['mcptest'] } }),
        chat('stub-tool-names'),
    ]);
    assert.match(contentOf((await readSse(muted)).frames), /NAMES:none/);
    assert.match(contentOf((await readSse(unmuted)).frames), /NAMES:mcptest__echo/);
});

test('non-stream chat with zap_mcp: field stripped, still no tools injected', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/byok-api/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pm-uid': UID },
        body: JSON.stringify({ model: 'stub-plain', messages: [{ role: 'user', content: 'title please' }], stream: false, zap_mcp: { off: ['mcptest'] } }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.match(json.choices[0].message.content, /title-ok tools=no/);
    assert.equal(stub.lastBody.zap_mcp, undefined);
    assert.equal(stub.lastBody.tools, undefined);
});

test('provider-retry path also strips the control field', async () => {
    const res = await chat('stub-rejects-tools', { zap_mcp: { off: ['mcptest'] }, reasoning_effort: 'high' });
    assert.equal(res.status, 200);
    const { frames } = await readSse(res);
    assert.match(contentOf(frames), /ok-no-tools/); // tools + thinking stripped, retry recovered
    assert.equal(stub.lastBody.zap_mcp, undefined);
});

test('control-plane round trip: connections_list executes and renders as a native tool card', async () => {
    const res = await chat('stub-call-list');
    assert.equal(res.status, 200);
    const { frames, doneCount } = await readSse(res);
    const zaps = zapOf(frames);
    assert.equal(zaps.length, 2);
    assert.equal(zaps[0].status, 'start');
    assert.equal(zaps[0].name, 'lumo__connections_list');
    assert.equal(zaps[1].status, 'done');
    const result = JSON.parse(zaps[1].result);
    assert.ok(Array.isArray(result.connections));
    assert.ok(result.connections.find((c) => c.serverId === 'mcptest'));
    // server-generated status, but still no env values anywhere
    assert.equal(zaps[1].result.includes('super-secret-token-value'), false);
    assert.match(contentOf(frames), /\[Connection manager result\]/);
    assert.equal(doneCount, 1);
    // the provider-visible system note pins the intent-detection contract:
    // list first, resolve loose product names, never register, confirm before
    // state-changing calls, never claim success before status is ready
    const sys = stub.lastBody.messages.find((m) => m.role === 'system');
    assert.ok(sys, 'system note present');
    assert.match(sys.content, /call lumo__connections_list first/);
    assert.match(sys.content, /Resolve loose product names/);
    assert.match(sys.content, /administrator must add that connection first/);
    assert.match(sys.content, /Never invent, register, or modify servers/);
    assert.match(sys.content, /confirmation in chat/);
    assert.match(sys.content, /NEVER claim a connection succeeded until/);
});

test('catalog endpoint: auth-gated, redacted, honest states', async () => {
    const catalogUrl = `http://127.0.0.1:${serverPort}/api/lumo/v1/mcp/connections`;
    const noAuth = await fetch(catalogUrl);
    assert.equal(noAuth.status, 401);
    const r = await fetch(catalogUrl, { headers: { 'x-pm-uid': UID } });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.Account, UID);
    assert.match(json.Version, /^[0-9a-f]{16}$/);
    const c = json.Connections.find((x) => x.Id === 'mcptest');
    assert.ok(c, 'mcptest listed');
    assert.equal(c.Name, 'Fake');
    assert.equal(c.Auth, 'none');
    assert.ok(['ready', 'not_discovered'].includes(c.Status));
    assert.equal(c.ToolCount === null, c.Status === 'not_discovered');
    assert.ok(!('command' in c) && !('envKeys' in c) && !('url' in c));
    assert.equal(JSON.stringify(json).includes('super-secret-token-value'), false);
    // field-level redaction: no transport internals of any kind
    const flat = JSON.stringify(json);
    for (const forbidden of ['authHeaderName', 'authHeaderPrefix', 'inputSchema', 'command', 'envKeys', 'Bearer ', 'http://', 'https://']) {
        assert.equal(flat.includes(forbidden), false, `catalog must not contain "${forbidden}"`);
    }
});

test('write-capable tools need admin opt-in; approved tools execute; unknown tools refused', async () => {
    fakeHttp = createFakeMcpHttpServer({});
    await new Promise((r) => fakeHttp.server.listen(0, '127.0.0.1', r));
    fakeHttpPort = fakeHttp.server.address().port;
    await useHttpServer('none', {});

    // advertised: read-only echo yes; write-capable delete_item NO (no opt-in)
    let res = await chat('stub-tool-names');
    let { frames } = await readSse(res);
    let names = contentOf(frames);
    assert.match(names, /mcphttp__echo/);
    assert.doesNotMatch(names, /mcphttp__delete_item/);

    // admin opts in via the normal admin API
    const put = await fetch(`http://127.0.0.1:${serverPort}/api/lumo/v1/admin/mcp/servers`, {
        method: 'PUT', headers: adminHeaders,
        body: JSON.stringify({ Server: { id: 'mcphttp', name: 'FakeHttp', transport: 'http', url: `http://127.0.0.1:${fakeHttpPort}/mcp`, auth: 'none', toolPermissions: { delete_item: 'on' } } }),
    });
    assert.equal(put.status, 200);

    res = await chat('stub-tool-names');
    ({ frames } = await readSse(res));
    names = contentOf(frames);
    assert.match(names, /mcphttp__echo/);
    assert.match(names, /mcphttp__delete_item/);

    // approved write tool executes end-to-end
    res = await chat('stub-call-delete');
    ({ frames } = await readSse(res));
    const zaps = zapOf(frames);
    assert.equal(zaps[1].status, 'done');
    assert.match(zaps[1].result, /deleted x/);

    // a form save (payload WITHOUT toolPermissions — the admin form round-trips
    // config only) must carry the stored approvals forward, not reset them
    const formSave = await fetch(`http://127.0.0.1:${serverPort}/api/lumo/v1/admin/mcp/servers`, {
        method: 'PUT', headers: adminHeaders,
        body: JSON.stringify({ Server: { id: 'mcphttp', name: 'FakeHttp', transport: 'http', url: `http://127.0.0.1:${fakeHttpPort}/mcp`, auth: 'none' } }),
    });
    assert.equal(formSave.status, 200);
    res = await chat('stub-tool-names');
    ({ frames } = await readSse(res));
    assert.match(contentOf(frames), /mcphttp__delete_item/, 'form save must preserve toolPermissions');

    // fabricated tool name is refused before any external action
    res = await chat('stub-call-unknown');
    ({ frames } = await readSse(res));
    const unknownZaps = zapOf(frames);
    assert.equal(unknownZaps[1].status, 'error');
    assert.match(unknownZaps[1].result, /Unknown tool/);
});

test('api_key definition: catalog shows available (no leak), setup page refuses dead flows', async () => {
    await useHttpServer('api_key', {});
    const r = await fetch(`http://127.0.0.1:${serverPort}/api/lumo/v1/mcp/connections`, { headers: { 'x-pm-uid': UID } });
    const json = await r.json();
    const c = json.Connections.find((x) => x.Id === 'mcphttp');
    assert.equal(c.Status, 'available'); // definition exists, user has no connection yet
    assert.equal(c.ToolCount, null);
    assert.ok(!('url' in c));
    assert.equal(JSON.stringify(json).includes('127.0.0.1'), false, 'server URL must never appear in the catalog');
    const page = await fetch(`http://127.0.0.1:${serverPort}/mcp/setup/deadbeefdeadbeefdeadbeef`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Link expired/);
    // restore the stdio fixture for any later assertions
    await setServers([STDIO_FAKE]);
    await fakeHttp.close();
    fakeHttp = null;
});

test('connection dropped between advertisement and execution: call refused, no reconnect-and-execute', async () => {
    await setServers([{
        id: 'mcpdie', name: 'DieAfterList', transport: 'stdio',
        command: process.execPath, args: [path.join(ROOT, 'tests', 'fake-mcp-server.cjs')],
        env: { FAKE_TOKEN: 'super-secret-token-value', FAKE_DIE_AFTER_LIST: '1' },
        enabled: true, toolPermissions: {},
    }]);
    const res = await chat('stub-call-echo-slow');
    assert.equal(res.status, 200);
    const { frames } = await readSse(res);
    const zaps = zapOf(frames);
    assert.equal(zaps.length, 2);
    assert.equal(zaps[0].status, 'start');
    assert.match(zaps[0].name, /__echo$/); // it WAS advertised in round 1
    assert.equal(zaps[1].status, 'error');
    // the execution-time re-verification denies instead of letting callTool's
    // lazy reconnect respawn the dead server and execute the tool anyway
    assert.match(zaps[1].result, /could not be re-verified/i);
    assert.match(contentOf(frames), /FINAL:[\s\S]*could not be re-verified/i);
    await setServers([STDIO_FAKE]);
});

test('tool-name collisions across servers are namespaced, not dropped', async () => {
    // 'coll.me' and 'coll_me' sanitize to the same qualified prefix — the
    // catalog must hand the model two distinct, callable names
    await setServers(['coll.me', 'coll_me'].map((id) => ({
        id, name: 'Coll ' + id, transport: 'stdio',
        command: process.execPath, args: [path.join(ROOT, 'tests', 'fake-mcp-server.cjs')],
        env: { FAKE_TOKEN: 'super-secret-token-value' },
        enabled: true, toolPermissions: {},
    })));
    const res = await chat('stub-tool-names');
    const { frames } = await readSse(res);
    const names = contentOf(frames);
    assert.match(names, /coll_me__echo/);
    assert.match(names, /coll_me__echo_2/);
    await setServers([STDIO_FAKE]);
});

test('server id "lumo" is reserved (control-plane prefix) and never loaded', async () => {
    // a hand-edited config could carry id "lumo" — it must be skipped while
    // healthy servers and the control plane are unaffected
    await setServers([
        {
            id: 'lumo', name: 'Shadow', transport: 'stdio',
            command: process.execPath, args: [path.join(ROOT, 'tests', 'fake-mcp-server.cjs')],
            env: {}, enabled: true, toolPermissions: {},
        },
        {
            id: 'mcptest', name: 'Fake', transport: 'stdio',
            command: process.execPath, args: [path.join(ROOT, 'tests', 'fake-mcp-server.cjs')],
            env: { FAKE_TOKEN: 'super-secret-token-value' },
            enabled: true, toolPermissions: {},
        },
    ]);
    const res = await chat('stub-tool-names');
    const { frames } = await readSse(res);
    const names = contentOf(frames);
    assert.match(names, /mcptest__echo/);            // healthy server unaffected
    assert.doesNotMatch(names, /(^|:)lumo__/);       // no shadowing data tool
    // exactly the 4 reserved control tools + mcptest's 2 data tools survive
    assert.equal(stub.lastBody.tools.length, 6);
    assert.equal(stub.lastBody.tools.filter((t) => t.function.name.startsWith('lumo__')).length, 4);
    await setServers([STDIO_FAKE]);
});

test('revoked connection: usable when ready, denied at execution after a real control-plane revoke', async () => {
    // api_key http server that only accepts one exact credential value, so the
    // echo result also proves the right credential was injected
    const revokeHttp = createFakeMcpHttpServer({ name: 'revoke-test', expectedHeader: 'Bearer live-key-1' });
    await new Promise((r) => revokeHttp.server.listen(0, '127.0.0.1', r));
    const revokePort = revokeHttp.server.address().port;
    await setServers([{
        id: 'mcphttp2', name: 'RevokeHttp', transport: 'http',
        url: `http://127.0.0.1:${revokePort}/mcp`,
        enabled: true, trustedLocal: true, auth: 'api_key',
        authHeaderName: 'Authorization', authHeaderPrefix: 'Bearer',
        toolPermissions: {},
    }]);

    // 1. start the connection through the real control plane (confirm:true)
    let res = await chat(CTL_CONNECT);
    let { frames } = await readSse(res);
    let zaps = zapOf(frames);
    assert.equal(zaps[0].name, 'lumo__connection_connect');
    assert.equal(zaps[1].status, 'done');
    const start = JSON.parse(zaps[1].result);
    assert.equal(start.status, 'authorizing');
    assert.match(start.setupUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/setup\//);

    // 2. complete the real one-time setup flow over HTTP (never through chat)
    const form = await fetch(start.setupUrl);
    assert.match(await form.text(), /Enter the API key/);
    const post = await fetch(start.setupUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'api_key=' + encodeURIComponent('live-key-1'),
    });
    assert.match(await post.text(), /is connected/);

    // 3. ready: the tool is advertised and executes end-to-end
    res = await chat('stub-call-echo');
    ({ frames } = await readSse(res));
    zaps = zapOf(frames);
    assert.equal(zaps[1].status, 'done');
    assert.match(zaps[1].result, /echo: hi from stub/);

    // 4. revoke mid-flight: a request that ALREADY advertised the tool must
    //    still refuse it at execution time (stale calls can never run)
    const slow = chat('stub-call-echo-slow');
    await new Promise((r) => setTimeout(r, 150)); // slow stub emits at ~400ms; revoke lands in between
    const rev = await chat(CTL_DISCONNECT);
    const revZaps = zapOf((await readSse(rev)).frames);
    assert.equal(revZaps[1].status, 'done');
    assert.equal(JSON.parse(revZaps[1].result).status, 'revoked');
    ({ frames } = await readSse(await slow));
    zaps = zapOf(frames);
    assert.equal(zaps[0].status, 'start');            // it WAS advertised in round 1
    assert.equal(zaps[1].status, 'error');            // refused at execution
    assert.match(zaps[1].result, /refused|No authorized connection/);

    // 5. fresh request: the tool is no longer advertised at all
    res = await chat('stub-tool-names');
    ({ frames } = await readSse(res));
    assert.doesNotMatch(contentOf(frames), /mcphttp2__/);

    // 6. at rest: record revoked, credential wiped (read straight from the
    //    SQLite store — the at-rest format, not an API view)
    const rdb = new DatabaseSync(path.join(dataDir, 'lumo.db'));
    const rec = rdb.prepare('SELECT doc FROM mcp_connections').all()
        .map((row) => JSON.parse(row.doc))
        .find((c) => c.serverId === 'mcphttp2');
    rdb.close();
    assert.ok(rec, 'connection record found in the database');
    assert.equal(rec.status, 'revoked');
    assert.equal(rec.credential, null);
    await revokeHttp.close();
    await setServers([STDIO_FAKE]);
});

test('rate limit: MCP authorization pages are fixed-window limited per IP', async () => {
    // 60/min per remote IP shared by /mcp/* — hammer a dead setup link past the
    // budget. Runs LAST: it deliberately exhausts the bucket for this process.
    let saw429 = 0;
    for (let i = 0; i < 75; i++) {
        const r = await fetch(`http://127.0.0.1:${serverPort}/mcp/setup/${crypto.randomBytes(32).toString('hex')}`);
        if (r.status === 429) saw429++;
        else assert.equal(r.status, 200);
    }
    assert.ok(saw429 >= 5, `expected the fixed window to kick in (saw ${saw429} x 429)`);
});
