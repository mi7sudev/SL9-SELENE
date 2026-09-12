// tests/durable-runs.test.cjs — runtime integration test for durable agent
// runs, the tool audit trail, and REST write-approval gates (Agent OS phase 2).
//
// Run: node tests/durable-runs.test.cjs
//
// Boots a stub REST API + a scripted stub OpenAI provider + a full lumo-server
// (LUMO_TEST=1, throwaway data dir), then drives two chats:
//   chat 1: POST write on a confirmWrites connection → approval_requested →
//           user confirms (confirm:true) → 201 executed
//   chat 2: POST write on a confirmWrites:false connection → executes at once
// then asserts the run records, the audit event trail (tool_start /
// approval_requested / approval_granted / tool_done), ownership scoping, and
// that the API key never appears in any response.

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'LumoOS');
const PORT = 18331;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-api-key-abcdef123456';

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ok - ${name}`); }
    else { failed++; console.error(`  FAIL - ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function bodyOf(resp) { const t = await resp.text(); try { return JSON.parse(t); } catch { return t; } }

// ── stub REST API ─────────────────────────────────────────────────────────────
const restState = { lastAuth: null, lastMethod: '', lastBody: null };
const restStub = http.createServer((req, res) => {
    restState.lastAuth = req.headers['x-api-key'] ?? null;
    restState.lastMethod = req.method;
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        restState.lastBody = raw || null;
        const keyOk = req.headers['x-api-key'] === SECRET;
        const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.url === '/api/v1/users/me/') return keyOk ? json(200, { id: 'user-1' }) : json(401, { error: 'Invalid token' });
        if (req.url.startsWith('/api/v1/workspaces/')) {
            if (req.method === 'POST') return keyOk ? json(201, { id: 'ws-2', name: 'new-workspace' }) : json(401, { error: 'Invalid token' });
            return keyOk ? json(200, { results: [{ id: 'ws-1', name: 'ws1' }] }) : json(401, { error: 'Invalid token' });
        }
        json(404, { error: 'not found' });
    });
});

// ── scripted stub provider: one scripted round per provider call ─────────────
let providerCall = 0;
function toolFrame(name, args) {
    return { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${providerCall}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] };
}
const providerStub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        providerCall++;
        const n = providerCall;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const finish = (reason) => { frame({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }); res.write('data: [DONE]\n\n'); res.end(); };
        if (n === 1) { frame(toolFrame('plane__api_request', { method: 'POST', path: '/api/v1/workspaces/', body: { name: 'new-workspace' } })); return finish('tool_calls'); }
        if (n === 2) { frame(toolFrame('plane__api_request', { method: 'POST', path: '/api/v1/workspaces/', body: { name: 'new-workspace' }, confirm: true })); return finish('tool_calls'); }
        if (n === 3) { frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Workspace created.' }, finish_reason: null }] }); return finish('stop'); }
        if (n === 4) { frame(toolFrame('fast__api_request', { method: 'POST', path: '/api/v1/workspaces/', body: { name: 'instant' } })); return finish('tool_calls'); }
        frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Instant write done.' }, finish_reason: null }] });
        finish('stop');
    });
});

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function chat(cookie, model) {
    return fetch(`${BASE}/byok-api/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'Create a workspace' }] }),
    });
}
function zapFrames(text) {
    return text.split('\n').filter((l) => l.startsWith('data: ') && l.includes('zap_tool'))
        .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
        .filter(Boolean)
        .map((f) => f.choices && f.choices[0] && f.choices[0].delta && f.choices[0].delta.zap_tool)
        .filter(Boolean);
}

(async () => {
    const restPort = await listen(restStub);
    const providerPort = await listen(providerStub);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumo-runs-test-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'lumo-server.cjs')], {
        env: { ...process.env, LUMO_TEST: '1', LUMO_PORT: String(PORT), LUMO_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => { /* keep output clean */ });
    try {
        let up = false;
        for (let i = 0; i < 60 && !up; i++) {
            try { up = (await fetch(`${BASE}/`, { redirect: 'manual' })).status === 302; } catch { await sleep(300); }
        }
        check('server boots', up);

        const su = await fetch(`${BASE}/api/local/auth/signup`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'test-pass-123' }),
        });
        const cookie = (su.headers.get('set-cookie') || '').split(';')[0];

        // two rest defs: default (confirmWrites true) + fast (confirmWrites false)
        for (const def of [
            { id: 'plane', name: 'Plane.so', confirmWrites: true },
            { id: 'fast', name: 'Fast.so', confirmWrites: false },
        ]) {
            const put = await fetch(`${BASE}/api/lumo/v1/admin/mcp/servers`, {
                method: 'PUT', headers: { 'content-type': 'application/json', cookie },
                body: JSON.stringify({
                    Server: {
                        id: def.id, name: def.name, transport: 'rest', auth: 'api_key',
                        url: `http://127.0.0.1:${restPort}`,
                        allowedMethods: ['GET', 'POST'],
                        authHeaderName: 'X-API-Key', authHeaderPrefix: '',
                        healthPath: '/api/v1/users/me/',
                        confirmWrites: def.confirmWrites,
                        trustedLocal: true,
                    },
                }),
            });
            check(`rest def ${def.id} created (confirmWrites=${def.confirmWrites})`, put.status === 200);
        }
        for (const id of ['plane', 'fast']) {
            const c = await bodyOf(await fetch(`${BASE}/api/lumo/v1/mcp/connections/connect`, {
                method: 'POST', headers: { 'content-type': 'application/json', cookie },
                body: JSON.stringify({ serverId: id, apiKey: SECRET }),
            }));
            check(`connection ${id} ready`, c.status === 'ready', c);
        }
        await fetch(`${BASE}/api/lumo/v1/admin/config`, {
            method: 'PUT', headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ providers: [{ id: 'stub', name: 'stub', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'provider-key', models: ['stub-model'] }], defaultModel: 'stub-model' }),
        });

        // ── chat 1: gated write → approval → confirmed execution ──
        const c1 = await chat(cookie, 'stub-model');
        const t1 = await c1.text();
        const z1 = zapFrames(t1);
        const gateFrame = z1.find((z) => z.status === 'done' && z.result && z.result.includes('needsConfirmation'));
        check('write blocked pending approval', Boolean(gateFrame), z1.map((z) => z.status));
        const confirmFrame = z1.find((z) => z.status === 'done' && z.result && z.result.includes('HTTP 201'));
        check('confirmed write executed (201)', Boolean(confirmFrame), z1.map((z) => (z.result || '').slice(0, 60)));
        check('secret absent from chat stream', !t1.includes(SECRET));

        // ── chat 2: confirmWrites:false executes immediately ──
        const c2 = await chat(cookie, 'stub-model');
        const t2 = await c2.text();
        const z2 = zapFrames(t2);
        check('confirmWrites:false write executes at once', z2.some((z) => z.status === 'done' && z.result && z.result.includes('HTTP 201')), z2.map((z) => (z.result || '').slice(0, 60)));

        // ── run records + audit trail ──
        const list = await bodyOf(await fetch(`${BASE}/api/lumo/v1/runs`, { headers: { cookie } }));
        check('two runs recorded', Array.isArray(list.Runs) && list.Runs.length === 2, list);
        check('runs stored without message content', !JSON.stringify(list).includes('Create a workspace'));
        check('run status completed', list.Runs && list.Runs.every((r) => r.status === 'completed'), list.Runs && list.Runs.map((r) => r.status));

        // newest run is chat 2 (confirmWrites:false — no approval events);
        // the gated approval trail lives in the oldest run (chat 1)
        const runId = list.Runs[list.Runs.length - 1].id;
        const detail = await bodyOf(await fetch(`${BASE}/api/lumo/v1/runs/${runId}`, { headers: { cookie } }));
        const types = (detail.Events || []).map((e) => e.type);
        check('run detail has event trail', Array.isArray(detail.Events) && detail.Events.length > 0, detail);
        check('approval_requested recorded', types.includes('approval_requested'), types);
        check('approval_granted recorded', types.includes('approval_granted'), types);
        check('tool_start + tool_done recorded', types.includes('tool_start') && types.includes('tool_done'), types);
        check('events carry no secret', !JSON.stringify(detail).includes(SECRET));

        // ownership: another account sees nothing
        const su2 = await fetch(`${BASE}/api/local/auth/signup`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'peon', password: 'test-pass-123' }),
        });
        const cookie2 = (su2.headers.get('set-cookie') || '').split(';')[0];
        const foreign = await fetch(`${BASE}/api/lumo/v1/runs/${runId}`, { headers: { cookie: cookie2 } });
        check('run detail forbidden for other users', foreign.status === 403, foreign.status);
        const ownList = await bodyOf(await fetch(`${BASE}/api/lumo/v1/runs`, { headers: { cookie: cookie2 } }));
        check('run list scoped to owner', Array.isArray(ownList.Runs) && ownList.Runs.length === 0, ownList);

        // admin sees all runs
        const all = await bodyOf(await fetch(`${BASE}/api/lumo/v1/admin/runs`, { headers: { cookie } }));
        check('admin run list works', Array.isArray(all.Runs) && all.Runs.length === 2, all);
    } catch (e) {
        failed++;
        console.error('FATAL:', e && e.stack || e);
    } finally {
        child.kill('SIGTERM');
        await sleep(300);
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows may hold the db briefly */ }
        restStub.close();
        providerStub.close();
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
