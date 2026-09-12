// patch-runs-ui.cjs — Agent runs visibility (phase 3):
//   1. chat body builder (1306/4124): send zap_conv_id from window.__zapConvId
//      next to the existing zap_mcp preference (server strips + uses it for
//      durable-run conversation attribution)
//   2. chat send thunk (1230.*): set window.__zapConvId from the in-scope
//      conversationId variable right before the BYOK branch
//   3. settings modal (1306/4124): "Agent runs" nav entry + panel switch case
//      + wrapper panel listing the user's runs, linking to /runs/<id>
//
// MUST run BEFORE bust-cache-admin.cjs. Followed by diag-all-runtime-integrity.
// Run: node patch-runs-ui.cjs

'use strict';

const fs = require('fs');
const path = require('path');

// this repo's dist (other patch scripts hardcode the stale ProtoLumo tree)
const STATIC = path.join(__dirname, 'lumo-dist', 'assets', 'static');

// ── 1306 / 4124 (settings + body builder; wrapper aliases differ per twin) ──
const TWIN_SUBS = (alias, wrapper) => [
    {
        name: 'chat-body-zap-conv-id',
        old: 'Array.isArray(window.__zapMcp)&&window.__zapMcp.length&&(a.zap_mcp={off:window.__zapMcp.slice(0,64)}),JSON.stringify(a)',
        new: 'Array.isArray(window.__zapMcp)&&window.__zapMcp.length&&(a.zap_mcp={off:window.__zapMcp.slice(0,64)}),window.__zapConvId&&(a.zap_conv_id=String(window.__zapConvId).slice(0,80)),JSON.stringify(a)',
        done: 'window.__zapConvId&&(a.zap_conv_id=',
    },
    {
        name: 'settings-nav-runs',
        old: '{id:"mcp-servers",icon:"Wrench",getText:()=>(0,o.c)("collider_2025: Settings Item").t`MCP Servers`,guest:!1}',
        new: '{id:"mcp-servers",icon:"Wrench",getText:()=>(0,o.c)("collider_2025: Settings Item").t`MCP Servers`,guest:!1},{id:"runs",icon:"Wrench",getText:()=>(0,o.c)("collider_2025: Settings Item").t`Agent runs`,guest:!1}',
        done: '{id:"runs",icon:"Wrench"',
    },
    {
        name: 'settings-switch-runs',
        old: `"mcp-servers"===s&&(0,a.jsx)(${wrapper},{})`,
        new: `"mcp-servers"===s&&(0,a.jsx)(${wrapper},{}),"runs"===s&&(0,a.jsx)(${alias},{})`,
        done: `"runs"===s&&(0,a.jsx)(${alias},{})`,
    },
    {
        name: 'settings-panel-runs',
        old: `let ${wrapper}=()=>{`,
        new: `let ${alias}=()=>{let _r=(0,n.useState)(null),runs=_r[0],setRuns=_r[1];(0,n.useEffect)(()=>{fetch("/api/lumo/v1/runs?limit=50").then(e=>e.json()).then(e=>{setRuns((e&&e.Runs)||[])}).catch(()=>{setRuns([])})},[]);return (0,a.jsx)("div",{style:{display:"flex",flexDirection:"column",gap:"10px"},children:[(0,a.jsx)("p",{style:{color:"#a7a4b5",fontSize:"13px",margin:"6px 0"},children:"Every agent run with its full tool audit trail (approval requests included). Opens in a new tab."}),null==runs&&(0,a.jsx)("p",{style:{color:"#a7a4b5",fontSize:"13px"},children:"Loading…"}),runs&&!runs.length&&(0,a.jsx)("p",{style:{color:"#a7a4b5",fontSize:"13px"},children:"No runs yet — they appear here after the agent uses a tool in one of your chats."}),runs&&runs.length&&(0,a.jsx)("table",{style:{width:"100%",borderCollapse:"collapse",fontSize:"13px"},children:[(0,a.jsx)("thead",{children:(0,a.jsx)("tr",{children:["status","model","conversation","tools","started"].map(h=>(0,a.jsx)("th",{style:{textAlign:"left",padding:"6px",color:"#a7a4b5"},children:h}))})}),(0,a.jsx)("tbody",{children:runs.map(r=>(0,a.jsxs)("tr",{children:[(0,a.jsx)("td",{style:{padding:"6px"},children:(0,a.jsx)("a",{href:"/runs/"+r.id,target:"_blank",rel:"noreferrer",style:{color:"#9d84ff"},children:r.status})}),(0,a.jsx)("td",{style:{padding:"6px"},children:r.model||""}),(0,a.jsx)("td",{style:{padding:"6px"},children:r.conversationId?String(r.conversationId).slice(0,14):"—"}),(0,a.jsx)("td",{style:{padding:"6px"},children:r.toolCalls??0}),(0,a.jsx)("td",{style:{padding:"6px"},children:String(r.startedAt||"").replace("T"," ").slice(0,19)})]}))})]})]})};let ${wrapper}=()=>{`,
        done: `${alias}=()=>{let _r=(0,n.useState)(null),runs=_r[0]`,
    },
];

// ── 1230.* (chat send thunk; conversationId is `u` in every variant that
// carries the BYOK branch — verified per-variant before patching) ─────────────
const SEND_OLD = 'if((0,j.bq)())return void await (0,j.qx)({turns:t,';
const SEND_NEW = 'if((0,j.bq)())return window.__zapConvId=u,void await (0,j.qx)({turns:t,';
const SEND_DONE = 'return window.__zapConvId=u,void await';

function apply(file, subs) {
    const p = `${STATIC}/${file}`;
    const src = fs.readFileSync(p, 'utf8');
    let out = src;
    const applied = [];
    for (const sub of subs) {
        if (out.includes(sub.done)) { applied.push(`${sub.name}: SKIP (done)`); continue; }
        const count = out.split(sub.old).length - 1;
        if (count !== 1) {
            console.error(`${file}: anchor for ${sub.name} matched ${count} times (expected 1)`);
            process.exit(1);
        }
        out = out.replace(sub.old, sub.new);
        applied.push(`${sub.name}: OK`);
    }
    try {
        new Function(out);
    } catch (e) {
        console.error(`${file}: patched source fails to parse: ${e.message}`);
        process.exit(1);
    }
    if (out !== src) fs.writeFileSync(p, out);
    console.log(`${file}: ${applied.join(', ')} (${src.length} -> ${out.length} chars)`);
}

// twins carry identical anchor text; patch both mirrors in lockstep
apply('1306.43935624.chunk.js', TWIN_SUBS('la5', 'la4'));
apply('4124.6ffe79b5.chunk.js', TWIN_SUBS('nG5', 'nG4'));

for (const f of fs.readdirSync(STATIC).filter((f) => f.startsWith('1230.') && f.endsWith('.chunk.js'))) {
    const src = fs.readFileSync(`${STATIC}/${f}`, 'utf8');
    if (!src.includes(SEND_OLD)) {
        console.log(`${f}: SKIP (no BYOK send anchor — variant without the chat thunk)`);
        continue;
    }
    apply(f, [{ name: 'send-thunk-zap-conv-id', old: SEND_OLD, new: SEND_NEW, done: SEND_DONE }]);
}
console.log('done — now run: node bust-cache-admin.cjs && node diag-all-runtime-integrity.cjs');
