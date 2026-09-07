// fake-mcp-http-server.cjs — minimal MCP Streamable-HTTP server for tests.
// Speaks just enough JSON-RPC (initialize / tools/list / tools/call / ping +
// notifications) over plain application/json responses for the official SDK's
// StreamableHTTPClientTransport. Tools carry MCP annotations so tests can
// exercise the read-only / write-capable policy classification. Optionally
// requires a specific Authorization header value (per-user auth tests) and
// records the last one seen (credential-injection proof). `failToolsList`
// makes tools/list error (after initialize succeeds) to exercise discovery
// failure.
'use strict';

const http = require('http');
const crypto = require('crypto');

const DEFAULT_TOOLS = [
    {
        name: 'echo',
        description: 'Echo the text back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        annotations: { readOnlyHint: true },
    },
    {
        name: 'delete_item',
        description: 'Deletes an item permanently',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        annotations: { readOnlyHint: false, destructiveHint: true },
    },
];

function createFakeMcpHttpServer({ name = 'fake-http-mcp', expectedHeader = null, tools = DEFAULT_TOOLS, failToolsList = false } = {}) {
    const state = { lastAuthHeader: null, requestCount: 0, initialized: false };
    let expected = expectedHeader;

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
        req.on('end', () => {
            state.lastAuthHeader = req.headers.authorization || null;
            state.requestCount += 1;

            if (req.method === 'DELETE') {
                // session termination — always fine
                res.writeHead(204);
                res.end();
                return;
            }
            if (req.method === 'GET') {
                // No standalone SSE stream: spec says return 405, which the
                // SDK client treats as "server has no GET stream" (not an error).
                res.writeHead(405);
                res.end();
                return;
            }
            if (expected !== null && state.lastAuthHeader !== expected) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: '401 Unauthorized: bad credentials' } }));
                return;
            }

            let msg = null;
            try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { msg = null; }
            if (Array.isArray(msg)) msg = msg[0]; // batching not needed by the SDK client
            if (!msg || typeof msg !== 'object') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } }));
                return;
            }

            const reply = (result) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
            };

            if (msg.method === 'initialize') {
                state.initialized = true;
                return reply({
                    protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
                    capabilities: { tools: {} },
                    serverInfo: { name, version: '1.0.0' },
                });
            }
            if (!msg.id) {
                // notification (e.g. notifications/initialized)
                res.writeHead(202);
                res.end();
                return;
            }
            if (msg.method === 'ping') return reply({});
            if (msg.method === 'tools/list') {
                if (failToolsList) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'tools/list exploded' } }));
                    return;
                }
                return reply({ tools });
            }
            if (msg.method === 'tools/call') {
                const tn = msg.params && msg.params.name;
                const args = (msg.params && msg.params.arguments) || {};
                if (tn === 'echo') return reply({ content: [{ type: 'text', text: `echo: ${args.text}` }], isError: false });
                if (tn === 'delete_item') return reply({ content: [{ type: 'text', text: `deleted ${args.id}` }], isError: false });
                return reply({ content: [{ type: 'text', text: `unknown tool ${tn}` }], isError: true });
            }
            return reply({});
        });
    });

    return {
        server,
        state,
        set expectedHeader(v) { expected = v; },
        listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)),
        // connected SDK clients hold keep-alive sockets server.close() would
        // wait on — drop them so tests that skip an explicit disconnect
        // (including suite teardown) cannot hang
        close: () => new Promise((r) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => r());
        }),
        port: () => server.address().port,
    };
}

module.exports = { createFakeMcpHttpServer };
