// tests/rest-connections.test.cjs — runtime integration test for DIRECT REST
// API connections (the lumo__connection_create / api_request slice).
//
// Run: node tests/rest-connections.test.cjs
//
// Boots:
//   1. a stub REST API (Plane-like: requires X-API-Key, serves workspaces)
//   2. a stub OpenAI-compatible provider (scripted tool-call round trip)
//   3. a full lumo-server (LUMO_TEST=1, throwaway data dir)
// then exercises the whole feature over HTTP:
//   - admin creates a rest server def via the admin API
//   - the user connects with their key via the in-app connect endpoint
//     (wrong key → needs_reauth, right key → ready)
//   - a streaming chat round-trips a real api_request tool call through the
//     MCP loop and renders the tool result
// plus unit coverage of callRestTool (method allowlist, header injection,
// extraHeaders cannot smuggle the credential, secret never in output).

'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'LumoOS');
const PORT = 18321;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-api-key-abcdef123456';

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ok - ${name}`); }
    else { failed++; console.error(`  FAIL - ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function bodyOf(resp) {
    const t = await resp.text();
    try { return JSON.parse(t); } catch { return t; }
}

// ── stub REST API (the "Plane.so") ───────────────────────────────────────────
const restState = { lastAuth: null, lastUrl: '', lastMethod: '' };
const restStub = http.createServer((req, res) => {
    restState.lastAuth = req.headers['x-api-key'] ?? null;
    restState.lastUrl = req.url;
    restState.lastMethod = req.method;
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const keyOk = req.headers['x-api-key'] === SECRET;
        const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.url === '/api/v1/users/me/' || req.url === '/api/v1/users/me') {
            return keyOk ? json(200, { id: 'user-1', name: 'tester' }) : json(401, { error: 'Invalid token' });
        }
        if (req.url.startsWith('/api/v1/workspaces/')) {
            if (req.method === 'POST' && keyOk) return json(201, { id: 'ws-2', name: 'new-workspace' });
            return keyOk ? json(200, { results: [{ id: 'ws-1', name: 'ws1' }], next_cursor: null }) : json(401, { error: 'Invalid token' });
        }
        if (req.url === '/boom') return json(500, { error: 'upstream exploded' });
        json(404, { error: 'not found' });
    });
});

// ── stub OpenAI-compatible provider (scripted agent loop) ────────────────────
let providerRound = 0;
const providerStub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        providerRound++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        if (providerRound === 1) {
            frame({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'plane__api_request', arguments: JSON.stringify({ method: 'GET', path: '/api/v1/workspaces/', query: { limit: 5 } }) } }] }, finish_reason: null }] });
            frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else {
            frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Your workspace is ws1 (verified via the Plane API).' }, finish_reason: null }] });
            frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        }
        res.write('data: [DONE]\n\n');
        res.end();
    });
});

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ── unit tests: callRestTool against the stub ────────────────────────────────
async function unitTests(restPort) {
    const { createMcpManager } = require(path.join(ROOT, 'mcp-manager.cjs'));
    const logs = [];
    const mgr = createMcpManager({ log: (...a) => logs.push(a.join(' ')) });
    const entry = {
        id: 'plane', name: 'Plane.so', transport: 'rest', auth: 'api_key',
        url: `http://127.0.0.1:${restPort}`,
        allowedMethods: ['GET'],
        authHeaderName: 'X-API-Key', authHeaderPrefix: '',
        healthPath: '/api/v1/users/me/',
        trustedLocal: true, // 127.0.0.1 is private by design in tests
    };
    const conn = { id: 'conn-1', credential: SECRET };

    const okText = await mgr.callRestTool(entry, { method: 'GET', path: '/api/v1/workspaces/', query: { limit: 5 } }, { connection: conn });
    check('rest GET executes', okText.includes('HTTP 200') && okText.includes('ws1'), okText.slice(0, 120));
    check('rest GET injects credential', restState.lastAuth === SECRET);
    check('rest GET forwards query', restState.lastUrl.includes('limit=5'), restState.lastUrl);
    check('secret never appears in result', !okText.includes(SECRET));

    await assert.rejects(
        () => mgr.callRestTool(entry, { method: 'POST', path: '/api/v1/workspaces/' }, { connection: conn }),
        /not allowed/,
    );
    check('method outside allowlist rejected', restState.lastMethod === 'GET');

    await mgr.callRestTool(entry, { method: 'GET', path: '/api/v1/workspaces/', extraHeaders: { 'X-API-Key': 'EVIL' } }, { connection: conn });
    check('extraHeaders cannot override credential header', restState.lastAuth === SECRET);

    await assert.rejects(
        () => mgr.callRestTool(entry, { method: 'GET', path: '/boom' }, { connection: conn }),
        (e) => e.retryable === true && /500/.test(e.message),
    );
    check('5xx surfaces as retryable tool error', true);

    const hc = await mgr.restHealthCheck(entry, SECRET);
    check('health check ok with right key', hc.ok === true && hc.status === 200);
    const hcBad = await mgr.restHealthCheck(entry, 'wrong-key');
    check('health check flags wrong key as auth rejected', hcBad.ok === false && hcBad.authRejected === true);
}

// ── E2E: full server + chat loop ─────────────────────────────────────────────
async function e2e(restPort, providerPort) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumo-rest-test-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'lumo-server.cjs')], {
        env: { ...process.env, LUMO_TEST: '1', LUMO_PORT: String(PORT), LUMO_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => { /* keep test output clean */ });
    const up = async () => {
        for (let i = 0; i < 60; i++) {
            try {
                const r = await fetch(`${BASE}/`, { redirect: 'manual' });
                if (r.status === 302) return true;
            } catch { /* not up yet */ }
            await sleep(300);
        }
        return false;
    };
    try {
        check('server boots', await up());

        // first signup becomes admin
        const su = await fetch(`${BASE}/api/local/auth/signup`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'test-pass-123' }),
        });
        const setCookie = su.headers.get('set-cookie') || '';
        const cookie = setCookie.split(';')[0];
        check('admin signup works', su.status === 200 && cookie.startsWith('lumo_uid='), su.status);

        // create the rest server def via the admin API (same shape the
        // lumo__connection_create tool saves through createRestServerDef)
        const put = await fetch(`${BASE}/api/lumo/v1/admin/mcp/servers`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({
                Server: {
                    id: 'plane', name: 'Plane.so', transport: 'rest', auth: 'api_key',
                    url: `http://127.0.0.1:${restPort}`,
                    allowedMethods: ['GET', 'POST'],
                    authHeaderName: 'X-API-Key', authHeaderPrefix: '',
                    healthPath: '/api/v1/users/me/',
                    trustedLocal: true, // stub runs on loopback; production defs guard SSRF
                    description: 'Plane project management API.',
                },
            }),
        });
        const putBody = await bodyOf(put);
        check('admin creates rest server def', put.status === 200 && putBody.Server && putBody.Server.transport === 'rest', putBody);

        // wrong key → needs_reauth (real authenticated health check)
        const bad = await bodyOf(await fetch(`${BASE}/api/lumo/v1/mcp/connections/connect`, {
            method: 'POST', headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ serverId: 'plane', apiKey: 'wrong-key' }),
        }));
        check('wrong key → needs_reauth', bad.status === 'needs_reauth', bad);

        // right key → ready
        const good = await bodyOf(await fetch(`${BASE}/api/lumo/v1/mcp/connections/connect`, {
            method: 'POST', headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ serverId: 'plane', apiKey: SECRET }),
        }));
        check('right key → ready', good.status === 'ready', good);

        // user-facing catalog shows the governed api_request tool
        const list = await bodyOf(await fetch(`${BASE}/api/lumo/v1/mcp/connections`, { headers: { cookie } }));
        const plane = Array.isArray(list.Connections) ? list.Connections.find((c) => c.Id === 'plane') : null;
        check('catalog shows rest connection ready', plane && plane.Status === 'ready', list);
        check('catalog shows api_request tool', plane && Array.isArray(plane.Tools) && plane.Tools.includes('api_request'), plane && plane.Tools);

        // non-admin cannot create rest defs via the admin API
        const su2 = await fetch(`${BASE}/api/local/auth/signup`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'peon', password: 'test-pass-123' }),
        });
        const cookie2 = (su2.headers.get('set-cookie') || '').split(';')[0];
        const denied = await fetch(`${BASE}/api/lumo/v1/admin/mcp/servers`, {
            method: 'PUT', headers: { 'content-type': 'application/json', cookie: cookie2 },
            body: JSON.stringify({ Server: { name: 'x', transport: 'rest', url: 'http://example.com', auth: 'api_key' } }),
        });
        check('non-admin def creation denied', denied.status === 403, denied.status);

        // full chat round trip: stub provider requests plane__api_request, the
        // server executes it against the stub REST API with the stored key
        const cfg = await fetch(`${BASE}/api/lumo/v1/admin/config`, {
            method: 'PUT', headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ providers: [{ id: 'stub', name: 'stub', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'provider-key', models: ['stub-model'] }], defaultModel: 'stub-model' }),
        });
        check('provider configured', cfg.status === 200, cfg.status);

        const chat = await fetch(`${BASE}/byok-api/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ model: 'stub-model', stream: true, messages: [{ role: 'user', content: 'List my Plane workspaces' }] }),
        });
        check('chat stream starts', chat.status === 200, chat.status);
        const text = await chat.text();
        const zapDone = text.split('\n').filter((l) => l.startsWith('data: ') && l.includes('zap_tool'))
            .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
            .filter(Boolean)
            .map((f) => f.choices && f.choices[0] && f.choices[0].delta && f.choices[0].delta.zap_tool)
            .filter(Boolean);
        const doneFrame = zapDone.find((z) => z.status === 'done');
        check('api_request tool executed in chat loop', Boolean(doneFrame), zapDone.map((z) => z.status));
        check('tool result contains REST data', doneFrame && doneFrame.result && doneFrame.result.includes('ws1'), doneFrame && doneFrame.result && doneFrame.result.slice(0, 120));
        check('secret never appears in chat stream', !text.includes(SECRET));
        check('agent saw verified answer', text.includes('verified via the Plane API'));
    } finally {
        child.kill('SIGTERM');
        await sleep(300);
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows may hold the db briefly */ }
    }
}

(async () => {
    const restPort = await listen(restStub);
    const providerPort = await listen(providerStub);
    try {
        console.log('unit: callRestTool / restHealthCheck');
        await unitTests(restPort);
        console.log('e2e: full server + chat loop');
        await e2e(restPort, providerPort);
    } catch (e) {
        failed++;
        console.error('FATAL:', e && e.stack || e);
    } finally {
        restStub.close();
        providerStub.close();
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
