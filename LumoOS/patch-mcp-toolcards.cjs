// patch-mcp-toolcards.cjs — native tool-card rendering for MCP tool calls in
// BYOK chats.
//
// lumo-server.cjs's MCP tool loop emits synthetic OpenAI SSE frames whose
// delta carries a `zap_tool` field ({id,name,status,args,result}). This patch
// teaches the BYOK client (module 35026 in the 1306/4124 settings chunks) to
// consume them:
//   1. the SSE parser yields {zapTool} for such frames;
//   2. the stream consumer forwards them as the SAME chunk events Lumo's own
//      client-tools path uses (token_data/tool_call with content
//      {id,name,arguments} on "start", token_data/tool_result with the raw
//      result string on "done"/"error") — so the native tool-call timeline
//      renders them as collapsible tool cards.
// Stock (unpatched) clients ignore zap_tool frames entirely: the delta field
// is dropped by the untouched parser. The frames also cannot be forged by
// model text — the model can only emit `content` strings.
//
// Apply after patch-thinking-mode.cjs, then run bust-cache-admin.cjs +
// diag-all-runtime-integrity.cjs (see AGENTS.md).
const fs = require('fs');

const STATIC = 'D:/ProtoLumo/WebClients/applications/lumo/dist/assets/static';
const CHUNKS = ['1306.43935624.chunk.js', '4124.6ffe79b5.chunk.js'];

// Parser: yield tool events before the content-extraction helper.
const PARSER_OLD = 'if(!t)continue;let a=function(e)';
const PARSER_NEW = 'if(!t)continue;if(t.zap_tool){yield{zapTool:t.zap_tool};continue}let a=function(e)';
const PARSER_DONE = 'yield{zapTool:t.zap_tool}';

// Consumer: map tool events to the native chunk shapes (count: 0 matches
// Lumo's own client.ts; the reducers derive everything else from content).
const zapBranch =
    'e.zapTool&&("start"===e.zapTool.status?' +
    'await (null==r?void 0:r({type:"token_data",target:"tool_call",count:0,content:JSON.stringify({id:e.zapTool.id||"",name:e.zapTool.name,arguments:e.zapTool.args&&"object"==typeof e.zapTool.args?e.zapTool.args:{}})})):' +
    'await (null==r?void 0:r({type:"token_data",target:"tool_result",count:0,content:"string"==typeof e.zapTool.result?e.zapTool.result:"The tool call failed."}))),';
const CONSUMER_DONE = 'e.zapTool&&("start"===e.zapTool.status?';
// the two mirror chunks use different accumulator names in the consumer loop
const CONSUMER_VARIANTS = [
    { flag: 'p', chunk: '1306.43935624.chunk.js' },
    { flag: 'h', chunk: '4124.6ffe79b5.chunk.js' },
];

function apply(file, subs) {
    const src = fs.readFileSync(`${STATIC}/${file}`, 'utf8');
    let out = src;
    const applied = [];
    for (const sub of subs) {
        if (sub.done && out.includes(sub.done)) { applied.push(`${sub.name}: SKIP (done)`); continue; }
        const count = out.split(sub.old).length - 1;
        if (count !== 1) {
            console.error(`${file}: anchor for ${sub.name} matched ${count} times (expected 1)`);
            process.exit(1);
        }
        out = out.replace(sub.old, sub.new);
        applied.push(`${sub.name}: OK`);
    }
    try {
        // syntax gate — same contract as the other patch scripts
        new Function(out);
    } catch (e) {
        console.error(`${file}: patched source fails to parse: ${e.message}`);
        process.exit(1);
    }
    if (out !== src) fs.writeFileSync(`${STATIC}/${file}`, out);
    console.log(`${file}: ${applied.join(', ')} (${src.length} -> ${out.length} chars)`);
}

for (const file of CHUNKS) {
    const variant = CONSUMER_VARIANTS.find((v) => v.chunk === file);
    const consumerOld = `for await(let e of o(d,n))${variant.flag}=!0,e.reasoning`;
    apply(file, [
        { name: 'parser', old: PARSER_OLD, new: PARSER_NEW, done: PARSER_DONE },
        { name: 'consumer', old: consumerOld, new: `for await(let e of o(d,n))${variant.flag}=!0,${zapBranch}e.reasoning`, done: CONSUMER_DONE },
    ]);
}
console.log('tool-card patch complete');
