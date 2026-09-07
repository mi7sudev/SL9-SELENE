// fake-mcp-server.cjs — a minimal hand-rolled MCP server for the test suite.
// Speaks newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport),
// exposing two tools: `echo` (returns "echo: <text>") and `fail` (returns a
// tool error). Also advertises one resource and one prompt so discovery
// coverage is real. Not a demo — it exists so tests don't need network access.
'use strict';

const TOOL_LIST = {
    tools: [
        {
            name: 'echo',
            description: 'Echoes back the provided text',
            inputSchema: {
                type: 'object',
                properties: { text: { type: 'string', description: 'text to echo' } },
                required: ['text'],
            },
            annotations: { readOnlyHint: true },
        },
        {
            name: 'fail',
            description: 'Always returns a tool error',
            inputSchema: { type: 'object', properties: {} },
        },
    ],
};

function handle(req) {
    const { id, method, params } = req;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
        case 'initialize':
            return reply({
                protocolVersion: (params && params.protocolVersion) || '2024-11-05',
                capabilities: { tools: {}, resources: {}, prompts: {} },
                serverInfo: { name: 'fake-mcp', version: '1.0.0' },
            });
        case 'ping':
            return reply({});
        case 'tools/list':
            // FAKE_DIE_AFTER_LIST=1: answer discovery, then die before any
            // tool call — exercises the execution-time re-verification path
            // (a connection that drops between advertisement and execution)
            if (process.env.FAKE_DIE_AFTER_LIST === '1') setTimeout(() => process.exit(0), 50);
            return reply(TOOL_LIST);
        case 'tools/call': {
            const name = params && params.name;
            const args = (params && params.arguments) || {};
            if (name === 'echo') {
                return reply({ content: [{ type: 'text', text: `echo: ${args.text}` }] });
            }
            if (name === 'fail') {
                return reply({ content: [{ type: 'text', text: 'simulated tool failure' }], isError: true });
            }
            return err(-32602, `unknown tool: ${name}`);
        }
        case 'resources/list':
            return reply({ resources: [{ uri: 'fake://doc', name: 'Fake doc' }] });
        case 'prompts/list':
            return reply({ prompts: [{ name: 'fake_prompt', description: 'A fake prompt' }] });
        default:
            return id === undefined || id === null ? null : err(-32601, `method not found: ${method}`);
    }
}

process.stderr.write('fake-mcp-server ready\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        const res = handle(req);
        if (res) process.stdout.write(JSON.stringify(res) + '\n');
    }
});
process.stdin.on('end', () => process.exit(0));
