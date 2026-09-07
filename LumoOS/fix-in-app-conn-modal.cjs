// Add in-app connection modal to the MCP Servers settings tab.
// For servers with auth=api_key: shows a password input for the API key.
// For servers with auth=oauth: shows an "Authorize" button that opens the URL.
// Also adds a "Disconnect account" button for servers with active connections.
//
// This replaces the external HTML setup page (/mcp/setup/<flow>) with an
// in-app modal, making the connection flow fully integrated with the Lumo UI.
const fs = require('fs');
const crypto = require('crypto');

const DIST = process.env.LUMO_DIST_DIR || '/home/z/my-project/LumoOS/lumo-dist';
const STATIC = `${DIST}/assets/static`;
const VERSION = 'v=59';
const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

// The ZMcpPanel is injected into both 1306 and 4124. We need to add:
// 1. A connModal state (_cm)
// 2. Functions: openConnModal, closeConnModal, submitConnModal, disconnectAccount
// 3. A "Connect account" / "Disconnect account" button in the server card
// 4. The modal JSX (before the closing of the return)

const TARGETS = ['1306.43935624.chunk.js', '4124.6ffe79b5.chunk.js'];

// State to add (after the existing _pd state for ddOpen)
const STATE_OLD = '_pd=(0,n.useState)(null),ddOpen=_pd[0],setDdOpen=_pd[1];';
const STATE_NEW = '_pd=(0,n.useState)(null),ddOpen=_pd[0],setDdOpen=_pd[1],_cm=(0,n.useState)(null),connModal=_cm[0],setConnModal=_cm[1];';

// Functions to add (after mcpExport)
const FUNCS_OLD = 'var dd=function(id,small,label,items,onPick)';
const FUNCS_NEW = `var openConnModal=function(s){setConnModal({serverId:s.id,name:s.name||s.id,auth:s.auth||"none",apiKey:"",authorizeUrl:null,busy:!1,result:null})};
var closeConnModal=function(){setConnModal(null)};
var submitConnModal=function(){var f=connModal;if(!f)return;setConnModal(Object.assign({},f,{busy:!0,result:null}));fetch("/api/lumo/v1/mcp/connections/connect",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({serverId:f.serverId,apiKey:f.apiKey||void 0})}).then(function(r){return r.ok?r.json():null}).then(function(j){if(!j){setConnModal(Object.assign({},f,{busy:!1,result:{ok:!1,msg:"Network error"}}));return}if(j.ok&&j.authorizeUrl){setConnModal(Object.assign({},f,{busy:!1,authorizeUrl:j.authorizeUrl,result:{ok:!0,msg:"Authorization started — click the link to authorize."}}))}else if(j.ok){setConnModal(Object.assign({},f,{busy:!1,result:{ok:!0,msg:j.message||"Connected!"}}));loadMcp()}else{setConnModal(Object.assign({},f,{busy:!1,result:{ok:!1,msg:j.Error||j.message||"Connection failed"}}))}}).catch(function(){setConnModal(Object.assign({},f,{busy:!1,result:{ok:!1,msg:"Network error"}}))})};
var disconnectAccount=function(s){if(!window.confirm("Disconnect your account on "+(s.name||s.id)+"? This deletes your stored credential."))return;setMcpBusy(!0);fetch("/api/lumo/v1/mcp/connections/disconnect",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({serverId:s.id})}).then(function(r){return r.ok?r.json():null}).then(function(j){setMcpBusy(!1);if(j&&j.ok){setMsg("OK:"+(j.message||"Account disconnected."));loadMcp()}else{setMsg("FAIL:"+(j&&j.Error?j.Error:"Failed to disconnect"))}}).catch(function(){setMcpBusy(!1);setMsg("FAIL:Network error")})};
var dd=function(id,small,label,items,onPick)`;

// Button to add in the server card's button section (after the status dot, before Connect)
const BTN_OLD = '(0,a.jsx)("span",{className:"zap-dot zap-dot-"+s.status,style:{marginTop:6}}),';
const BTN_NEW = '(0,a.jsx)("span",{className:"zap-dot zap-dot-"+s.status,style:{marginTop:6}}),s.auth&&s.auth!=="none"?(s.connections&&s.connections.length?(0,a.jsx)(%BTN%.$,{shape:"ghost",size:"small",disabled:mcpBusy,onClick:function(){return disconnectAccount(s)},children:"Disconnect account"}):(0,a.jsx)(%BTN%.$,{shape:"ghost",size:"small",disabled:mcpBusy,onClick:function(){return openConnModal(s)},children:"Connect account"}))):null,';

// Modal JSX to add before the closing of the return (before the mcpForm section)
const MODAL_JSX = 'connModal?(0,a.jsxs)("div",{style:{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16},onClick:closeConnModal,children:[(0,a.jsxs)("div",{onClick:function(e){e.stopPropagation()},style:{background:"var(--background-norm,#fff)",borderRadius:12,padding:24,maxWidth:440,width:"100%",boxShadow:"0 20px 60px rgba(0,0,0,.3)"},children:[(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-center justify-space-between mb-4",children:[(0,a.jsx)("span",{className:"text-bold text-lg",children:"Connect "+(connModal.name||"")}),(%ICON%?(0,a.jsx)(%ICON%.z,{name:"X",size:20,onClick:closeConnModal,style:{cursor:"pointer",color:"var(--text-weak)"}}):(0,a.jsx)("button",{type:"button",onClick:closeConnModal,style:{border:0,background:"transparent",cursor:"pointer",color:"var(--text-weak)",fontSize:20},children:"\\u2715"}))]}),connModal.auth==="api_key"?(0,a.jsxs)("div",{className:"flex flex-column gap-2",children:[(0,a.jsx)("span",{className:"color-weak text-sm",children:"Enter your API key. It is stored encrypted on the server and never appears in chat."}),(0,a.jsx)("input",{type:"password",placeholder:"API key",value:connModal.apiKey,onChange:function(e){return setConnModal(Object.assign({},connModal,{apiKey:e.target.value}))},style:{background:"var(--background-norm)",border:"1px solid var(--border-weak)",borderRadius:8,padding:"8px 12px",color:"var(--text-norm,#fafafa)",font:"inherit",fontSize:".9em",outline:"none",width:"100%"},autoFocus:!0,onKeyDown:function(e){if(e.key==="Enter"&&connModal.apiKey.trim())submitConnModal()}})]}):connModal.auth==="oauth"?(0,a.jsx)("span",{className:"color-weak text-sm",children:"Click Authorize to open the OAuth flow in a new tab."}):null,connModal.authorizeUrl?(0,a.jsx)("a",{href:connModal.authorizeUrl,target:"_blank",rel:"noopener noreferrer",style:{display:"inline-block",marginTop:8,color:"var(--primary,#6d4aff)",textDecoration:"underline"},children:"Open authorization page \\u2192"}):null,connModal.result?(0,a.jsx)("div",{style:{marginTop:8,padding:"8px 12px",borderRadius:8,background:connModal.result.ok?"rgba(61,214,140,.08)":"rgba(229,72,77,.08)",color:connModal.result.ok?"#3dd68c":"#e5484d",fontSize:".85em"},children:connModal.result.msg}):null,(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-center justify-end gap-2 mt-4",children:[(0,a.jsx)(%BTN%.$,{shape:"ghost",size:"small",onClick:closeConnModal,children:"Close"}),connModal.auth==="api_key"?(0,a.jsx)(%BTN%.$,{color:"norm",size:"small",disabled:!connModal.apiKey.trim()||connModal.busy,loading:connModal.busy,onClick:submitConnModal,children:"Connect"}):null]})]})]}):null,';

// Insert the modal before the mcpForm conditional
const MODAL_INSERT = 'mcpForm?(0,a.jsxs)("div",';
const MODAL_NEW = MODAL_JSX + 'mcpForm?(0,a.jsxs)("div",';

for (const f of TARGETS) {
    const p = `${STATIC}/${f}`;
    let src = fs.readFileSync(p, 'utf8');
    let changes = 0;

    // 1. Add state
    if (src.includes(STATE_OLD) && !src.includes('connModal')) {
        src = src.replace(STATE_OLD, STATE_NEW);
        changes++;
        console.log(`  ${f}: added connModal state`);
    }

    // 2. Add functions
    if (src.includes(FUNCS_OLD) && !src.includes('openConnModal')) {
        src = src.replace(FUNCS_OLD, FUNCS_NEW);
        changes++;
        console.log(`  ${f}: added connection functions`);
    }

    // 3. Add button in server card
    if (src.includes(BTN_OLD) && !src.includes('Connect account')) {
        src = src.replace(BTN_OLD, BTN_NEW);
        changes++;
        console.log(`  ${f}: added Connect/Disconnect account button`);
    }

    // 4. Add modal JSX
    if (src.includes(MODAL_INSERT) && !src.includes('connModal.authorizeUrl')) {
        src = src.replace(MODAL_INSERT, MODAL_NEW);
        changes++;
        console.log(`  ${f}: added connection modal`);
    }

    if (changes > 0) {
        fs.writeFileSync(p, src);
        console.log(`OK ${f}: ${changes} changes`);
    } else {
        console.log(`SKIP ${f}: no changes needed`);
    }
}

// Recompute SRI for the modified chunks
const runtimeFiles = fs.readdirSync(STATIC).filter(f => /^runtime\.[a-f0-9]+\.js$/.test(f));
const prefixes = { '1306.43935624.chunk.js': '1306', '4124.6ffe79b5.chunk.js': '4124' };
let touched = 0;
for (const rf of runtimeFiles) {
    const rp = `${STATIC}/${rf}`;
    let rt = fs.readFileSync(rp, 'utf8');
    let dirty = false;
    for (const [file, prefix] of Object.entries(prefixes)) {
        const urlM = rt.match(new RegExp(`${prefix}===s\\?"assets\\/static\\/([^"?]+)\\.chunk\\.js(\\?v=\\d+)?"`));
        if (!urlM) continue;
        const chunkId = urlM[1];
        const chunkPath = `${STATIC}/${chunkId}.chunk.js`;
        if (!fs.existsSync(chunkPath)) continue;
        const b64 = sri(fs.readFileSync(chunkPath)).slice('sha384-'.length);
        const intgRe = new RegExp(`(${prefix}:"sha384-)[A-Za-z0-9+/=]+(")`);
        const intM = rt.match(intgRe);
        if (intM && intM[0] !== `${prefix}:"sha384-${b64}"`) {
            rt = rt.replace(intgRe, `$1${b64}$2`);
            dirty = true;
        }
        const urlRe = new RegExp(`"assets/static/${chunkId.replace(/[.]/g, '\\.')}\\.chunk\\.js(\\?v=\\d+)?"`);
        if (urlRe.test(rt)) {
            rt = rt.replace(urlRe, `"assets/static/${chunkId}.chunk.js?${VERSION}"`);
            dirty = true;
        }
    }
    if (dirty) { fs.writeFileSync(rp, rt); touched++; console.log(`fixed SRI ${rf}`); }
}
console.log(`runtimes updated: ${touched}`);

// Re-bump index.html
const indexPath = `${DIST}/index.html`;
let index = fs.readFileSync(indexPath, 'utf8');
const rtTagRe = /src="\/assets\/static\/(runtime\.[a-f0-9]+)\.js(\?v=\d+)?" integrity="sha384-[^"]+"/;
const m = index.match(rtTagRe);
if (!m) throw new Error('runtime tag not found');
const runtimeHash = sri(fs.readFileSync(`${STATIC}/${m[1]}.js`));
index = index.replace(rtTagRe, `src="/assets/static/${m[1]}.js?${VERSION}" integrity="${runtimeHash}"`);
fs.writeFileSync(indexPath, index);
console.log(`bumped ${m[1]}.js -> ?${VERSION}`);

// Verify
let mm = 0, ck = 0;
for (const rf of runtimeFiles) {
    const rt = fs.readFileSync(`${STATIC}/${rf}`, 'utf8');
    const re = /(\d{3,4})===s\?"assets\/static\/([^"?]+)\.chunk\.js(?:\?v=\d+)?"/g;
    let mt;
    while ((mt = re.exec(rt)) !== null) {
        const pp = mt[1], cb = mt[2];
        const ir = new RegExp(pp + ':"sha384-([A-Za-z0-9+/=]+)"');
        const i = rt.match(ir);
        if (!i) continue;
        const f = fs.readdirSync(STATIC).filter(x => x === cb + '.chunk.js');
        if (!f.length) continue;
        const a = sri(fs.readFileSync(`${STATIC}/${f[0]}`));
        ck++;
        if (i[1] !== a.slice(7)) mm++;
    }
}
console.log(`integrity check: ${ck} checked, ${mm} mismatches`);
