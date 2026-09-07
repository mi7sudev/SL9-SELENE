// stub-provider.cjs — OpenAI-compatible stub "provider" for the MCP proxy
// tests. Behavior keys off the requested model name so one instance serves
// every scenario. Records the last request body at GET /last for assertions.
'use strict';

const http = require('http');

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const endSse = (res) => { res.write('data: [DONE]\n\n'); res.end(); };

function pickDataTool(tools, suffix = '') {
    const list = (tools || []).filter((t) => t.function && !t.function.name.startsWith('lumo__'));
    if (suffix) return list.find((t) => t.function.name.endsWith(suffix)) || null;
    return list[0] || null;
}

// well-formed call target: the matching advertised tool, or (for unknown-tool
// scenarios) a fabricated `<server>__<suffix>` name the proxy will refuse
function resolveCallName(tools, suffix) {
    const hit = pickDataTool(tools, suffix);
    if (hit) return hit.function.name;
    const list = (tools || []).filter((t) => t.function && !t.function.name.startsWith('lumo__'));
    if (suffix) return (list[0] ? list[0].function.name.split('__')[0] : 'unknown') + suffix;
    return list[0] ? list[0].function.name : '';
}

function toolCallRounds(res, tools, { suffix = '', argsJson = '{"text":"hi from stub"}', id = 'call_stub_1' } = {}) {
    // Fragmented tool_call deltas (name and args split across chunks) to prove
    // the proxy accumulates fragments correctly.
    const name = resolveCallName(tools, suffix);
    const args = argsJson;
    sse(res, { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: name.slice(0, 4), arguments: '' } }] }, finish_reason: null }] });
    sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: name.slice(4), arguments: args.slice(0, Math.ceil(args.length / 2)) } }] }, finish_reason: null }] });
    sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(Math.ceil(args.length / 2)) } }] }, finish_reason: null }] });
    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    endSse(res);
}

const server = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
        server.lastBody = body;
        server.lastPath = req.url;
        res.setHeader('Content-Type', req.url.endsWith('/chat/completions') && body.stream ? 'text/event-stream' : 'application/json');

        const isChat = req.url.endsWith('/chat/completions');
        if (!isChat) {
            res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
            return;
        }
        const model = body.model || '';
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
        const hadToolResult = Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool');

        if (!body.stream) {
            // title generation / health test — must never carry tools
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `title-ok tools=${hasTools ? 'yes' : 'no'}` } }] }));
            return;
        }
        res.setHeader('Content-Type', 'text/event-stream');

        if (model === 'stub-rejects-tools') {
            if (hasTools) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'this provider does not support tools or functions', type: 'invalid_request_error' } }));
                return;
            }
            sse(res, { choices: [{ index: 0, delta: { content: 'ok-no-tools' }, finish_reason: null }] });
            sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            endSse(res);
            return;
        }
        if (model === 'stub-always-tools') {
            // never satisfied: exercises the round limit
            toolCallRounds(res, body.tools);
            return;
        }
        if (model === 'stub-tool-names') {
            // report the advertised data-plane tool names (control tools excluded)
            const names = pickDataTool(body.tools) === null && !(body.tools || []).length ? 'none'
                : (body.tools || []).filter((t) => t.function && !t.function.name.startsWith('lumo__')).map((t) => t.function.name).join(',') || 'none';
            sse(res, { choices: [{ index: 0, delta: { content: `NAMES:${names}` }, finish_reason: null }] });
            sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            endSse(res);
            return;
        }
        if (model === 'stub-call-list') {
            // one round calling the connections_list control tool, then final
            if (!hadToolResult && hasTools) {
                const ctl = (body.tools || []).find((t) => t.function && t.function.name === 'lumo__connections_list');
                if (ctl) {
                    sse(res, { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
                    sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_ctl_1', type: 'function', function: { name: 'lumo__', arguments: '' } }] }, finish_reason: null }] });
                    sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'connections_list', arguments: '{}' } }] }, finish_reason: null }] });
                    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
                    endSse(res);
                    return;
                }
            }
            const toolContents = (body.messages || []).filter((m) => m.role === 'tool').map((m) => m.content);
            sse(res, { choices: [{ index: 0, delta: { content: `FINAL:${toolContents.join('|')}` }, finish_reason: null }] });
            sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            endSse(res);
            return;
        }
        if (model === 'stub-call-echo' || model === 'stub-call-delete' || model === 'stub-call-unknown' || model === 'stub-call-echo-slow') {
            if (!hadToolResult && hasTools) {
                const suffix = model === 'stub-call-echo' || model === 'stub-call-echo-slow' ? '__echo' : model === 'stub-call-delete' ? '__delete_item' : '__nonexistent';
                const call = () => toolCallRounds(res, body.tools, {
                    suffix,
                    argsJson: model === 'stub-call-delete' ? '{"id":"x"}' : '{"text":"hi from stub"}',
                    id: model === 'stub-call-unknown' ? 'call_unknown_1' : 'call_stub_1',
                });
                // the slow variant delays the tool call so a mid-request
                // connection drop lands BETWEEN advertisement and execution
                if (model === 'stub-call-echo-slow') setTimeout(call, 400);
                else call();
                return;
            }
            const toolContents = (body.messages || []).filter((m) => m.role === 'tool').map((m) => m.content);
            sse(res, { choices: [{ index: 0, delta: { content: `FINAL:${toolContents.join('|')}` }, finish_reason: null }] });
            sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            endSse(res);
            return;
        }
        if (model.startsWith('stub-call-ctl:')) {
            // generic single control-tool call: 'stub-call-ctl:<toolName>:<argsJson>'
            // — lets tests drive lumo__connection_connect / _disconnect / _status
            // over the real proxy with exact arguments
            const rest = model.slice('stub-call-ctl:'.length);
            const sep = rest.indexOf(':');
            const toolName = sep >= 0 ? rest.slice(0, sep) : rest;
            const args = sep >= 0 ? rest.slice(sep + 1) : '{}';
            if (!hadToolResult && hasTools) {
                const ctl = (body.tools || []).find((t) => t.function && t.function.name === toolName);
                if (ctl) {
                    sse(res, { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
                    sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_ctl_1', type: 'function', function: { name: toolName, arguments: args } }] }, finish_reason: 'tool_calls' }] });
                    endSse(res);
                    return;
                }
            }
            const toolContents = (body.messages || []).filter((m) => m.role === 'tool').map((m) => m.content);
            sse(res, { choices: [{ index: 0, delta: { content: `FINAL:${toolContents.join('|')}` }, finish_reason: null }] });
            sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            endSse(res);
            return;
        }
        if (model === 'stub-roundtrip') {
            if (!hadToolResult && hasTools) {
                toolCallRounds(res, body.tools);
                return;
            }
            const toolContents = (body.messages || []).filter((m) => m.role === 'tool').map((m) => m.content);
            sse(res, { choices: [{ index: 0, delta: { content: `FINAL:${toolContents.join('|')}` }, finish_reason: null }] });
            sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            endSse(res);
            return;
        }
        // default: report whether tools were advertised
        sse(res, { choices: [{ index: 0, delta: { content: `TOOLS:${hasTools ? 'yes' : 'no'}` }, finish_reason: null }] });
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        endSse(res);
    });
});

module.exports = { listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)), close: () => new Promise((r) => server.close(r)), get lastBody() { return server.lastBody; } };

if (require.main === module) {
    const port = Number(process.argv[2]) || 8123;
    server.listen(port, '127.0.0.1', () => console.log(`stub provider on ${port}`));
}
