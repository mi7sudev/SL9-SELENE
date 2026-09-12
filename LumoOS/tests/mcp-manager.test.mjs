// mcp-manager.test.mjs — lifecycle/security tests for mcp-manager.cjs against
// the hand-rolled fake stdio MCP server (no network needed except loopback
// sockets for the SSRF-refusal case, which must be REFUSED).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { createMcpManager } = require(path.join(ROOT, 'mcp-manager.cjs'));

const stdioEntry = (over = {}) => ({
    id: 'srv-test',
    name: 'Test server',
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(ROOT, 'tests', 'fake-mcp-server.cjs')],
    env: { FAKE_TOKEN: 'super-secret-token-value' },
    enabled: true,
    ...over,
});

let manager;
beforeEach(() => {
    manager = createMcpManager({ log: () => {} });
});

test('connect discovers tools/resources/prompts and statusView exposes them (no env values)', async () => {
    await manager.connect(stdioEntry());
    const view = manager.statusView(stdioEntry());
    assert.equal(view.status, 'connected');
    assert.deepEqual(view.tools.map((t) => t.name), ['echo', 'fail']);
    assert.equal(view.toolCount, 2);
    assert.equal(view.resourceCount, 1);
    assert.equal(view.promptCount, 1);
    assert.equal(view.tools[0].enabled, true); // default permission is on
    assert.equal(JSON.stringify(view).includes('super-secret-token-value'), false);
    await manager.closeAll();
});

test('callTool echo returns the fake server result', async () => {
    await manager.connect(stdioEntry());
    const text = await manager.callTool(stdioEntry(), 'echo', { text: 'hello world' });
    assert.equal(text, 'echo: hello world');
    await manager.closeAll();
});

test('callTool on a failing tool throws a user-safe tool error', async () => {
    await manager.connect(stdioEntry());
    await assert.rejects(() => manager.callTool(stdioEntry(), 'fail', {}), /Tool "fail" failed/);
    await manager.closeAll();
});

test('lazy auto-connect: callTool connects on demand', async () => {
    const text = await manager.callTool(stdioEntry(), 'echo', { text: 'lazy' });
    assert.equal(text, 'echo: lazy');
    await manager.closeAll();
});

test('tool permission off is enforced (tool never executed)', async () => {
    const entry = stdioEntry({ toolPermissions: { echo: 'off' } });
    await manager.connect(entry);
    await assert.rejects(() => manager.callTool(entry, 'echo', { text: 'x' }), /disabled by the administrator/);
    const view = manager.statusView(entry);
    assert.equal(view.tools.find((t) => t.name === 'echo').enabled, false);
    await manager.closeAll();
});

test('disabled server cannot connect or execute', async () => {
    const entry = stdioEntry({ enabled: false });
    await assert.rejects(() => manager.callTool(entry, 'echo', { text: 'x' }), /disabled/);
    const view = manager.statusView(entry);
    assert.equal(view.status, 'disabled');
    await manager.closeAll();
});

test('disconnect kills the stdio child process', async () => {
    const entry = stdioEntry();
    await manager.connect(entry);
    const st = manager._states.get('srv-test');
    const transport = st.transport;
    const child = transport._process; // SDK StdioClientTransport stores the spawned child
    assert.ok(child && child.pid, 'child process should exist while connected');
    await manager.disconnect('srv-test');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(child.killed || child.exitCode !== null, true);
    assert.equal(manager.statusView(entry).status, 'disconnected');
});

test('crash of the server process flips status to error', async () => {
    const entry = stdioEntry();
    await manager.connect(entry);
    const st = manager._states.get('srv-test');
    st.transport._process.kill(); // simulate crash
    await new Promise((r) => setTimeout(r, 500));
    const view = manager.statusView(entry);
    assert.equal(view.status, 'error');
    assert.equal(view.toolCount, 0);
    await manager.closeAll();
});

test('connect failure backoff: force=false retries fast-fail, force=true retries for real', async () => {
    const bad = stdioEntry({ id: 'srv-bad', command: process.execPath, args: ['-e', 'process.exit(1)'] });
    await assert.rejects(() => manager.connect(bad, { force: true }));
    const t0 = Date.now();
    await assert.rejects(() => manager.connect(bad, { force: false }), /failed to connect recently/);
    assert.ok(Date.now() - t0 < 500, 'backoff should fail fast');
    // after the backoff window the non-forced connect tries again (fails again, slower path)
    const st = manager._states.get('srv-bad');
    st.lastAttempt = Date.now() - 61000;
    await assert.rejects(() => manager.connect(bad, { force: false }));
    await manager.closeAll();
});

test('redaction scrubs registered env values from any string', async () => {
    const entry = stdioEntry();
    manager.registerSecrets(entry);
    const out = manager.redact('connect failed with token super-secret-token-value inside');
    assert.equal(out.includes('super-secret-token-value'), false);
    assert.match(out, /••••••••/);
});

test('SSRF guard: loopback endpoint refused unless trustedLocal', async () => {
    // local listener exists purely so the hostname resolves
    const server = http.createServer(() => {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const { assertUrlAllowed } = require(path.join(ROOT, 'mcp-manager.cjs'));
    await assert.rejects(() => assertUrlAllowed(url, false), /private\/loopback/);
    await assertUrlAllowed(url, true); // escape hatch works
    server.close();
});

test('SSRF guard: DNS resolving to a private address is refused', async () => {
    const { assertUrlAllowed } = require(path.join(ROOT, 'mcp-manager.cjs'));
    await assert.rejects(() => assertUrlAllowed('http://localhost:9999/mcp', false), /private\/loopback/);
});

test('closeAll disconnects everything (used on server shutdown)', async () => {
    await manager.connect(stdioEntry({ id: 'a', name: 'A' }));
    await manager.connect(stdioEntry({ id: 'b', name: 'B' }));
    await manager.closeAll();
    assert.equal(manager.statusView({ id: 'a' }).status, 'disconnected');
    assert.equal(manager.statusView({ id: 'b' }).status, 'disconnected');
});

test('discovery stamps lastDiscoveredAt and annotations classify tools', async () => {
    const st = await manager.connect(stdioEntry(), { force: true });
    assert.equal(st.status, 'connected');
    assert.equal(typeof st.lastDiscoveredAt, 'number');
    const view = manager.statusView(stdioEntry());
    assert.equal(view.lastDiscoveredAt, st.lastDiscoveredAt);
    const byName = Object.fromEntries(view.tools.map((t) => [t.name, t]));
    assert.equal(byName.echo.classification, 'read-only');
    assert.equal(byName.echo.annotations.readOnlyHint, true);
    assert.equal(byName.fail.classification, 'unclassified');
    await manager.closeAll(); // kill the stdio child so the test process can exit
});

test('concurrent connect() calls share one connecting attempt', async () => {
    const entry = stdioEntry();
    const [a, b] = await Promise.all([manager.connect(entry), manager.connect(entry)]);
    assert.equal(a, b); // identical state object — a single connect attempt
    assert.equal(a.status, 'connected');
    assert.equal(manager._states.get('srv-test'), a);
    await manager.closeAll();
});

test('tools/list failure: transport connects but discovery never stamps', async () => {
    const { createFakeMcpHttpServer } = require(path.join(ROOT, 'tests', 'fake-mcp-http-server.cjs'));
    const fake = createFakeMcpHttpServer({ name: 'broken-list', failToolsList: true });
    await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
    try {
        const entry = {
            id: 'srv-broken', name: 'Broken', transport: 'http',
            url: `http://127.0.0.1:${fake.server.address().port}/mcp`,
            enabled: true, trustedLocal: true, auth: 'none', toolPermissions: {},
        };
        const st = await manager.connect(entry, { force: true });
        assert.equal(st.status, 'connected'); // the client itself connected
        assert.equal(st.lastDiscoveredAt, null); // but tools/list never answered
        const view = manager.statusView(entry);
        assert.equal(view.status, 'connected');
        assert.equal(view.toolCount, 0);
    } finally {
        await manager.closeAll();
        await fake.close();
    }
});

test('per-connection transports: one live state per connection id, credentials kept apart', async () => {
    const { createFakeMcpHttpServer } = require(path.join(ROOT, 'tests', 'fake-mcp-http-server.cjs'));
    const fake = createFakeMcpHttpServer({ name: 'per-conn' });
    await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
    const entry = {
        id: 'srv-perconn', name: 'PerConn', transport: 'http',
        url: `http://127.0.0.1:${fake.server.address().port}/mcp`,
        enabled: true, trustedLocal: true, auth: 'api_key',
        authHeaderName: 'Authorization', authHeaderPrefix: 'Bearer', toolPermissions: {},
    };
    const c1 = { id: 'conn-1', credential: 'key-one' };
    const c2 = { id: 'conn-2', credential: 'key-two' };
    try {
        await manager.connect(entry, { connection: c1 });
        await manager.connect(entry, { connection: c2 });
        assert.ok(manager._states.has('srv-perconn::conn-1'));
        assert.ok(manager._states.has('srv-perconn::conn-2'));
        await manager.callTool(entry, 'echo', { text: 'one' }, { connection: c1 });
        assert.equal(fake.state.lastAuthHeader, 'Bearer key-one');
        await manager.callTool(entry, 'echo', { text: 'two' }, { connection: c2 });
        assert.equal(fake.state.lastAuthHeader, 'Bearer key-two');
        // killing one connection's transport leaves the other one usable
        await manager.disconnect('srv-perconn::conn-1', { silent: true });
        await manager.callTool(entry, 'echo', { text: 'again' }, { connection: c2 });
        assert.equal(fake.state.lastAuthHeader, 'Bearer key-two');
    } finally {
        await manager.closeAll();
        await fake.close();
    }
});
