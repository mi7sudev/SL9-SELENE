#!/usr/bin/env node
// patch-mcp-promptbar.cjs — MCP connections in the chat composer's Tools menu
// (third view in the existing ToolMenuDropdown popover) plus the request-scoped
// mute field (zap_mcp) in the BYOK body builder.
//
// What it does:
//   - 1306/4124 body builder: when window.__zapMcp is a non-empty array of
//     muted connection ids, add zap_mcp:{off:[...]} to the request body
//     (server strips it before forwarding; absent field = byte-identical body).
//   - 4206 ToolMenuDropdown: injects the connection catalog state (fetch
//     /api/lumo/v1/mcp/connections, account-stamped localStorage preference
//     lumo.mcp.disabled.v1, cross-tab sync via storage events), a main-view
//     row, and the 'mcp' sub-view with per-connection status + toggles.
//
// Contract (same as the other patch scripts): exact-once anchors, done
// markers, new Function syntax gate, patches every on-disk variant of each
// chunk index, writes patch-mcp-promptbar.manifest.json (sha256 before/after
// per file) for rollback/health. MUST run AFTER patch-thinking-mode.cjs (the
// body-builder anchor is that patch's output).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATIC = 'D:/ProtoLumo/WebClients/applications/lumo/dist/assets/static';
const MANIFEST_FILE = 'D:/ProtoLumo/patch-mcp-promptbar.manifest.json';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const listChunkVariants = (prefix) =>
    fs.readdirSync(STATIC).filter((f) => f.startsWith(prefix + '.') && f.endsWith('.chunk.js')).sort();

// ── injected prompt-bar code (plain ES2020, no template literals) ────────────

// The .zap-dot* rules are owned by patch-admin-ui.cjs (ZADMIN_CSS) and
// extracted here so both surfaces share one definition and can never drift
// (same single-source convention as patch-v25-providers.cjs).
const ADMIN_UI_SRC = fs.readFileSync('D:/ProtoLumo/patch-admin-ui.cjs', 'utf8');
const cssMatch = ADMIN_UI_SRC.match(/const ZADMIN_CSS = ([\s\S]*?);\r?\n/);
if (!cssMatch) throw new Error('ZADMIN_CSS const not found in patch-admin-ui.cjs');
const ZADMIN_CSS_EVAL = new Function('const ZADMIN_CSS = ' + cssMatch[1] + '; return ZADMIN_CSS;')();
const dotIdx = ZADMIN_CSS_EVAL.indexOf('.zap-dot');
if (dotIdx < 0) throw new Error('.zap-dot rules missing from ZADMIN_CSS (patch-admin-ui.cjs)');
// prompt-bar supplement: rows are flex children, the dot must not shrink/collapse
const MCP_CSS = ZADMIN_CSS_EVAL.slice(dotIdx) + '.zap-dot{display:inline-block}';

// State chain entries + the mcp sub-view component. Aliases used (all in the
// ToolMenuDropdown module scope): s=React, n=jsx runtime, lu=DropdownMenuButton,
// lm=Toggle, g.z=LumoIcon. Names are zap-prefixed to avoid any collision.
const CHAIN_INJECT = [
    'zapConn=(0,s.useState)({loading:true,error:false,list:[]}),zapConnV=zapConn[0],zapConnS=zapConn[1]',
    'zapMuted=(0,s.useState)([]),zapMutedV=zapMuted[0],zapMutedS=zapMuted[1]',
    'zapTick=(0,s.useState)(0),zapTickV=zapTick[0],zapTickS=zapTick[1]',
    // refetch the catalog every time the menu opens (isOpen prop = t): servers
    // the admin adds while the app is open must appear without a reload
    'zapOpenEff=(0,s.useEffect)(function(){if(t)zapTickS(function(x){return x+1})},[t])',
    // global .zap-dot styles (the admin panel\'s copy only mounts with it)
    'zapCssEff=(0,s.useEffect)(function(){if(!document.getElementById("zap-mcp-css")){var st=document.createElement("style");st.id="zap-mcp-css";st.textContent=' + JSON.stringify(MCP_CSS) + ';document.head.appendChild(st)}},[])',
    // catalog fetch + account-stamped preference hydration
    'zapFetchEff=(0,s.useEffect)(function(){var alive=true;'
        + 'fetch("/api/lumo/v1/mcp/connections").then(function(r){if(!r.ok)throw new Error("http "+r.status);return r.json()})'
        + '.then(function(j){if(!alive)return;'
        + 'var ids={};(j.Connections||[]).forEach(function(c){ids[c.Id]=1});'
        + 'var muted=[],pref=null;try{pref=JSON.parse(localStorage.getItem("lumo.mcp.disabled.v1")||"null")}catch(_){pref=null}'
        + 'if(pref&&Array.isArray(pref.muted))muted=pref.muted.filter(function(x){return typeof x==="string"&&ids[x]});'
        + 'if(pref&&pref.account!==j.Account)muted=[];' // account switch -> reset
        + 'try{localStorage.setItem("lumo.mcp.disabled.v1",JSON.stringify({account:j.Account,muted:muted}))}catch(_){}'
        + 'zapMutedS(muted);window.__zapMcp=muted;'
        + 'zapConnS({loading:false,error:false,account:j.Account,list:j.Connections||[]})'
        + '}).catch(function(){if(alive)zapConnS({loading:false,error:true,list:[]})});'
        + 'var ev=function(e){if(e&&e.key==="lumo.mcp.disabled.v1"&&e.newValue){try{var p=JSON.parse(e.newValue);window.__zapMcp=p&&Array.isArray(p.muted)?p.muted.filter(function(x){return typeof x==="string"}):[]}catch(_){}}};'
        + 'window.addEventListener("storage",ev);'
        + 'return function(){alive=false;window.removeEventListener("storage",ev)}'
        + '},[zapTickV])',
    'zapToggle=(0,s.useCallback)(function(id){'
        + 'var next=zapMutedV.indexOf(id)===-1?zapMutedV.concat([id]):zapMutedV.filter(function(x){return x!==id});'
        + 'try{localStorage.setItem("lumo.mcp.disabled.v1",JSON.stringify({account:zapConnV.account,muted:next}))}catch(_){}'
        + 'zapMutedS(next);window.__zapMcp=next'
        + '},[zapMutedV,zapConnV])',
    'zapMcpView=function(e){'
        + 'var rows=e.conns.error'
        + '?(0,n.jsxs)("div",{className:"px-4 py-2 text-xs color-hint",children:[(0,n.jsx)("span",{className:"zap-dot zap-dot-error","aria-hidden":"true"})," MCP connections unavailable — ",(0,n.jsx)("button",{className:"underline",onClick:e.onRetry,children:"Retry"})]})'
        + ':!e.conns.list.length?(0,n.jsx)("div",{className:"px-4 py-2 text-xs color-hint",children:"No MCP connections"})'
        + ':e.conns.list.map(function(c){'
        + 'var mutedHere=e.muted.indexOf(c.Id)!==-1;'
        + 'var st=c.Status==="ready"?"Ready":c.Status==="authorizing"?"Authorizing…":c.Status==="needs_reauth"?"Needs sign-in":(c.Status==="unavailable"||c.Status==="failed")?"Unavailable":c.Status==="not_discovered"?"Not checked":"Available";'
        + 'var dot=c.Status==="ready"?"zap-dot zap-dot-connected":(c.Status==="authorizing"||c.Status==="needs_reauth")?"zap-dot zap-dot-connecting":(c.Status==="unavailable"||c.Status==="failed")?"zap-dot zap-dot-error":"zap-dot";'
        + 'var tools=Array.isArray(c.Tools)?c.Tools.slice(0,3).join(", ")+(c.Tools.length>3?" +"+(c.Tools.length-3)+" more":""):"";'
        + 'return (0,n.jsxs)("div",{className:"px-4 py-2 flex items-center gap-3",style:{opacity:mutedHere?0.4:1},children:['
        + '(0,n.jsx)("span",{className:dot,role:"img","aria-label":st}),'
        + '(0,n.jsxs)("div",{className:"flex-1 min-w-0",children:['
        + '(0,n.jsx)("div",{className:"text-sm font-medium truncate",children:c.Name}),'
        + '(0,n.jsx)("div",{className:"text-xs color-hint truncate",children:tools?st+" · "+tools:st})]}),'
        + '(0,n.jsx)(lm.A,{checked:!mutedHere,onChange:function(){e.onToggle(c.Id)}})]},c.Id)});'
        + 'return (0,n.jsxs)("div",{children:['
        + '(0,n.jsx)(lu.A,{className:"justify-start",onClick:e.onBack,children:(0,n.jsxs)("div",{className:"flex items-center gap-2 w-full",children:[(0,n.jsx)(g.z,{name:"ChevronLeft",size:16}),(0,n.jsx)("span",{className:"text-sm font-medium",children:"MCP connections"})]})})'
        + ',rows'
        + ',(0,n.jsx)("div",{className:"px-4 py-2 text-xs color-hint",children:"Managed by your administrator in Settings → AI Provider. Toggle off to hide a connection\'s tools from your chats. All off = MCP off."})]})'
        + '}',
].join(',');

// main-view row, appended after the Connectors row (same shape as that row,
// including the trailing chevron; error state offers Retry instead of nav)
const MCP_ROW = '(zapConnV.list.length>0||zapConnV.error)&&(0,n.jsx)(lu.A,{className:"justify-start",'
    + 'onClick:function(){zapConnV.error?zapTickS(function(x){return x+1}):L("mcp")},'
    + 'children:(0,n.jsxs)("div",{className:"flex items-center gap-3 w-full",children:['
    + '(0,n.jsx)("span",{className:"shrink-0 flex",children:(0,n.jsx)(g.z,{name:"Blocks",size:16})}),'
    + '(0,n.jsx)("span",{className:"text-sm font-medium flex-1 text-left",children:zapConnV.error?"MCP connections unavailable":"MCP connections ("+zapConnV.list.length+")"}),'
    + '(0,n.jsx)(g.z,{name:"ChevronRight",size:16})]})})';

// previous MCP_ROW (pre-consistency pass) — on-disk chunks may still carry it
const OLD_MCP_ROW = '(zapConnV.list.length>0||zapConnV.error)&&(0,n.jsx)(lu.A,{className:"justify-start",'
    + 'onClick:function(){zapConnV.error?zapTickS(function(x){return x+1}):L("mcp")},'
    + 'children:(0,n.jsxs)("div",{className:"flex items-center gap-3 w-full",children:['
    + '(0,n.jsx)("span",{className:"shrink-0 flex",children:(0,n.jsx)(g.z,{name:"Blocks",size:16})}),'
    + '(0,n.jsx)("span",{className:"text-sm font-medium flex-1 text-left",children:zapConnV.error?"MCP connections unavailable":"MCP connections ("+zapConnV.list.length+")"})]})})';

// ── patch definitions ─────────────────────────────────────────────────────────

// 1306/4124: body builder (post patch-thinking-mode shape)
const BODY_ANCHOR = '.concat(a.messages)),JSON.stringify(a)}';
const BODY_REPLACEMENT = '.concat(a.messages)),Array.isArray(window.__zapMcp)&&window.__zapMcp.length&&(a.zap_mcp={off:window.__zapMcp.slice(0,64)}),JSON.stringify(a)}';

// 4206 ToolMenuDropdown (live variant 4206.9903be83). The injected chain sits
// between CHAIN_START (original hook-descriptor tail) and CHAIN_END (the
// original `p=(0,el.w)()` call that immediately followed it).
const TMD_CHAIN_START = 'isWebSearchButtonToggled:u,handleWebSearchButtonClick:m}=(0,et.A)(),';
const TMD_CHAIN_END = ',p=(0,el.w)(),';

// chain patch: the injected chain always sits between the two stable module
// boundaries. Fresh chunks get an insert; chunks carrying any earlier variant
// of the chain get a wholesale re-splice, and the main-view row is swapped if
// it predates the consistency pass.
function applyChain(src) {
    const count = src.split(TMD_CHAIN_START).length - 1;
    if (count !== 1) throw new Error('chain start anchor not unique (count ' + count + ')');
    const i = src.indexOf(TMD_CHAIN_START) + TMD_CHAIN_START.length;
    let statuses = [];
    if (src.startsWith(CHAIN_INJECT, i)) {
        statuses.push('chain: already-patched');
    } else if (src.startsWith('zapConn=', i)) {
        const j = src.indexOf(TMD_CHAIN_END, i);
        if (j < 0) throw new Error('chain end anchor not found after start');
        src = src.slice(0, i) + CHAIN_INJECT + src.slice(j);
        statuses.push('chain: re-spliced');
    } else {
        // fresh chunk: insert the chain; the tmd-main-row patch adds the row after
        src = src.slice(0, i) + CHAIN_INJECT + src.slice(i);
        return { src, status: 'chain: patched' };
    }
    if (src.includes(MCP_ROW)) statuses.push('row: already-patched');
    else {
        if (!src.includes(OLD_MCP_ROW)) throw new Error('MCP row not found (neither current nor previous)');
        if (src.split(OLD_MCP_ROW).length - 1 !== 1) throw new Error('old MCP row not unique');
        src = src.replace(OLD_MCP_ROW, MCP_ROW);
        statuses.push('row: swapped');
    }
    return { src, status: statuses.join(', ') };
}
const TMD_VIEW_ANCHOR = 'children:"connectors"===S?(0,n.jsx)(lh,{onBack:()=>L("main")})';
const TMD_VIEW_REPLACEMENT = 'children:"mcp"===S?(0,n.jsx)(zapMcpView,{onBack:function(){L("main")},onRetry:function(){zapTickS(function(x){return x+1})},conns:zapConnV,muted:zapMutedV,onToggle:zapToggle}):"connectors"===S?(0,n.jsx)(lh,{onBack:()=>L("main")})';
const TMD_ROW_ANCHOR = 'E&&(0,n.jsx)(lu.A,{className:"justify-start",onClick:()=>L("connectors"),children:(0,n.jsxs)("div",{className:"flex items-center gap-3 w-full",children:[(0,n.jsx)("span",{className:"shrink-0 flex",children:(0,n.jsx)(g.z,{name:"Blocks",size:16})}),(0,n.jsx)("span",{className:"text-sm font-medium flex-1 text-left",children:(0,o.c)("collider_2025: Action").t`Connectors`}),(0,n.jsx)(g.z,{name:"ChevronRight",size:16})]})})';
const TMD_ROW_REPLACEMENT = TMD_ROW_ANCHOR + ',' + MCP_ROW;

// ── applier (two-phase, atomic, self-rolling-back) ────────────────────────────
// Phase 1 plans every file in memory (read + apply + syntax-check): a failure
// here writes nothing at all. Phase 2 writes each changed file via
// temp-file+rename and verifies the sha256 readback; if any write or
// verification fails, every already-written file is restored from its in-memory
// original before failing. A crash can therefore never leave a torn chunk or a
// half-applied patch set behind. The manifest is written only after a fully
// successful deploy, so it always describes the on-disk state.

function apply(src, p) {
    if (p.chain) return applyChain(src);
    if (src.includes(p.marker)) return { src, status: 'already-patched' };
    const count = src.split(p.anchor).length - 1;
    if (count !== 1) return { src, status: 'anchor-count-' + count };
    return { src: src.replace(p.anchor, p.replacement), status: 'patched' };
}

function planFile(file, patches) {
    const full = path.join(STATIC, file);
    const before = fs.readFileSync(full, 'utf8');
    let src = before;
    const statuses = [];
    for (const p of patches) {
        const r = apply(src, p);
        src = r.src;
        statuses.push({ name: p.name, status: r.status });
    }
    const changed = src !== before;
    if (changed) {
        try { new Function(src); } catch (e) {
            throw new Error(`${file}: patched output fails syntax check: ${e.message}`);
        }
    }
    return { file, full, before, after: src, changed, shaBefore: sha256(before), shaAfter: sha256(src), statuses };
}

function atomicWrite(full, content) {
    const tmp = `${full}.ztmp-${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, full);
}

function deploy(plans) {
    const written = [];
    try {
        for (const p of plans) {
            if (!p.changed) continue;
            atomicWrite(p.full, p.after);
            written.push(p);
            if (sha256(fs.readFileSync(p.full, 'utf8')) !== p.shaAfter) {
                throw new Error(`${p.file}: post-write verification failed`);
            }
        }
    } catch (e) {
        for (const p of written) {
            try {
                atomicWrite(p.full, p.before);
                console.error(`ROLLED BACK: ${p.file}`);
            } catch (e2) {
                console.error(`ROLLBACK FAILED for ${p.file}: ${e2.message} — restore it from source control`);
            }
        }
        throw e;
    }
}

const manifest = { script: 'patch-mcp-promptbar.cjs', appliedAt: new Date().toISOString(), files: [] };
const plans = [];
let sawPromptbar = false;
let sawBodyBuilder = false;

for (const f of listChunkVariants('4206')) {
    const p = planFile(f, [
        { name: 'tmd-state-chain', chain: true },
        { name: 'tmd-mcp-view', marker: '"mcp"===S?(0,n.jsx)(zapMcpView', anchor: TMD_VIEW_ANCHOR, replacement: TMD_VIEW_REPLACEMENT },
        { name: 'tmd-main-row', marker: 'MCP connections (', anchor: TMD_ROW_ANCHOR, replacement: TMD_ROW_REPLACEMENT },
    ]);
    plans.push(p);
    manifest.files.push({ file: p.file, changed: p.changed, shaBefore: p.shaBefore, shaAfter: p.shaAfter, statuses: p.statuses });
    // failures throw inside apply(); any returned status is a success state
    const ok = p.statuses.every((s) => !/anchor-count|not unique|not found/i.test(String(s.status)));
    if (ok) sawPromptbar = true;
    console.log(`${f}: ${p.statuses.map((s) => `${s.name}: ${s.status}`).join(', ')}`);
}

for (const prefix of ['1306', '4124']) {
    for (const f of listChunkVariants(prefix)) {
        const p = planFile(f, [
            { name: 'body-builder-zap_mcp', marker: 'zap_mcp={off:', anchor: BODY_ANCHOR, replacement: BODY_REPLACEMENT },
        ]);
        plans.push(p);
        manifest.files.push({ file: p.file, changed: p.changed, shaBefore: p.shaBefore, shaAfter: p.shaAfter, statuses: p.statuses });
        const ok = p.statuses.every((s) => !/anchor-count|not unique|not found/i.test(String(s.status)));
        if (ok) sawBodyBuilder = true;
        console.log(`${f}: ${p.statuses.map((s) => `${s.name}: ${s.status}`).join(', ')}`);
    }
}

if (!sawPromptbar || !sawBodyBuilder) {
    console.error('PATCH FAIL: required chunks were not patched (promptbar=' + sawPromptbar + ', bodyBuilder=' + sawBodyBuilder + ') — nothing was written');
    process.exit(1);
}

try {
    deploy(plans);
} catch (e) {
    console.error(`PATCH FAIL: ${e.message} — written files were restored to their original content`);
    process.exit(1);
}

fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
console.log(`manifest: ${MANIFEST_FILE}`);
console.log('patch-mcp-promptbar: OK');
