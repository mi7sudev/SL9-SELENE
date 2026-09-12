// mcp-connections.cjs — MCP connection lifecycle (the "control plane") for
// lumo-server.cjs.
//
// A connection is a user/tenant-scoped, credentialed binding to an
// admin-configured MCP server definition. This module owns:
//   - connection records in the SQLite store (store.cjs; credentials
//     AES-256-GCM encrypted inside the record)
//   - data/secret.key            (AES-256-GCM key, created on first use)
//   - the lifecycle state machine (authorizing → connected → ready |
//     failed | needs_reauth, plus revoked)
//   - one-time OAuth state flows (state + PKCE) and API-key setup flows
//   - the agent control-plane tools (lumo__*) and their system note
//
// Security invariants (see MCP.md):
//   - Credentials only ever live here, encrypted at rest; everything that
//     leaves this module is redacted status. Control-plane tool results,
//     catalog views, and logs never contain a credential value.
//   - Chat can never create or modify server definitions: connections bind
//     ONLY to admin-registered definitions resolved via getServerDef.
//   - One-time flows: every flow token/state is single-use and expiring.
//
// State machine:
//   available (implicit: no record) → authorizing → connected → ready
//       authorizing/connected → failed | needs_reauth
//       ready → (revoke) → revoked;   failed/needs_reauth → authorizing (retry)

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { transportKeyFor } = require('./mcp-manager.cjs');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;   // authorization round-trip budget
const SETUP_FLOW_TTL_MS = 15 * 60 * 1000;    // API-key form budget
const CONTROL_PREFIX = 'lumo__';

const CONTROL_SYSTEM_NOTE = [
    'Connection management (lumo__ tools):',
    '- When the user asks about connected services, or wants to connect, reconnect, or disconnect one, call lumo__connections_list first.',
    '- Resolve loose product names (e.g. "Gmail", "Notion", "Slack") against that list. If nothing matches, tell the user the administrator must add that connection first. Never invent, register, or modify servers.',
    '- lumo__connection_connect and lumo__connection_disconnect change external state; disconnect also permanently deletes the stored credential. Before the FIRST connect or disconnect call in a turn, ALWAYS ask a yes/no confirmation in chat and wait for the reply — even when the user\'s message is an imperative like "Connect my Gmail." or "Disconnect Slack.". Pass confirm:true only after an explicit affirmative REPLY from the user; the original request is not the confirmation.',
    '- After starting an authorization, give the user the setup/authorize URL from the result and wait for them to finish it in their browser. NEVER claim a connection succeeded until lumo__connection_status reports "ready".',
    '- Never ask the user to paste API keys, tokens, or passwords into chat. Direct them to the setup URL from the connect result.',
    '- Status values: available (admin-configured, not yet connected), authorizing (waiting for the user to finish authorization), ready (validated and usable), failed (recoverable; retry connect), needs_reauth (credential rejected; connect again), revoked.',
].join('\n');

const CONTROL_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: `${CONTROL_PREFIX}connections_list`,
            description: 'List every MCP connection available on this Lumo instance: id, name, auth type, the current user\'s connection status, and available tools. Always call this before connecting anything or when the user asks about their connected services.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: `${CONTROL_PREFIX}connection_connect`,
            description: 'Start (or retry) connecting the current user to an MCP connection by serverId from connections_list. For API-key and OAuth connections the result contains a URL the user must open in their browser to authorize. Only pass confirm:true after the user explicitly agreed in chat.',
            parameters: {
                type: 'object',
                properties: {
                    serverId: { type: 'string', description: 'The serverId from lumo__connections_list' },
                    confirm: { type: 'boolean', description: 'True only after the user confirmed in chat' },
                },
                required: ['serverId', 'confirm'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: `${CONTROL_PREFIX}connection_status`,
            description: 'Check the honest current status of one of the user\'s MCP connections and which tools are available. Use this to verify a connection finished authorizing before telling the user anything succeeded.',
            parameters: {
                type: 'object',
                properties: { serverId: { type: 'string' } },
                required: ['serverId'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: `${CONTROL_PREFIX}connection_disconnect`,
            description: 'Revoke the current user\'s connection to an MCP server and permanently delete its stored credential. Only pass confirm:true after the user explicitly agreed in chat.',
            parameters: {
                type: 'object',
                properties: {
                    serverId: { type: 'string' },
                    confirm: { type: 'boolean', description: 'True only after the user confirmed in chat' },
                },
                required: ['serverId', 'confirm'],
                additionalProperties: false,
            },
        },
    },
];

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function s256(verifier) { return b64url(crypto.createHash('sha256').update(verifier).digest()); }
function randomToken(bytes = 24) { return crypto.randomBytes(bytes).toString('hex'); }

// `store` is the SQLite store handle from store.cjs (the mcp_connections
// table); `dataDir` still locates secret.key, which deliberately stays a
// plain 0600 file so the encryption key never lives beside the ciphertext.
function createConnectionService({ dataDir, log, nowIso, store, getServerDef, mcpManager }) {
    const SECRET_KEY_FILE = path.join(dataDir, 'secret.key');

    const say = (...a) => { try { log && log(...a); } catch { /* logging never throws */ } };

    // ── credential encryption (AES-256-GCM, key material in data/secret.key) ──
    let secretKey = null;
    function ensureSecretKey() {
        if (secretKey) return secretKey;
        try {
            const buf = fs.readFileSync(SECRET_KEY_FILE);
            if (buf.length === 32) { secretKey = buf; return secretKey; }
        } catch { /* first use */ }
        secretKey = crypto.randomBytes(32);
        try { fs.writeFileSync(SECRET_KEY_FILE, secretKey, { mode: 0o600 }); } catch (e) {
            say(`[MCP-CONN] WARNING: could not persist secret key: ${e && e.message}`);
        }
        return secretKey;
    }
    function encryptCredential(plainText) {
        const key = ensureSecretKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ct = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
    }
    function decryptCredential(blob) {
        if (typeof blob !== 'string' || !blob.startsWith('v1:')) return null;
        const [, ivB64, tagB64, ctB64] = blob.split(':');
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', ensureSecretKey(), Buffer.from(ivB64, 'base64'));
            decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
            return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
        } catch {
            return null; // tampered or wrong key -> treat as no credential
        }
    }

    // ── connection records (rows in the store's mcp_connections table; a
    // write touches exactly one record instead of rewriting the whole store) ─
    function loadRecords() {
        return store.listConnectionRecords().filter((c) => c && typeof c === 'object' && c.id && c.serverId);
    }

    function recordView(rec) {
        return {
            id: rec.id,
            serverId: rec.serverId,
            ownerUid: rec.ownerUid,
            status: rec.status,
            error: rec.error || null,
            createdAt: rec.createdAt || null,
            updatedAt: rec.updatedAt || null,
            lastValidatedAt: rec.lastValidatedAt || null,
            lastDiscoveredAt: rec.lastDiscoveredAt || null,
        };
    }

    // The user's effective connection for a server: own connection wins over
    // a tenant-scoped one. This is the single multi-user seam.
    function findConnection(serverId, uid) {
        return store.findConnectionRecordFor(serverId, uid)
            || store.findConnectionRecordFor(serverId, 'tenant')
            || null;
    }

    function findConnectionById(id) {
        return store.getConnectionRecord(id);
    }

    function updateRecord(id, patch) {
        const rec = store.getConnectionRecord(id);
        if (!rec) return null;
        Object.assign(rec, patch, { updatedAt: nowIso() });
        store.upsertConnectionRecord(rec);
        return rec;
    }

    function createRecord(serverId, ownerUid, status) {
        const rec = {
            id: `conn-${randomToken(8)}`,
            serverId,
            ownerUid,
            status,
            credential: null,
            error: null,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            lastValidatedAt: null,
            lastDiscoveredAt: null,
        };
        store.upsertConnectionRecord(rec);
        return rec;
    }

    // ── one-time flows (in-memory; they die with the process by design) ──────
    const oauthFlows = new Map();  // state -> { serverId, ownerUid, connectionId, verifier, createdAt, used }
    const setupFlows = new Map();  // flowId -> { serverId, ownerUid, connectionId, createdAt, used }

    function sweepFlows() {
        const now = Date.now();
        for (const [k, f] of oauthFlows) if (f.used || now - f.createdAt > OAUTH_STATE_TTL_MS) oauthFlows.delete(k);
        for (const [k, f] of setupFlows) if (f.used || now - f.createdAt > SETUP_FLOW_TTL_MS) setupFlows.delete(k);
    }

    // ── status derivation ─────────────────────────────────────────────────────
    // Maps a live transport state to the honest user-facing catalog status.
    function mapTransportStatus(st) {
        if (st === 'connected') return 'ready';
        if (st === 'error') return 'unavailable';
        return 'not_discovered'; // disconnected / connecting: nothing discovered yet
    }

    // Full user-facing view of one server definition (for catalog + control
    // tools). Tools are names + classification only — never schemas/env.
    function connectionStatusFor(def, uid) {
        const entry = def; // raw definition; manager normalizes
        if (!entry.enabled) return { serverId: entry.id, name: entry.name, auth: entry.auth || 'none', status: 'disabled', tools: null, lastDiscoveredAt: null };
        if (!entry.auth || entry.auth === 'none') {
            const st = mcpManager.statusView(entry);
            return {
                serverId: entry.id,
                name: entry.name,
                auth: 'none',
                status: mapTransportStatus(st.status),
                tools: st.status === 'connected' ? st.tools.map((t) => ({ name: t.name, classification: t.classification })) : null,
                lastDiscoveredAt: st.lastDiscoveredAt,
            };
        }
        const rec = findConnection(entry.id, uid);
        if (!rec) return { serverId: entry.id, name: entry.name, auth: entry.auth, status: 'available', tools: null, lastDiscoveredAt: null };
        let status = rec.status;
        let tools = null;
        if (rec.status === 'ready') {
            const st = mcpManager.statusView(entry, { connection: { id: rec.id } });
            if (st.status === 'error') status = 'unavailable';
            else tools = st.tools.map((t) => ({ name: t.name, classification: t.classification }));
        }
        return {
            serverId: entry.id,
            name: entry.name,
            auth: entry.auth,
            status,
            error: rec.error || null,
            tools,
            lastValidatedAt: rec.lastValidatedAt || null,
            lastDiscoveredAt: rec.lastDiscoveredAt || null,
        };
    }

    // The decrypted credential value for a ready connection (transport header
    // injection). Returns { id, value } or null. Value never leaves this
    // module except into the manager's transport builder / redaction set.
    function findReadyCredential(serverId, uid) {
        const rec = findConnection(serverId, uid);
        if (!rec || rec.status !== 'ready' || !rec.credential) return null;
        const raw = decryptCredential(rec.credential);
        if (!raw) return null;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return null; }
        if (!parsed || typeof parsed.value !== 'string' || !parsed.value) return null;
        return { id: rec.id, value: parsed.value };
    }

    // ── validation: a connection is ready only after a REAL connect + discovery
    async function validateConnection(rec, def) {
        let credential = null;
        try { credential = JSON.parse(decryptCredential(rec.credential) || 'null'); } catch { credential = null; }
        const credValue = credential && typeof credential.value === 'string' ? credential.value : '';
        updateRecord(rec.id, { status: 'connected', error: null });
        try {
            // explicit discovering state: the connect succeeded, now we're
            // enumerating tools. This makes the lifecycle honest and visible:
            //   connected → discovering → ready (or failed)
            updateRecord(rec.id, { status: 'discovering', error: null });
            await mcpManager.connect(def, { force: true, connection: { id: rec.id, credential: credValue } });
            const st = mcpManager.statusView(def, { connection: { id: rec.id } });
            // ready only after a REAL connect + tool discovery: the manager
            // stamps lastDiscoveredAt solely when tools/list actually answered,
            // so a transport that connects but cannot be enumerated never
            // reaches ready (no fake success)
            if (st.status === 'connected' && st.lastDiscoveredAt) {
                updateRecord(rec.id, {
                    status: 'ready',
                    error: null,
                    lastValidatedAt: nowIso(),
                    lastDiscoveredAt: st.lastDiscoveredAt,
                });
                say(`[MCP-CONN] connection ready: ${def.name} (${def.id}) owner=${rec.ownerUid} tools=${st.tools.length}`);
            } else {
                const code = st.status === 'connected' ? 'discovery_failed' : 'validation_failed';
                updateRecord(rec.id, { status: 'failed', error: { code } });
                say(`[MCP-CONN] connection validation failed: ${def.name} (${def.id}): ${code}`);
            }
        } catch (e) {
            const msg = String((e && e.message) || '');
            const code = /401|403|unauthorized|invalid[_ ]?token|bad credentials|invalid api key/i.test(msg)
                ? 'auth_rejected' : 'validation_failed';
            updateRecord(rec.id, { status: code === 'auth_rejected' ? 'needs_reauth' : 'failed', error: { code } });
            say(`[MCP-CONN] connection validation failed: ${def.name} (${def.id}): ${mcpManager.redact(msg)}`);
        }
        return findConnectionById(rec.id);
    }

    // ── lifecycle operations (used by control tools AND HTTP endpoints) ──────
    async function startConnect({ serverId, uid, confirm, baseUrl }) {
        sweepFlows();
        // per-uid cap on live authorization flows: the TTL sweep bounds the map
        // overall, this bounds how many one account can have open at once
        let liveFlows = 0;
        for (const f of oauthFlows.values()) if (f.ownerUid === uid) liveFlows++;
        for (const f of setupFlows.values()) if (f.ownerUid === uid) liveFlows++;
        if (liveFlows >= 20) {
            return { ok: false, error: 'too_many_flows', message: 'Too many pending authorizations for this account. Finish or let one expire, then try again.' };
        }
        const def = getServerDef(String(serverId || ''));
        if (!def) return { ok: false, error: 'unknown_connection', message: 'No MCP connection with that id is configured on this instance. The administrator must add it first.' };
        if (!def.enabled) return { ok: false, error: 'disabled', message: `"${def.name}" is disabled by the administrator.` };
        const auth = def.auth || 'none';
        if (auth === 'none') {
            return { ok: true, serverId: def.id, name: def.name, status: 'ready', message: `"${def.name}" is instance-shared (administrator-managed credentials) — its tools are already available in chats; no personal connection is needed.` };
        }
        if (confirm !== true) {
            return { ok: false, needsConfirmation: true, serverId: def.id, name: def.name, message: `Ask the user to confirm connecting to "${def.name}" before proceeding.` };
        }
        let rec = findConnection(def.id, uid);
        if (rec && rec.status === 'ready' && findReadyCredential(def.id, uid)) {
            return { ok: true, serverId: def.id, name: def.name, status: 'ready', message: `"${def.name}" is already connected.` };
        }
        if (!rec) rec = createRecord(def.id, uid, 'authorizing');
        else updateRecord(rec.id, { status: 'authorizing', error: null });

        if (auth === 'api_key') {
            const flowId = randomToken(24);
            setupFlows.set(flowId, { serverId: def.id, ownerUid: uid, connectionId: rec.id, createdAt: Date.now(), used: false });
            const setupUrl = `${baseUrl}/mcp/setup/${flowId}`;
            say(`[MCP-CONN] api-key flow started: ${def.id} owner=${uid} flow=${flowId.slice(0, 8)}…`);
            return { ok: true, serverId: def.id, name: def.name, status: 'authorizing', setupUrl, message: `Give this URL to the user: they must open it in a browser and enter their API key there. Never ask for the key in chat. Then verify with connection_status before claiming success.` };
        }
        // oauth
        const cfg = def.oauth || {};
        if (!cfg.authorizeUrl || !cfg.tokenUrl || !cfg.clientId) {
            updateRecord(rec.id, { status: 'failed', error: { code: 'misconfigured' } });
            return { ok: false, error: 'misconfigured', message: `"${def.name}" has an incomplete OAuth configuration; the administrator must fix it.` };
        }
        const state = randomToken(24);
        const verifier = b64url(crypto.randomBytes(32));
        oauthFlows.set(state, { serverId: def.id, ownerUid: uid, connectionId: rec.id, verifier, createdAt: Date.now(), used: false });
        const u = new URL(cfg.authorizeUrl);
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', cfg.clientId);
        u.searchParams.set('redirect_uri', `${baseUrl}/mcp/oauth/callback`);
        u.searchParams.set('state', state);
        if (cfg.scopes) u.searchParams.set('scope', cfg.scopes);
        if (cfg.usePkce !== false) {
            u.searchParams.set('code_challenge', s256(verifier));
            u.searchParams.set('code_challenge_method', 'S256');
        }
        say(`[MCP-CONN] oauth flow started: ${def.id} owner=${uid} state=${state.slice(0, 8)}…`);
        return { ok: true, serverId: def.id, name: def.name, status: 'authorizing', authorizeUrl: u.toString(), message: `Give this authorization URL to the user: they must open it, approve access, and they will land back on this instance. Then verify with connection_status before claiming success.` };
    }

    async function completeOAuth({ state, code, error, baseUrl }) {
        sweepFlows();
        if (!state) return { ok: false, page: 'error', code: 'invalid_state' };
        const flow = oauthFlows.get(state);
        if (!flow || flow.used) return { ok: false, page: 'error', code: 'invalid_state' };
        if (error || !code) {
            // the user denied (or abandoned) the authorization at the provider:
            // consume the one-time state, record the honest recoverable state,
            // and never store a credential
            oauthFlows.delete(state);
            const rec = findConnectionById(flow.connectionId);
            if (rec && rec.ownerUid === flow.ownerUid) {
                updateRecord(rec.id, { status: 'failed', error: { code: 'auth_denied' } });
            }
            say(`[MCP-CONN] oauth ${error ? `denied (${String(error).slice(0, 40)})` : 'abandoned'}: ${flow.serverId} owner=${flow.ownerUid}`);
            const def = getServerDef(flow.serverId);
            return { ok: false, page: 'denied', code: 'auth_denied', name: def ? def.name : undefined };
        }
        oauthFlows.delete(state); // one-time use, even before validation succeeds
        const def = getServerDef(flow.serverId);
        if (!def) return { ok: false, page: 'error', code: 'unknown_connection' };
        const rec = findConnectionById(flow.connectionId);
        if (!rec || rec.ownerUid !== flow.ownerUid) return { ok: false, page: 'error', code: 'invalid_state' };
        const cfg = def.oauth || {};
        try {
            const form = new URLSearchParams();
            form.set('grant_type', 'authorization_code');
            form.set('code', String(code));
            form.set('redirect_uri', `${baseUrl}/mcp/oauth/callback`);
            form.set('client_id', cfg.clientId);
            if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
            if (cfg.usePkce !== false) form.set('code_verifier', flow.verifier);
            const resp = await fetch(cfg.tokenUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: form.toString(),
                signal: AbortSignal.timeout(15000),
            });
            if (!resp.ok) throw new Error(`token endpoint ${resp.status}`);
            const tok = await resp.json();
            if (!tok || typeof tok.access_token !== 'string' || !tok.access_token) throw new Error('no access_token in token response');
            const credential = { type: 'oauth', value: tok.access_token, refreshToken: typeof tok.refresh_token === 'string' ? tok.refresh_token : null };
            updateRecord(rec.id, { credential: encryptCredential(JSON.stringify(credential)) });
            mcpManager.registerSecretValue(tok.access_token);
            const finalRec = await validateConnection(findConnectionById(rec.id), def);
            return { ok: finalRec.status === 'ready', page: finalRec.status === 'ready' ? 'ready' : 'failed', status: finalRec.status, name: def.name, error: finalRec.error };
        } catch (e) {
            updateRecord(rec.id, { status: 'failed', error: { code: 'oauth_exchange_failed' } });
            say(`[MCP-CONN] oauth exchange failed: ${def.id}: ${mcpManager.redact(String((e && e.message) || e))}`);
            return { ok: false, page: 'failed', code: 'oauth_exchange_failed', name: def.name };
        }
    }

    async function completeSetup({ flowId, keyValue }) {
        sweepFlows();
        const flow = setupFlows.get(String(flowId || ''));
        if (!flow || flow.used) return { ok: false, page: 'error', code: 'invalid_flow' };
        const key = String(keyValue || '').trim();
        if (!key) return { ok: false, page: 'form', code: 'missing_key' };
        setupFlows.delete(flowId); // one-time use
        const def = getServerDef(flow.serverId);
        if (!def) return { ok: false, page: 'error', code: 'unknown_connection' };
        const rec = findConnectionById(flow.connectionId);
        if (!rec || rec.ownerUid !== flow.ownerUid) return { ok: false, page: 'error', code: 'invalid_flow' };
        const credential = { type: 'api_key', value: key };
        updateRecord(rec.id, { credential: encryptCredential(JSON.stringify(credential)) });
        mcpManager.registerSecretValue(key);
        const finalRec = await validateConnection(findConnectionById(rec.id), def);
        return { ok: finalRec.status === 'ready', page: finalRec.status === 'ready' ? 'ready' : 'failed', status: finalRec.status, name: def.name, error: finalRec.error };
    }

    async function disconnectConnection({ serverId, uid, confirm }) {
        const def = getServerDef(String(serverId || ''));
        if (!def) return { ok: false, error: 'unknown_connection', message: 'No MCP connection with that id is configured on this instance.' };
        if (confirm !== true) {
            return { ok: false, needsConfirmation: true, serverId: def.id, name: def.name, message: `Ask the user to confirm disconnecting "${def.name}" before proceeding. This deletes the stored credential.` };
        }
        const rec = findConnection(def.id, uid);
        if (!rec || rec.status === 'revoked') {
            return { ok: true, serverId: def.id, name: def.name, status: 'available', message: `"${def.name}" had no active user connection.` };
        }
        updateRecord(rec.id, { status: 'revoked', credential: null, error: null });
        try { await mcpManager.disconnect(transportKeyFor(def.id, rec.id), { silent: true }); } catch { /* already dead */ }
        say(`[MCP-CONN] connection revoked: ${def.id} owner=${rec.ownerUid}`);
        return { ok: true, serverId: def.id, name: def.name, status: 'revoked', message: `"${def.name}" is disconnected; the stored credential was deleted.` };
    }

    // Admin override: revoke any record by id (no ownership check — admin only
    // route in lumo-server.cjs). Credential wiped, transport closed.
    async function revokeById(id) {
        const rec = findConnectionById(String(id || ''));
        if (!rec) return null;
        updateRecord(rec.id, { status: 'revoked', credential: null, error: null });
        try { await mcpManager.disconnect(transportKeyFor(rec.serverId, rec.id), { silent: true }); } catch { /* already dead */ }
        say(`[MCP-CONN] connection revoked by admin: ${rec.serverId} owner=${rec.ownerUid}`);
        return findConnectionById(rec.id);
    }

    // ── agent control plane ───────────────────────────────────────────────────
    function controlToolDefs() { return CONTROL_TOOL_DEFS; }

    function connectionsListFor(uid) {
        return {
            connections: loadDefs().map((def) => {
                const v = connectionStatusFor(def, uid);
                return {
                    serverId: v.serverId,
                    name: v.name,
                    auth: v.auth,
                    status: v.status,
                    error: v.error || null,
                    tools: v.tools,
                };
            }),
        };
    }

    // Definitions come from the server (admin-owned allowlist); the service
    // never mutates them.
    let defsProvider = () => [];
    function setDefsProvider(fn) { defsProvider = fn; }
    function loadDefs() { return defsProvider() || []; }

    // Returns { isError, text } for the chat loop. Text is JSON; it never
    // contains credential material.
    async function executeControlTool({ name, args, uid, baseUrl }) {
        const a = args && typeof args === 'object' ? args : {};
        try {
            if (name === `${CONTROL_PREFIX}connections_list`) {
                return { isError: false, text: JSON.stringify(connectionsListFor(uid)) };
            }
            if (name === `${CONTROL_PREFIX}connection_connect`) {
                const r = await startConnect({ serverId: a.serverId, uid, confirm: a.confirm === true, baseUrl });
                return { isError: r.ok === false && !r.needsConfirmation, text: JSON.stringify(r) };
            }
            if (name === `${CONTROL_PREFIX}connection_status`) {
                const def = getServerDef(String(a.serverId || ''));
                if (!def) return { isError: true, text: JSON.stringify({ ok: false, error: 'unknown_connection' }) };
                const v = connectionStatusFor(def, uid);
                return { isError: false, text: JSON.stringify(v) };
            }
            if (name === `${CONTROL_PREFIX}connection_disconnect`) {
                const r = await disconnectConnection({ serverId: a.serverId, uid, confirm: a.confirm === true });
                return { isError: r.ok === false && !r.needsConfirmation, text: JSON.stringify(r) };
            }
            return { isError: true, text: JSON.stringify({ ok: false, error: 'unknown_control_tool' }) };
        } catch (e) {
            say(`[MCP-CONN] control tool ${name} failed:`, mcpManager.redact(String((e && e.message) || e)));
            return { isError: true, text: JSON.stringify({ ok: false, error: 'internal_error' }) };
        }
    }

    // ── minimal public API for pages (used by the oauth/setup endpoints) ─────
    function getSetupFlow(flowId) {
        sweepFlows();
        const f = setupFlows.get(String(flowId || ''));
        return f ? { serverId: f.serverId, ownerUid: f.ownerUid, connectionId: f.connectionId } : null;
    }

    // ── in-app API-key connection (no external HTML page needed) ────────────
    // Combines startConnect + completeSetup into one call so the settings UI
    // can connect an api_key server without navigating to /mcp/setup/<flow>.
    // For oauth servers, returns the authorizeUrl so the UI can open it.
    async function connectInApp({ serverId, uid, apiKey, baseUrl }) {
        const def = getServerDef(String(serverId || ''));
        if (!def) return { ok: false, error: 'unknown_connection', message: 'No MCP server with that id.' };
        if (!def.enabled) return { ok: false, error: 'disabled', message: `"${def.name}" is disabled.` };
        const auth = def.auth || 'none';
        if (auth === 'none') {
            return { ok: true, serverId: def.id, name: def.name, status: 'ready', message: `"${def.name}" is instance-shared — no personal connection needed.` };
        }
        // For api_key: create flow + complete it in one step
        if (auth === 'api_key') {
            const key = String(apiKey || '').trim();
            if (!key) return { ok: false, error: 'missing_key', message: 'An API key is required.' };
            let rec = findConnection(def.id, uid);
            if (!rec) rec = createRecord(def.id, uid, 'authorizing');
            else updateRecord(rec.id, { status: 'authorizing', error: null });
            const flowId = randomToken(24);
            setupFlows.set(flowId, { serverId: def.id, ownerUid: uid, connectionId: rec.id, createdAt: Date.now(), used: false });
            say(`[MCP-CONN] in-app api-key flow: ${def.id} owner=${uid} flow=${flowId.slice(0, 8)}…`);
            const r = await completeSetup({ flowId, keyValue: key });
            return { ok: r.ok, serverId: def.id, name: def.name, status: r.status || (r.ok ? 'ready' : 'failed'), error: r.error, message: r.ok ? `"${def.name}" is connected and ready.` : `Connection failed: ${r.error ? r.error.code : 'unknown error'}` };
        }
        // For oauth: return the authorize URL (UI opens it in a new tab)
        if (auth === 'oauth') {
            const start = await startConnect({ serverId: def.id, uid, confirm: true, baseUrl });
            if (!start.ok) return start;
            return { ok: true, serverId: def.id, name: def.name, status: 'authorizing', authorizeUrl: start.authorizeUrl || start.setupUrl, message: `Open the authorization URL to connect "${def.name}".` };
        }
        return { ok: false, error: 'unsupported_auth', message: `Auth type "${auth}" is not supported for in-app connection.` };
    }

    return {
        CONTROL_SYSTEM_NOTE,
        controlToolDefs,
        executeControlTool,
        connectionStatusFor,
        connectionsListFor,
        findReadyCredential,
        startConnect,
        completeOAuth,
        completeSetup,
        connectInApp,
        disconnectConnection,
        revokeById,
        getSetupFlow,
        setDefsProvider,
        recordView,
        loadRecords,
        // test-only: age every live flow's createdAt so the next sweep expires
        // them (lets tests prove TTL expiry without sleeping real time)
        _ageFlowsForTest: (ms) => {
            for (const f of oauthFlows.values()) f.createdAt -= ms;
            for (const f of setupFlows.values()) f.createdAt -= ms;
        },
        _encryptCredential: encryptCredential,
        _decryptCredential: decryptCredential,
    };
}

module.exports = { createConnectionService, CONTROL_PREFIX, OAUTH_STATE_TTL_MS, SETUP_FLOW_TTL_MS };
