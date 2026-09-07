// Answer Mode (Fast/Thinking) for BYOK requests.
//
// Semantics (v2): both modes think; the mode controls depth, on any model from
// any provider.
//   Fast     -> plain request (model's normal/default reasoning)
//   Thinking -> reasoning_effort:"high" + a deep-think system nudge prepended
//               to the upstream request only (reasoning_effort is honored by
//               providers that support it; the nudge guarantees deeper
//               reasoning on models without an effort knob).
// Conversation-title generation is pinned to Fast (window.__zapThink = false).
//
// Files patched:
//   1230.261bf133.chunk.js / 1230.ee7c6db9.chunk.js / 1230.d0bcdeab.chunk.js
//     - pass enableReasoning into the (0,j.qx)({...}) BYOK call
//   1306.43935624.chunk.js / 4124.6ffe79b5.chunk.js
//     - sender entry stores window.__zapThink; body builder maps the mode;
//       title generator pins it to false.

const fs = require('fs');
const path = require('path');

const STATIC = path.join(__dirname, 'WebClients', 'applications', 'lumo', 'dist', 'assets', 'static');

const DEEP_NUDGE = 'Deep think: reason through this request as thoroughly and deeply as possible before answering. Explore the problem carefully, weigh alternatives and edge cases, and double-check your reasoning.';

const S_ORIGINAL = 'function s(e,t,r){let a={model:e.model,messages:t,stream:r};return e.disableThinking&&(a.chat_template_kwargs={thinking:!1}),JSON.stringify(a)}';
const S_V1 = 'function s(e,t,r){let a={model:e.model,messages:t,stream:r};return!window.__zapThink&&e.disableThinking&&(a.chat_template_kwargs={thinking:!1}),JSON.stringify(a)}';
const S_V2_SIMPLE = `function s(e,t,r){let a={model:e.model,messages:t,stream:r};return window.__zapThink&&(a.reasoning_effort="high",a.messages=[{role:"system",content:${JSON.stringify(DEEP_NUDGE)}}].concat(a.messages)),JSON.stringify(a)}`;
// Merge variant: if the conversation already leads with a system message, fold
// the nudge into it instead of adding a second system message (some strict
// providers accept only one). Works on every model from every provider.
const S_V2_MERGE = 'function s(e,t,r){let a={model:e.model,messages:t,stream:r};return window.__zapThink&&(a.reasoning_effort="high",a.messages=a.messages.length&&"system"===a.messages[0].role?[{role:"system",content:a.messages[0].content+"\\n\\n"+' + JSON.stringify(DEEP_NUDGE) + '}].concat(a.messages.slice(1)):[{role:"system",content:' + JSON.stringify(DEEP_NUDGE) + '}].concat(a.messages)),JSON.stringify(a)}';
const S_DONE = 'a.messages.length&&"system"===a.messages[0].role';

const D_ORIGINAL = 'async function d(e){let t=(0,n.Kd)(),{turns:r,chunkCallback:a,finishCallback:l,signal:i,generateTitle:s=!1}=e';
const D_PATCHED = 'async function d(e){window.__zapThink=!!e.enableReasoning;let t=(0,n.Kd)(),{turns:r,chunkCallback:a,finishCallback:l,signal:i,generateTitle:s=!1}=e';

const M_ORIGINAL = 'async function m(e){let{signal:t}=arguments.length>1&&void 0!==arguments[1]?arguments[1]:{},r=(0,n.Kd)()';
const M_PATCHED = 'async function m(e){window.__zapThink=!1;let{signal:t}=arguments.length>1&&void 0!==arguments[1]?arguments[1]:{},r=(0,n.Kd)()';

const PATCHES = [
    {
        f: '1230.261bf133.chunk.js',
        subs: [
            {
                old: '(0,j.qx)({turns:t,chunkCallback:b.chunkCallback,finishCallback:b.finishCallback,signal:b.signal,generateTitle:b.generateTitle})',
                neu: '(0,j.qx)({turns:t,chunkCallback:b.chunkCallback,finishCallback:b.finishCallback,signal:b.signal,generateTitle:b.generateTitle,enableReasoning:b.enableReasoning??!1})',
                done: 'enableReasoning:b.enableReasoning??!1',
            },
        ],
    },
    {
        f: '1230.ee7c6db9.chunk.js',
        subs: [
            {
                old: '(0,j.qx)({turns:t,chunkCallback:b.chunkCallback,finishCallback:b.finishCallback,signal:b.signal,generateTitle:b.generateTitle})',
                neu: '(0,j.qx)({turns:t,chunkCallback:b.chunkCallback,finishCallback:b.finishCallback,signal:b.signal,generateTitle:b.generateTitle,enableReasoning:b.enableReasoning??!1})',
                done: 'enableReasoning:b.enableReasoning??!1',
            },
        ],
    },
    {
        f: '1230.d0bcdeab.chunk.js',
        subs: [
            {
                old: '(0,j.qx)({turns:t,chunkCallback:C,finishCallback:E,signal:b.signal,generateTitle:b.generateTitle})',
                neu: '(0,j.qx)({turns:t,chunkCallback:C,finishCallback:E,signal:b.signal,generateTitle:b.generateTitle,enableReasoning:b.enableReasoning??!1})',
                done: 'enableReasoning:b.enableReasoning??!1',
            },
        ],
    },
    {
        f: '1306.43935624.chunk.js',
        subs: [
            { old: D_ORIGINAL, neu: D_PATCHED, done: 'window.__zapThink=!!e.enableReasoning' },
            { old: S_ORIGINAL, neu: S_V2_MERGE, v1: S_V1, alts: [S_V1, S_V2_SIMPLE], done: S_DONE },
            { old: M_ORIGINAL, neu: M_PATCHED, done: 'window.__zapThink=!1;let{signal:t}' },
        ],
    },
    {
        f: '4124.6ffe79b5.chunk.js',
        subs: [
            { old: D_ORIGINAL, neu: D_PATCHED, done: 'window.__zapThink=!!e.enableReasoning' },
            { old: S_ORIGINAL, neu: S_V2_MERGE, v1: S_V1, alts: [S_V1, S_V2_SIMPLE], done: S_DONE },
            { old: M_ORIGINAL, neu: M_PATCHED, done: 'window.__zapThink=!1;let{signal:t}' },
        ],
    },
];

let failures = 0;
for (const p of PATCHES) {
    const fp = path.join(STATIC, p.f);
    let src = fs.readFileSync(fp, 'utf8');
    let changed = 0;
    for (const sub of p.subs) {
        if (src.includes(sub.done)) {
            console.log(`SKIP ${p.f}: already has ${sub.done.slice(0, 50)}`);
            continue;
        }
        let target = null;
        if (src.includes(sub.old)) target = sub.old;
        else if (sub.v1 && src.includes(sub.v1)) target = sub.v1;
        else if (sub.alts) {
            for (const alt of sub.alts) {
                if (src.includes(alt)) { target = alt; break; }
            }
        }
        if (!target) {
            console.error(`FAIL ${p.f}: no anchor (expected original or v1): ${sub.old.slice(0, 70)}...`);
            failures++;
            continue;
        }
        const count = src.split(target).length - 1;
        if (count !== 1) {
            console.error(`FAIL ${p.f}: anchor found ${count} times (expected 1): ${target.slice(0, 70)}...`);
            failures++;
            continue;
        }
        src = src.replace(target, sub.neu);
        changed++;
    }
    if (failures) continue;
    if (!changed) {
        console.log(`OK   ${p.f} (already current)`);
        continue;
    }
    try {
        new Function(src);
    } catch (e) {
        console.error(`FAIL ${p.f}: syntax gate error: ${e.message}`);
        failures++;
        continue;
    }
    fs.writeFileSync(fp, src);
    console.log(`OK   ${p.f} (${changed} substitutions, syntax clean)`);
}

if (failures) {
    console.error(`\n${failures} failure(s) — earlier successes were kept. Re-run after fixing.`);
    process.exit(1);
}
console.log('\nAnswer-Mode patches are current (v2: Fast=normal thinking, Thinking=deep think).');
