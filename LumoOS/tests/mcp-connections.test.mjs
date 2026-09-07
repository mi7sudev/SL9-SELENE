// mcp-connections.test.mjs — connection lifecycle ("control plane") tests for
// mcp-connections.cjs against the real mcp-manager + fake MCP-over-HTTP
// server + stub OAuth provider. Covers: state machine honesty (ready only
// after real connect+discover), credential encryption at rest + redaction,
// one-time/expiring flows (setup + OAuth state incl. replay), PKCE, per-user
// ownership/tenant scope, write-capable classification, and the agent
// control-plane tool surface.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const { createMcpManager } = require(path.join(ROOT, 'mcp-manager.cjs'));
const { createConnectionService } = require(path.join(ROOT, 'mcp-connections.cjs'));
const { createFakeMcpHttpServer } = require(path.join(ROOT, 'tests', 'fake-mcp-http-server.cjs'));
const { createStubOauthProvider } = require(path.join(ROOT, 'tests', 'stub-oauth-provider.cjs'));

const { openStore } = require(path.join(ROOT, 'store.cjs'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumo-conn-test-'));

const logLines = [];
const mcpManager = createMcpManager({ log: (...a) => logLines.push(a.map(String).join(' ')) });

let httpFake, oauthStub, httpPort, oauthPort;
const defs = [];
let service;
let db, store;

const defFor = (id) => defs.find((d) => d.id === id) || null;
const flushLogs = () => { logLines.length = 0; };

before(async () => {
    httpFake = createFakeMcpHttpServer({ name: 'fake-http-mcp' });
    await new Promise((r) => httpFake.server.listen(0, '127.0.0.1', r));
    httpPort = httpFake.server.address().port;

    oauthStub = createStubOauthProvider();
    await new Promise((r) => oauthStub.server.listen(0, '127.0.0.1', r));
    oauthPort = oauthStub.server.address().port;

    defs.push({
        id: 'srv-shared', name: 'Shared Http', transport: 'http',
        url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, trustedLocal: true, auth: 'none',
        toolPermissions: {},
    });
    defs.push({
        id: 'srv-key', name: 'Key Server', transport: 'http',
        url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, trustedLocal: true, auth: 'api_key',
        authHeaderName: 'Authorization', authHeaderPrefix: 'Bearer',
        toolPermissions: {},
    });
    defs.push({
        id: 'srv-oauth', name: 'OAuth Server', transport: 'http',
        url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, trustedLocal: true, auth: 'oauth',
        authHeaderName: 'Authorization', authHeaderPrefix: 'Bearer',
        oauth: {
            authorizeUrl: `http://127.0.0.1:${oauthPort}/authorize`,
            tokenUrl: `http://127.0.0.1:${oauthPort}/token`,
            clientId: 'client-123',
            clientSecret: '',
            scopes: 'read write',
            usePkce: true,
        },
        toolPermissions: {},
    });

    // the real SQLite store on a temp dir — same semantics lumo-server.cjs uses
    ({ db, store } = openStore(dataDir, { log: () => {} }));
    service = createConnectionService({
        dataDir,
        log: (...a) => logLines.push(a.map(String).join(' ')),
        nowIso: () => new Date().toISOString(),
        store,
        getServerDef: defFor,
        mcpManager,
    });
    service.setDefsProvider(() => defs);
});

after(async () => {
    await mcpManager.closeAll();
    await httpFake.close();
    await oauthStub.close();
    try { db.close(); } catch { /* already closed */ }
});

// the records exactly as serialized at rest (one JSON doc per row)
const connectionDocs = () => db.prepare('SELECT doc FROM mcp_connections').all().map((r) => JSON.parse(r.doc));

const httpGetLocation = (url) => new Promise((resolve, reject) => {
    http.get(url, (res) => {
        res.resume();
        resolve({ status: res.statusCode, location: res.headers.location });
    }).on('error', reject);
});

test('credential encryption round-trips and detects tampering', () => {
    const enc = service._encryptCredential('sk-super-secret-42');
    assert.match(enc, /^v1:/);
    assert.equal(service._decryptCredential(enc), 'sk-super-secret-42');
    assert.equal(service._decryptCredential(enc.slice(0, -4) + 'AAAA'), null);
});

test('unknown and disabled definitions are refused honestly', async () => {
    const unknown = await service.startConnect({ serverId: 'nope', uid: 'u1', confirm: true, baseUrl: 'http://x' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'unknown_connection');

    defs.push({ id: 'srv-off', name: 'Off', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: false, trustedLocal: true, auth: 'api_key', toolPermissions: {} });
    try {
        const off = await service.startConnect({ serverId: 'srv-off', uid: 'u1', confirm: true, baseUrl: 'http://x' });
        assert.equal(off.ok, false);
        assert.equal(off.error, 'disabled');
    } finally {
        defs.splice(defs.findIndex((d) => d.id === 'srv-off'), 1);
    }
});

test('shared (auth none) servers need no personal connection', async () => {
    const r = await service.startConnect({ serverId: 'srv-shared', uid: 'u1', confirm: false, baseUrl: 'http://x' });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'ready');
    assert.match(r.message, /instance-shared/i);
});

test('api_key flow: confirm gate, wrong key -> needs_reauth, right key -> ready, secrets never at rest', async () => {
    flushLogs();
    // confirm gate (release blocker: no side effect without explicit confirm)
    const gate = await service.startConnect({ serverId: 'srv-key', uid: 'uA', confirm: false, baseUrl: 'http://x' });
    assert.equal(gate.needsConfirmation, true);
    assert.match(gate.message, /confirm/i);
    assert.equal(service.loadRecords().find((c) => c.serverId === 'srv-key' && c.ownerUid === 'uA'), undefined);

    // start: authorizing + one-time setup URL
    const start = await service.startConnect({ serverId: 'srv-key', uid: 'uA', confirm: true, baseUrl: 'http://x' });
    assert.equal(start.status, 'authorizing');
    assert.match(start.setupUrl, /\/mcp\/setup\/[a-f0-9]+/);
    const flowId = start.setupUrl.split('/').pop();
    const rec1 = service.loadRecords().find((c) => c.serverId === 'srv-key' && c.ownerUid === 'uA');
    assert.equal(rec1.status, 'authorizing');

    // wrong key -> the fake server 401s -> needs_reauth (honest failure)
    httpFake.expectedHeader = 'Bearer right-key-123';
    const bad = await service.completeSetup({ flowId, keyValue: 'wrong-key' });
    assert.equal(bad.ok, false);
    assert.equal(bad.page, 'failed');
    assert.equal(bad.status, 'needs_reauth');
    assert.equal(bad.error.code, 'auth_rejected');

    // the consumed flow is one-time: replaying it fails
    const replay = await service.completeSetup({ flowId, keyValue: 'right-key-123' });
    assert.equal(replay.page, 'error');

    // retry via connect: same record, new flow, right key -> ready
    const retry = await service.startConnect({ serverId: 'srv-key', uid: 'uA', confirm: true, baseUrl: 'http://x' });
    assert.equal(retry.status, 'authorizing');
    const flowId2 = retry.setupUrl.split('/').pop();
    const rec2 = service.loadRecords().find((c) => c.id === rec1.id);
    assert.equal(rec2.status, 'authorizing');
    const good = await service.completeSetup({ flowId: flowId2, keyValue: 'right-key-123' });
    assert.equal(good.ok, true);
    assert.equal(good.page, 'ready');

    // flow consumed
    assert.equal(service.getSetupFlow(flowId2), null);

    // credential encrypted at rest — plaintext never touches the store
    const atRest = JSON.stringify(connectionDocs());
    assert.equal(atRest.includes('right-key-123'), false);
    assert.match(atRest, /"credential":"v1:/);

    // effective credential + real header-injection proof
    const cred = service.findReadyCredential('srv-key', 'uA');
    assert.equal(cred.value, 'right-key-123');
    const echoResult = await mcpManager.callTool(defFor('srv-key'), 'echo', { text: 'hi' }, { connection: { id: cred.id, credential: cred.value } });
    assert.match(echoResult, /echo: hi/);
    assert.equal(httpFake.state.lastAuthHeader, 'Bearer right-key-123');

    // status reports ready with classified tools
    const status = service.connectionStatusFor(defFor('srv-key'), 'uA');
    assert.equal(status.status, 'ready');
    const classes = Object.fromEntries(status.tools.map((t) => [t.name, t.classification]));
    assert.equal(classes.echo, 'read-only');
    assert.equal(classes.delete_item, 'write');
    assert.ok(status.lastDiscoveredAt);

    // logs never carry the key (redaction invariant)
    assert.equal(logLines.join('\n').includes('right-key-123'), false);
    flushLogs();
    httpFake.expectedHeader = null; // later tests accept any/no auth header
});

test('ownership: other users have no access; tenant scope covers everyone; own wins over tenant', async () => {
    // uA holds the ready srv-key connection from the previous test
    assert.equal(service.findReadyCredential('srv-key', 'uB'), null);
    assert.equal(service.connectionStatusFor(defFor('srv-key'), 'uB').status, 'available');

    // a tenant-scoped record (admin-created) covers every user
    const mkRec = (id, ownerUid, value) => ({
        id, serverId: 'srv-oauth', ownerUid, status: 'ready',
        credential: service._encryptCredential(JSON.stringify({ type: 'api_key', value })),
        error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        lastValidatedAt: new Date().toISOString(), lastDiscoveredAt: null,
    });
    const list = service.loadRecords();
    list.push(mkRec('conn-tenant01', 'tenant', 'tenant-cred-777'));
    for (const rec of list) store.upsertConnectionRecord(rec);
    assert.equal(service.findReadyCredential('srv-oauth', 'someoneElse').value, 'tenant-cred-777');
    // startConnect for a user already covered by the tenant record is honestly idempotent
    const covered = await service.startConnect({ serverId: 'srv-oauth', uid: 'newUser', confirm: true, baseUrl: 'http://x' });
    assert.equal(covered.status, 'ready');

    // the user's own record wins over the tenant one
    const recs = service.loadRecords();
    recs.push(mkRec('conn-own01', 'uA', 'own-cred-555'));
    for (const rec of recs) store.upsertConnectionRecord(rec);
    assert.equal(service.findReadyCredential('srv-oauth', 'uA').value, 'own-cred-555');
    assert.equal(service.findReadyCredential('srv-oauth', 'otherUser').value, 'tenant-cred-777');
    assert.equal(service.findReadyCredential('srv-key', 'uA').value, 'right-key-123');

    // clean the crafted records so later tests see a fresh allowlist state
    store.deleteConnectionRecord('conn-tenant01');
    store.deleteConnectionRecord('conn-own01');
});

test('oauth flow: PKCE + state one-time + replay refusal + honest ready', async () => {
    flushLogs();
    const start = await service.startConnect({ serverId: 'srv-oauth', uid: 'uB', confirm: true, baseUrl: 'http://x' });
    assert.equal(start.status, 'authorizing');
    assert.match(start.authorizeUrl, /response_type=code/);
    assert.match(start.authorizeUrl, /code_challenge_method=S256/);
    assert.match(start.authorizeUrl, /redirect_uri=http%3A%2F%2Fx%2Fmcp%2Foauth%2Fcallback/);

    // simulate the user: provider redirects back with code + state
    const { location } = await httpGetLocation(start.authorizeUrl);
    const loc = new URL(location);
    const code = loc.searchParams.get('code');
    const state = loc.searchParams.get('state');
    assert.ok(code && state);

    const done = await service.completeOAuth({ state, code, baseUrl: 'http://x' });
    assert.equal(done.ok, true);
    assert.equal(done.page, 'ready');
    assert.match(httpFake.state.lastAuthHeader, /^Bearer stub-at-/);
    // the token endpoint received the PKCE verifier, client id, redirect uri
    assert.equal(oauthStub.state.lastTokenBody.client_id, 'client-123');
    assert.ok(oauthStub.state.lastTokenBody.code_verifier);
    assert.ok(oauthStub.state.lastTokenBody.redirect_uri.endsWith('/mcp/oauth/callback'));
    assert.equal(service.connectionStatusFor(defFor('srv-oauth'), 'uB').status, 'ready');

    // replayed state is refused (one-time)
    const replay = await service.completeOAuth({ state, code, baseUrl: 'http://x' });
    assert.equal(replay.page, 'error');
    assert.equal(replay.code, 'invalid_state');
    // forged state refused
    const forged = await service.completeOAuth({ state: 'ab'.repeat(24), code, baseUrl: 'http://x' });
    assert.equal(forged.code, 'invalid_state');

    // PKCE negative: a wrong verifier is refused by the provider itself
    const start2 = await service.startConnect({ serverId: 'srv-oauth', uid: 'uC', confirm: true, baseUrl: 'http://x' });
    const loc2 = new URL((await httpGetLocation(start2.authorizeUrl)).location);
    const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: loc2.searchParams.get('code'),
        redirect_uri: 'http://x/mcp/oauth/callback',
        client_id: 'client-123',
        code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-wrong',
    });
    const bad = await fetch(`http://127.0.0.1:${oauthPort}/token`, { method: 'POST', body: form });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid_grant');

    // access tokens never in logs or at rest
    assert.equal(logLines.join('\n').includes('stub-at-'), false);
    assert.equal(JSON.stringify(connectionDocs()).includes('stub-at-'), false);
    flushLogs();
});

test('disconnect: confirm gate, credential wiped, status revoked, re-connect restarts', async () => {
    const gate = await service.disconnectConnection({ serverId: 'srv-key', uid: 'uA', confirm: false });
    assert.equal(gate.needsConfirmation, true);
    const r = await service.disconnectConnection({ serverId: 'srv-key', uid: 'uA', confirm: true });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'revoked');
    const rec = service.loadRecords().find((c) => c.serverId === 'srv-key' && c.ownerUid === 'uA');
    assert.equal(rec.status, 'revoked');
    assert.equal(rec.credential, null);
    assert.equal(service.findReadyCredential('srv-key', 'uA'), null);
    const again = await service.startConnect({ serverId: 'srv-key', uid: 'uA', confirm: true, baseUrl: 'http://x' });
    assert.equal(again.status, 'authorizing');
});

test('admin revokeById wipes any record', async () => {
    const rec = service.loadRecords().find((c) => c.serverId === 'srv-oauth' && c.ownerUid === 'uB');
    assert.ok(rec);
    const out = await service.revokeById(rec.id);
    assert.equal(out.status, 'revoked');
    assert.equal(out.credential, null);
    assert.equal(await service.revokeById('no-such-id'), null);
});

test('connect idempotency: retries and concurrent starts reuse one record', async () => {
    const first = await service.startConnect({ serverId: 'srv-key', uid: 'uDup', confirm: true, baseUrl: 'http://x' });
    assert.equal(first.status, 'authorizing');
    const second = await service.startConnect({ serverId: 'srv-key', uid: 'uDup', confirm: true, baseUrl: 'http://x' });
    assert.equal(second.status, 'authorizing');
    assert.equal(service.loadRecords().filter((c) => c.serverId === 'srv-key' && c.ownerUid === 'uDup').length, 1);

    const [a, b] = await Promise.all([
        service.startConnect({ serverId: 'srv-key', uid: 'uConc', confirm: true, baseUrl: 'http://x' }),
        service.startConnect({ serverId: 'srv-key', uid: 'uConc', confirm: true, baseUrl: 'http://x' }),
    ]);
    assert.equal(a.status, 'authorizing');
    assert.equal(b.status, 'authorizing');
    assert.equal(service.loadRecords().filter((c) => c.serverId === 'srv-key' && c.ownerUid === 'uConc').length, 1);

    // cleanup so later tests see the allowlist without these records
    for (const rec of service.loadRecords()) {
        if (rec.ownerUid === 'uDup' || rec.ownerUid === 'uConc') store.deleteConnectionRecord(rec.id);
    }
});

test('discovery failure: transport connects but tools/list failing never reaches ready', async () => {
    const broken = createFakeMcpHttpServer({ name: 'broken-list', failToolsList: true });
    await new Promise((r) => broken.server.listen(0, '127.0.0.1', r));
    defs.push({
        id: 'srv-key-broken', name: 'Broken List', transport: 'http',
        url: `http://127.0.0.1:${broken.server.address().port}/mcp`, enabled: true, trustedLocal: true, auth: 'api_key',
        authHeaderName: 'Authorization', authHeaderPrefix: 'Bearer', toolPermissions: {},
    });
    try {
        const start = await service.startConnect({ serverId: 'srv-key-broken', uid: 'uDisc', confirm: true, baseUrl: 'http://x' });
        assert.equal(start.status, 'authorizing');
        const rec = service.loadRecords().find((c) => c.serverId === 'srv-key-broken' && c.ownerUid === 'uDisc');
        const done = await service.completeSetup({ flowId: start.setupUrl.split('/').pop(), keyValue: 'some-key' });
        assert.equal(done.ok, false);
        assert.equal(done.page, 'failed');
        assert.equal(done.status, 'failed');
        assert.equal(done.error.code, 'discovery_failed');
        const after = service.loadRecords().find((c) => c.id === rec.id);
        assert.equal(after.status, 'failed');
        assert.equal(after.lastDiscoveredAt, null);
        // the credential itself was fine — stored so a retry can succeed
        assert.match(after.credential, /^v1:/);
    } finally {
        defs.splice(defs.findIndex((d) => d.id === 'srv-key-broken'), 1);
        await broken.close();
    }

    // partial discovery is tolerated: a fake that answers tools/list but
    // offers no resources/prompts still reaches ready (isolated def so the
    // shared fixture's state is untouched for the catalog-mapping test)
    const partial = createFakeMcpHttpServer({ name: 'partial-disc' });
    await new Promise((r) => partial.server.listen(0, '127.0.0.1', r));
    defs.push({
        id: 'srv-partial', name: 'Partial', transport: 'http',
        url: `http://127.0.0.1:${partial.server.address().port}/mcp`, enabled: true, trustedLocal: true, auth: 'none',
        toolPermissions: {},
    });
    try {
        await mcpManager.connect(defFor('srv-partial'), { force: true });
        const v = service.connectionStatusFor(defFor('srv-partial'), 'u1');
        assert.equal(v.status, 'ready');
        assert.ok(Array.isArray(v.tools) && v.tools.length >= 2);
    } finally {
        defs.splice(defs.findIndex((d) => d.id === 'srv-partial'), 1);
        await mcpManager.closeAll();
        await partial.close();
    }
});

test('catalog status mapping: shared server not_discovered -> ready; error -> unavailable', async () => {
    const before = service.connectionStatusFor(defFor('srv-shared'), 'u1');
    assert.equal(before.status, 'not_discovered');
    assert.equal(before.tools, null);
    await mcpManager.connect(defFor('srv-shared'), { force: true });
    const ready = service.connectionStatusFor(defFor('srv-shared'), 'u1');
    assert.equal(ready.status, 'ready');
    assert.ok(Array.isArray(ready.tools) && ready.tools.length >= 2);

    defs.push({ id: 'srv-dead', name: 'Dead', transport: 'http', url: 'http://127.0.0.1:1/mcp', enabled: true, trustedLocal: true, auth: 'none', toolPermissions: {} });
    try {
        await assert.rejects(() => mcpManager.connect(defFor('srv-dead'), { force: true }));
        assert.equal(service.connectionStatusFor(defFor('srv-dead'), 'u1').status, 'unavailable');
    } finally {
        defs.splice(defs.findIndex((d) => d.id === 'srv-dead'), 1);
    }
});

test('control-plane tools: list shape, connect gate, refusal for unknown, no secrets in output', async () => {
    const list = await service.executeControlTool({ name: 'lumo__connections_list', args: {}, uid: 'uA', baseUrl: 'http://x' });
    assert.equal(list.isError, false);
    const parsed = JSON.parse(list.text);
    const byId = Object.fromEntries(parsed.connections.map((c) => [c.serverId, c]));
    assert.equal(byId['srv-key'].status, 'authorizing'); // the re-connect left it authorizing
    assert.ok(byId['srv-shared'].tools);

    const gate = await service.executeControlTool({
        name: 'lumo__connection_connect', args: { serverId: 'srv-key', confirm: false }, uid: 'uZ', baseUrl: 'http://x',
    });
    assert.equal(gate.isError, false);
    assert.equal(JSON.parse(gate.text).needsConfirmation, true);

    const unknown = await service.executeControlTool({
        name: 'lumo__connection_connect', args: { serverId: 'ghost', confirm: true }, uid: 'uZ', baseUrl: 'http://x',
    });
    assert.equal(unknown.isError, true);
    assert.equal(JSON.parse(unknown.text).error, 'unknown_connection');

    const noSecrets = JSON.stringify(parsed);
    assert.equal(noSecrets.includes('right-key-123'), false);
    assert.equal(noSecrets.includes('tenant-cred-777'), false);
    assert.equal(noSecrets.includes('own-cred-555'), false);
});

test('oauth denial: provider error consumes the state, records auth_denied honestly', async () => {
    flushLogs();
    const start = await service.startConnect({ serverId: 'srv-oauth', uid: 'uDeny', confirm: true, baseUrl: 'http://x' });
    assert.equal(start.status, 'authorizing');
    const state = new URL(start.authorizeUrl).searchParams.get('state');

    // user denies at the provider: redirect back with ?error=access_denied
    const denied = await service.completeOAuth({ state, code: null, error: 'access_denied', baseUrl: 'http://x' });
    assert.equal(denied.page, 'denied');
    assert.equal(denied.code, 'auth_denied');
    const rec = service.loadRecords().find((c) => c.serverId === 'srv-oauth' && c.ownerUid === 'uDeny');
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error.code, 'auth_denied');
    assert.equal(rec.credential, null);
    assert.match(logLines.join('\n'), /oauth denied \(access_denied\): srv-oauth owner=uDeny/);
    flushLogs();

    // the denied state cannot be replayed with a code afterwards (one-time)
    const replay = await service.completeOAuth({ state, code: 'code-x', baseUrl: 'http://x' });
    assert.equal(replay.code, 'invalid_state');

    // abandonment (redirect without code or error) is treated the same
    const start2 = await service.startConnect({ serverId: 'srv-oauth', uid: 'uAbandon', confirm: true, baseUrl: 'http://x' });
    const abandoned = await service.completeOAuth({
        state: new URL(start2.authorizeUrl).searchParams.get('state'), code: null, baseUrl: 'http://x',
    });
    assert.equal(abandoned.page, 'denied');

    // recoverable: reconnect restarts the flow on the same record
    const retry = await service.startConnect({ serverId: 'srv-oauth', uid: 'uDeny', confirm: true, baseUrl: 'http://x' });
    assert.equal(retry.status, 'authorizing');
});

test('flow expiry: aged-out oauth state and setup flow are refused by TTL', async () => {
    const s1 = await service.startConnect({ serverId: 'srv-oauth', uid: 'uExp', confirm: true, baseUrl: 'http://x' });
    const s2 = await service.startConnect({ serverId: 'srv-key', uid: 'uExp', confirm: true, baseUrl: 'http://x' });
    assert.equal(s1.status, 'authorizing');
    assert.equal(s2.status, 'authorizing');

    // past the 10-minute oauth budget, still inside the 15-minute setup budget
    service._ageFlowsForTest(11 * 60 * 1000);
    const deadOauth = await service.completeOAuth({
        state: new URL(s1.authorizeUrl).searchParams.get('state'), code: 'code-x', baseUrl: 'http://x',
    });
    assert.equal(deadOauth.page, 'error');
    assert.equal(deadOauth.code, 'invalid_state');
    const aliveSetup = await service.completeSetup({ flowId: s2.setupUrl.split('/').pop(), keyValue: 'exp-key-1' });
    assert.equal(aliveSetup.page, 'ready');

    // past the 15-minute setup budget too
    const s3 = await service.startConnect({ serverId: 'srv-key', uid: 'uExp2', confirm: true, baseUrl: 'http://x' });
    service._ageFlowsForTest(16 * 60 * 1000);
    const deadSetup = await service.completeSetup({ flowId: s3.setupUrl.split('/').pop(), keyValue: 'exp-key-2' });
    assert.equal(deadSetup.page, 'error');
    assert.equal(deadSetup.code, 'invalid_flow');
});

test('per-uid flow cap: more than 20 pending authorizations are refused', async () => {
    for (let i = 0; i < 20; i++) {
        const r = await service.startConnect({ serverId: 'srv-key', uid: 'uCap', confirm: true, baseUrl: 'http://x' });
        assert.equal(r.status, 'authorizing');
    }
    const over = await service.startConnect({ serverId: 'srv-key', uid: 'uCap', confirm: true, baseUrl: 'http://x' });
    assert.equal(over.ok, false);
    assert.equal(over.error, 'too_many_flows');
    // other users are unaffected by one account exhausting its own budget
    const other = await service.startConnect({ serverId: 'srv-key', uid: 'uCapB', confirm: true, baseUrl: 'http://x' });
    assert.equal(other.status, 'authorizing');
});

test('control-plane actions are audited in logs without secrets', async () => {
    flushLogs();
    const start = await service.startConnect({ serverId: 'srv-key', uid: 'uAudit', confirm: true, baseUrl: 'http://x' });
    await service.completeSetup({ flowId: start.setupUrl.split('/').pop(), keyValue: 'audit-key-123' });
    await service.disconnectConnection({ serverId: 'srv-key', uid: 'uAudit', confirm: true });
    const all = logLines.join('\n');
    assert.match(all, /api-key flow started: srv-key owner=uAudit/);
    assert.match(all, /connection ready: Key Server \(srv-key\) owner=uAudit/);
    assert.match(all, /connection revoked: srv-key owner=uAudit/);
    assert.equal(all.includes('audit-key-123'), false);
    flushLogs();
});
