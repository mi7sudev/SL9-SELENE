// mcp-manager.cjs — MCP (Model Context Protocol) client manager for lumo-server.cjs.
//
// Owns the lifecycle of every configured MCP server connection: connect,
// capability discovery (tools/resources/prompts), tool execution, disconnect,
// crash handling and full process cleanup on server shutdown. Transports are
// the official SDK's (stdio + Streamable HTTP + legacy SSE fallback). All
// secrets stay here and in data/mcp-servers.json — nothing that leaves this
// module may carry an env value, and `redact()` must wrap every log/error
// string that can embed one.
//
// The manager is config-agnostic: lumo-server.cjs owns data/mcp-servers.json
// and passes plain entries in; state is keyed by entry.id.

'use strict';

const dns = require('dns').promises;
const net = require('net');

// Connection / discovery timeouts. Tool-call timeout is per-call (default below).
const CONNECT_TIMEOUT_MS = 15000;
const LIST_TIMEOUT_MS = 15000;
const DEFAULT_TOOL_TIMEOUT_MS = 60000;

// Keep the last N chars of a stdio server's stderr for diagnostics (redacted).
const STDERR_TAIL_CHARS = 2000;

// Guard rail so a single broken server can never wedge chat: `callTool` and
// `connect` both run under these unless overridden.
const MAX_TOOL_RESULT_CHARS = 16000;

// Single owner of the transport state-key format: shared servers use the
// plain entry id; per-connection (auth-bearing) transports are keyed
// `<entryId>::<connectionId>`. mcp-connections.cjs imports this so a format
// change can never silently no-op disconnects.
function transportKeyFor(entryId, connectionId) {
    return connectionId ? `${entryId}::${connectionId}` : entryId;
}

function isPrivateIp(ip) {
    const v = net.isIP(ip);
    if (v === 4) {
        const p = ip.split('.').map(Number);
        if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true;
        if (p[0] === 169 && p[1] === 254) return true; // link-local (cloud metadata)
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
        if (p[0] === 192 && p[1] === 168) return true;
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
        return false;
    }
    if (v === 6) {
        const a = ip.toLowerCase();
        if (a === '::1' || a === '::') return true;
        if (a.startsWith('fe80')) return true; // link-local
        if (/^f[cd][0-9a-f]{2}:/.test(a)) return true; // unique local fc00::/7
        // IPv4-mapped ::ffff:10.0.0.1
        const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (m) return isPrivateIp(m[1]);
        return false;
    }
    return true; // unparseable -> treat as private (fail closed)
}

// SSRF guard for remote transports. Blocks loopback / private / link-local
// targets (direct IPs and DNS names resolving to them) unless the admin
// flagged the entry `trustedLocal` — the documented escape hatch for
// self-hosted MCP endpoints on the LAN.
async function assertUrlAllowed(rawUrl, trustedLocal) {
    let u;
    try { u = new URL(rawUrl); } catch { throw new Error('Invalid MCP server URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('MCP server URL must be http(s)');
    }
    if (trustedLocal) return;
    const host = u.hostname;
    const literal = net.isIP(host) ? [host] : null;
    let addrs;
    try {
        addrs = literal || (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch (e) {
        throw new Error(`MCP server host could not be resolved: ${host}`);
    }
    if (!addrs.length) throw new Error(`MCP server host could not be resolved: ${host}`);
    const bad = addrs.find((ip) => isPrivateIp(ip));
    if (bad) {
        throw new Error(
            `Refusing MCP endpoint ${host} -> ${bad} (private/loopback address). ` +
            'Enable "Trusted local endpoint" on this server if this is intentional.'
        );
    }
}

function normalizeEntry(entry) {
    const t = entry.transport === 'http' ? 'http' : 'stdio';
    const out = {
        id: String(entry.id || ''),
        name: String(entry.name || 'MCP server').slice(0, 80),
        transport: t,
        enabled: entry.enabled !== false,
        trustedLocal: entry.trustedLocal === true,
        toolPermissions: entry.toolPermissions && typeof entry.toolPermissions === 'object' ? { ...entry.toolPermissions } : {},
        // per-user auth binding: 'none' = shared admin credentials (env/headers);
        // 'api_key' | 'oauth' = tools require a ready connection record whose
        // credential is injected as a transport header (http only)
        auth: entry.auth === 'api_key' || entry.auth === 'oauth' ? entry.auth : 'none',
    };
    if (out.auth === 'api_key') {
        out.authHeaderName = String(entry.authHeaderName || 'Authorization').slice(0, 64);
        out.authHeaderPrefix = typeof entry.authHeaderPrefix === 'string' ? entry.authHeaderPrefix : 'Bearer';
    }
    if (out.auth === 'oauth') {
        const o = entry.oauth && typeof entry.oauth === 'object' ? entry.oauth : {};
        out.oauth = {
            authorizeUrl: String(o.authorizeUrl || '').trim(),
            tokenUrl: String(o.tokenUrl || '').trim(),
            clientId: String(o.clientId || '').trim(),
            clientSecret: String(o.clientSecret || '').trim(),
            scopes: typeof o.scopes === 'string' ? o.scopes.trim() : '',
            usePkce: o.usePkce !== false,
        };
        out.authHeaderName = String(entry.authHeaderName || 'Authorization').slice(0, 64);
        out.authHeaderPrefix = typeof entry.authHeaderPrefix === 'string' ? entry.authHeaderPrefix : 'Bearer';
    }
    if (t === 'stdio') {
        out.command = String(entry.command || '').trim();
        out.args = Array.isArray(entry.args) ? entry.args.map(String) : [];
        out.cwd = typeof entry.cwd === 'string' && entry.cwd.trim() ? entry.cwd.trim() : undefined;
        out.env = entry.env && typeof entry.env === 'object' ? { ...entry.env } : {};
    } else {
        out.url = String(entry.url || '').trim();
        out.headers = entry.headers && typeof entry.headers === 'object' ? { ...entry.headers } : {};
    }
    return out;
}

function toolAllowed(entry, toolName) {
    const p = entry.toolPermissions[toolName];
    return p !== 'off'; // default-on; 'off' is the only deny state
}

function createMcpManager({ log } = {}) {
        // id -> { status, error, client, transport, tools, resources, prompts, connectedAt, stderrTail, connecting, lastAttempt }
    const states = new Map();
    let sdk = null;
    const secrets = new Set(); // env values registered for redaction

    const say = (...a) => { try { log && log(...a); } catch { /* never throw from logging */ } };

    function registerSecrets(entry) {
        const values = Object.values((entry.env && typeof entry.env === 'object' && entry.env) || {});
        for (const v of values) {
            if (typeof v === 'string' && v.length >= 4) secrets.add(v);
            else if (v != null) secrets.add(String(v));
        }
        if (entry.oauth && typeof entry.oauth.clientSecret === 'string' && entry.oauth.clientSecret.length >= 4) {
            secrets.add(entry.oauth.clientSecret);
        }
    }

    function registerSecretValue(value) {
        if (typeof value === 'string' && value.length >= 4) secrets.add(value);
    }

    function redact(text) {
        let out = String(text == null ? '' : text);
        for (const s of secrets) {
            if (s && out.includes(s)) out = out.split(s).join('••••••••');
        }
        return out;
    }

    async function loadSdk() {
        if (!sdk) {
            const [idx, stdio, shttp, sse] = await Promise.all([
                import('@modelcontextprotocol/sdk/client/index.js'),
                import('@modelcontextprotocol/sdk/client/stdio.js'),
                import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
                import('@modelcontextprotocol/sdk/client/sse.js'),
            ]);
            sdk = { Client: idx.Client, StdioClientTransport: stdio.StdioClientTransport, getDefaultEnvironment: stdio.getDefaultEnvironment, StreamableHTTPClientTransport: shttp.StreamableHTTPClientTransport, SSEClientTransport: sse.SSEClientTransport };
        }
        return sdk;
    }

    function stateFor(id) {
        let st = states.get(id);
        if (!st) {
            st = { status: 'disconnected', error: null, client: null, transport: null, tools: [], resources: [], prompts: [], connectedAt: null, lastDiscoveredAt: null, stderrTail: '', connecting: null, lastAttempt: 0 };
            states.set(id, st);
        }
        return st;
    }

    // Per-connection transports: auth-bearing servers get one live transport
    // per connection record (key `<entryId>::<connectionId>`); shared servers
    // use the plain entry id. Format lives in module-level transportKeyFor.
    const keyFor = transportKeyFor;

    function withTimeout(promise, ms, label) {
        let timer;
        const t = new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
        });
        return Promise.race([promise, t]).finally(() => clearTimeout(timer));
    }

    async function buildTransport(entry, connection) {
        const s = await loadSdk();
        if (entry.transport === 'stdio') {
            if (!entry.command) throw new Error('stdio transport requires a command');
            if (entry.auth !== 'none') throw new Error('per-user auth is only supported for http MCP servers');
            const env = { ...s.getDefaultEnvironment() };
            for (const [k, v] of Object.entries(entry.env || {})) env[k] = String(v);
            const transport = new s.StdioClientTransport({
                command: entry.command,
                args: entry.args,
                cwd: entry.cwd,
                env,
                stderr: 'pipe',
            });
            return transport;
        }
        await assertUrlAllowed(entry.url, entry.trustedLocal);
        const headers = { ...(entry.headers || {}) };
        // Credential injection (connection-scoped): the generic header name +
        // prefix come from the admin's server definition; the value is the
        // connection's decrypted credential. Never logged.
        if (entry.auth !== 'none' && connection && connection.credential) {
            const name = entry.authHeaderName || 'Authorization';
            const prefix = entry.authHeaderPrefix;
            headers[name] = prefix ? `${prefix} ${connection.credential}` : connection.credential;
        }
        const opts = {
            requestInit: { headers },
        };
        try {
            return new s.StreamableHTTPClientTransport(new URL(entry.url), opts);
        } catch (e) {
            // Streamable HTTP not supported by the endpoint -> legacy SSE fallback.
            say('[MCP] streamable-http connect failed, trying SSE fallback:', redact(e && e.message));
            return new s.SSEClientTransport(new URL(entry.url), {
                eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...headers, ...(init && init.headers) } }) },
                requestInit: { headers },
            });
        }
    }

    function wireDiagnostics(entry, st, transport) {
        // stdio stderr tap (redacted tail kept for the admin UI)
        if (transport.stderr && typeof transport.stderr.on === 'function') {
            transport.stderr.on('data', (chunk) => {
                st.stderrTail = (st.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
            });
        }
        const drop = (err) => {
            st.status = 'error';
            st.error = redact((err && err.message) || 'connection closed');
            st.client = null;
            st.tools = []; st.resources = []; st.prompts = [];
            say(`[MCP] connection lost: ${entry.name} (${entry.id}):`, st.error);
        };
        transport.onclose = () => { if (st.status === 'connected') drop(null); };
        transport.onerror = (e) => { if (st.status === 'connected') drop(e); };
    }

    async function discover(st) {
        const caps = { tools: [], resources: [], prompts: [] };
        let toolsOk = false;
        try { const r = await withTimeout(st.client.listTools(), LIST_TIMEOUT_MS, 'tools/list'); caps.tools = (r && r.tools) || []; toolsOk = true; } catch (e) { say('[MCP] tools/list failed:', redact(e && e.message)); }
        try { const r = await withTimeout(st.client.listResources(), LIST_TIMEOUT_MS, 'resources/list'); caps.resources = (r && r.resources) || []; } catch { /* capability absent */ }
        try { const r = await withTimeout(st.client.listResourceTemplates && st.client.listResourceTemplates(), LIST_TIMEOUT_MS, 'resources/templates'); if (r && r.resourceTemplates) caps.resources = caps.resources.concat(r.resourceTemplates); } catch { /* capability absent */ }
        try { const r = await withTimeout(st.client.listPrompts(), LIST_TIMEOUT_MS, 'prompts/list'); caps.prompts = (r && r.prompts) || []; } catch { /* capability absent */ }
        st.tools = caps.tools; st.resources = caps.resources; st.prompts = caps.prompts;
        if (toolsOk) st.lastDiscoveredAt = Date.now();
        return caps;
    }

    async function connect(entryRaw, { force, connection } = {}) {
        const entry = normalizeEntry(entryRaw);
        if (!entry.enabled) { const st0 = stateFor(keyFor(entry.id, connection && connection.id)); st0.status = 'disabled'; return st0; }
        const key = keyFor(entry.id, connection && connection.id);
        const st = stateFor(key);
        if (st.status === 'connected') return st;
        // Backoff for the chat path: an unreachable server must not tax every
        // chat request with a full connect timeout. Admin actions use force.
        if (!force && st.status === 'error' && st.lastAttempt && Date.now() - st.lastAttempt < 60000) {
            throw new Error(`"${entry.name}" failed to connect recently: ${st.error || 'unknown error'}`);
        }
        if (st.connecting) return st.connecting; // dedupe concurrent connects

        st.connecting = (async () => {
            try {
                st.lastAttempt = Date.now();
                await disconnect(key, { silent: true });
                const s = await loadSdk();
                say(`[MCP] Connecting server: ${entry.name} (${key})${entry.transport === 'stdio' ? ` cmd=${JSON.stringify([entry.command].concat(entry.args))}` : ` url=${entry.url}`}${connection ? ' conn=' + connection.id : ''}`);
                const transport = await buildTransport(entry, connection);
                const client = new s.Client({ name: 'lumo-mcp-client', version: '1.0.0' });
                st.status = 'connecting';
                st.error = null;
                st.stderrTail = '';
                wireDiagnostics(entry, st, transport);
                await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `Connect to "${entry.name}"`);
                st.client = client;
                st.transport = transport;
                st.status = 'connected';
                st.connectedAt = Date.now();
                await discover(st);
                say(`[MCP] Connected: ${entry.name} — discovered ${st.tools.length} tools, ${st.resources.length} resources, ${st.prompts.length} prompts`);
                return st;
            } catch (e) {
                st.status = 'error';
                st.error = redact((e && e.message) || String(e));
                st.client = null;
                st.tools = []; st.resources = []; st.prompts = [];
                say(`[MCP] connect failed: ${entry.name}:`, st.error);
                throw e;
            } finally {
                st.connecting = null;
            }
        })();
        return st.connecting;
    }

    async function disconnect(id, { silent } = {}) {
        const st = states.get(id);
        if (!st) return;
        if (st.connecting) { try { await st.connecting; } catch { /* connect failed; still clean up */ } }
        if (st.client) {
            try { await st.client.close(); } catch { /* closing a dead transport is fine */ }
        }
        if (st.transport) {
            try { await st.transport.close(); } catch { /* ditto */ }
        }
        st.client = null;
        st.transport = null;
        st.tools = []; st.resources = []; st.prompts = [];
        st.status = 'disconnected';
        st.connectedAt = null;
        if (!silent) say(`[MCP] Disconnected: ${id}`);
    }

    // Drop the shared state and every per-connection state of one server
    // (config changed, admin disconnect, server deleted).
    async function disconnectAllFor(entryId) {
        for (const key of Array.from(states.keys())) {
            if (key === entryId || key.startsWith(`${entryId}::`)) await disconnect(key, { silent: true });
        }
    }

    async function reconnect(entryRaw) {
        const entry = normalizeEntry(entryRaw);
        await disconnect(entry.id, { silent: true });
        return connect(entry);
    }

    // Ensure connected (lazy auto-connect for the chat path) and run a tool.
    // Returns the redacted, size-capped text result. Throws user-safe errors.
    async function callTool(entryRaw, toolName, args, { timeoutMs, connection } = {}) {
        const entry = normalizeEntry(entryRaw);
        const key = keyFor(entry.id, connection && connection.id);
        const st = stateFor(key);
        if (st.status !== 'connected' || !st.client) {
            if (!entry.enabled) throw new Error(`MCP server "${entry.name}" is disabled`);
            await connect(entry, { connection });
        }
        const cur = stateFor(key);
        if (cur.status !== 'connected' || !cur.client) throw new Error(`MCP server "${entry.name}" is not connected`);
        if (!toolAllowed(entry, toolName)) throw new Error(`Tool "${toolName}" is disabled by the administrator`);
        let result;
        try {
            result = await withTimeout(
                cur.client.callTool({ name: toolName, arguments: args || {} }, undefined, { timeout: timeoutMs || DEFAULT_TOOL_TIMEOUT_MS }),
                (timeoutMs || DEFAULT_TOOL_TIMEOUT_MS) + 2000,
                `Tool "${toolName}"`
            );
        } catch (e) {
            throw new Error(redact((e && e.message) || 'tool call failed'));
        }
        const text = toolResultToText(result);
        if (result && result.isError) {
            const err = new Error(`Tool "${toolName}" failed: ${text.slice(0, 500)}`);
            err.isToolError = true;
            err.rawText = text;
            throw err;
        }
        say(`[MCP] Tool completed: ${entry.id}__${toolName} (${text.length} chars)`);
        return text.slice(0, MAX_TOOL_RESULT_CHARS);
    }

    function toolResultToText(result) {
        if (!result) return '';
        if (typeof result.structuredContent === 'object' && result.structuredContent !== null) {
            try { return JSON.stringify(result.structuredContent, null, 1); } catch { /* fall through */ }
        }
        const parts = Array.isArray(result.content) ? result.content : [];
        const chunks = [];
        for (const part of parts) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'text' && typeof part.text === 'string') chunks.push(part.text);
            else if (part.type === 'image') chunks.push(`[image: ${part.mimeType || 'unknown'}, ${part.data ? part.data.length : 0} base64 chars — elided]`);
            else if (part.type === 'audio') chunks.push(`[audio: ${part.mimeType || 'unknown'} — elided]`);
            else if (part.type === 'resource' && part.resource) {
                const r = part.resource;
                chunks.push(`[resource ${r.uri || ''}]\n${typeof r.text === 'string' ? r.text : '[binary resource]'}`);
            } else if (part.type === 'resource_link') chunks.push(`[resource link: ${part.uri || ''}]`);
            else try { chunks.push(JSON.stringify(part)); } catch { /* skip */ }
        }
        return redact(chunks.join('\n\n'));
    }

    // Snapshot for admin UI / proxy: never includes env values or credentials.
    // `opts.connection` selects a per-connection transport state.
    function statusView(entryRaw, opts = {}) {
        const entry = normalizeEntry(entryRaw);
        const connId = opts.connection && opts.connection.id;
        const st = states.get(keyFor(entry.id, connId)) || stateFor(keyFor(entry.id, connId));
        return {
            id: entry.id,
            name: entry.name,
            transport: entry.transport,
            enabled: entry.enabled,
            auth: entry.auth,
            status: entry.enabled ? st.status : 'disabled',
            error: st.error,
            connectedAt: st.connectedAt,
            lastDiscoveredAt: st.lastDiscoveredAt,
            toolCount: st.tools.length,
            tools: st.tools.map((t) => {
                const ann = t.annotations && typeof t.annotations === 'object' ? t.annotations : null;
                const readOnly = !!(ann && ann.readOnlyHint === true);
                const writeCapable = !!(ann && (ann.readOnlyHint === false || ann.destructiveHint === true));
                return {
                    name: t.name,
                    description: typeof t.description === 'string' ? t.description.slice(0, 300) : '',
                    inputSchema: t.inputSchema || { type: 'object' },
                    enabled: toolAllowed(entry, t.name),
                    annotations: ann,
                    classification: readOnly ? 'read-only' : writeCapable ? 'write' : 'unclassified',
                };
            }),
            resourceCount: st.resources.length,
            promptCount: st.prompts.length,
            stderrTail: st.stderrTail ? redact(st.stderrTail) : '',
        };
    }

    async function closeAll() {
        say('[MCP] Shutting down all MCP connections');
        await Promise.all(Array.from(states.keys()).map((id) => disconnect(id, { silent: true })));
    }

    return { connect, disconnect, disconnectAllFor, reconnect, callTool, statusView, redact, registerSecrets, registerSecretValue, toolAllowed, closeAll, _states: states };
}

module.exports = { createMcpManager, normalizeEntry, assertUrlAllowed, transportKeyFor, DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_RESULT_CHARS };
