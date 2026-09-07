// Patch the context usage panel to use the selected model's context window
// instead of the hardcoded 128000 (el.Ph.MAX_CONTEXT).
//
// 1. In 1306/4124: patch `maxTokens:a=el.Ph.MAX_CONTEXT` to read
//    `window.__lumoModelContext` (set by the catalog fetch in 4206) and
//    fall back to el.Ph.MAX_CONTEXT.
// 2. In 4206: extend the catalog fetch to also store ModelMeta in
//    `window.__lumoModelMeta` and set `window.__lumoModelContext` based
//    on the currently selected model (from localStorage BYOK config).
//
// After patching, recomputes SRI for the modified chunks and bumps the
// boot runtime tag in index.html.
const fs = require('fs');
const crypto = require('crypto');

const DIST = process.env.LUMO_DIST_DIR || '/home/z/my-project/LumoOS/lumo-dist';
const STATIC = `${DIST}/assets/static`;
const VERSION = 'v=59';
const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

// ── 1. Patch context usage in 1306 + 4124 ───────────────────────────────────
// The context usage component reads: maxTokens:a=el.Ph.MAX_CONTEXT
// (where el is the token-counter module and Ph.MAX_CONTEXT = 128000).
// We patch it to read a dynamic window from window.__lumoModelContext.
//
// The exact pattern in both chunks is:
//   maxTokens:a=el.Ph.MAX_CONTEXT
// where `el` is the minified module binding (same in both mirrors).
const CTX_OLD = 'maxTokens:a=el.Ph.MAX_CONTEXT';
const CTX_NEW = 'maxTokens:a=(window.__lumoModelContext||el.Ph.MAX_CONTEXT)';

const ctxTargets = ['1306.43935624.chunk.js', '4124.6ffe79b5.chunk.js'];
for (const f of ctxTargets) {
    const p = `${STATIC}/${f}`;
    let src = fs.readFileSync(p, 'utf8');
    const count = src.split(CTX_OLD).length - 1;
    if (count === 0) {
        if (src.includes('window.__lumoModelContext')) {
            console.log(`SKIP ${f}: already patched`);
        } else {
            console.error(`FAIL ${f}: anchor not found (expected maxTokens:a=el.Ph.MAX_CONTEXT)`);
        }
        continue;
    }
    if (count !== 1) {
        console.error(`FAIL ${f}: found ${count} occurrences (expected 1)`);
        continue;
    }
    src = src.replace(CTX_OLD, CTX_NEW);
    fs.writeFileSync(p, src);
    console.log(`OK ${f}: context usage now model-aware`);
}

// ── 2. Patch catalog fetch in 4206 to store ModelMeta + set context window ──
// The existing patch (from patch-admin-ui.cjs) fetches /api/lumo/v1/catalog
// and sets byokModels to the list of model IDs. We extend the .then() to also
// store ModelMeta and set window.__lumoModelContext based on the selected model.
//
// Current code (after the admin-ui patch):
//   fetch("/api/lumo/v1/catalog").then(function(r){return r.ok?r.json():null}).then(function(j){var ids=((j&&j.Models)||[]).filter(function(x){return typeof x==="string"&&x});_byokState[1](ids)}).catch(function(){})
//
// We insert after the ids line:
//   window.__lumoModelMeta=j&&j.ModelMeta||{};try{var c0=JSON.parse(localStorage.getItem("lumo.byok.config.v1")||"{}");var m=c0&&c0.model?String(c0.model):null;window.__lumoModelContext=m&&window.__lumoModelMeta[m]&&window.__lumoModelMeta[m].contextWindow?window.__lumoModelMeta[m].contextWindow:null}catch(e){}
const CATALOG_OLD = 'var ids=((j&&j.Models)||[]).filter(function(x){return typeof x==="string"&&x});_byokState[1](ids)';
const CATALOG_NEW = 'var ids=((j&&j.Models)||[]).filter(function(x){return typeof x==="string"&&x});window.__lumoModelMeta=j&&j.ModelMeta||{};try{var c0=JSON.parse(localStorage.getItem("lumo.byok.config.v1")||"{}");var m=c0&&c0.model?String(c0.model):null;window.__lumoModelContext=m&&window.__lumoModelMeta[m]&&window.__lumoModelMeta[m].contextWindow?window.__lumoModelMeta[m].contextWindow:null}catch(e){}_byokState[1](ids)';

const f4206 = '4206.9903be83.chunk.js';
const p4206 = `${STATIC}/${f4206}`;
let src4206 = fs.readFileSync(p4206, 'utf8');
if (src4206.includes('window.__lumoModelMeta')) {
    console.log(`SKIP ${f4206}: already patched`);
} else if (src4206.includes(CATALOG_OLD)) {
    src4206 = src4206.replace(CATALOG_OLD, CATALOG_NEW);
    fs.writeFileSync(p4206, src4206);
    console.log(`OK ${f4206}: catalog fetch now stores ModelMeta + sets context window`);
} else {
    console.error(`FAIL ${f4206}: catalog anchor not found`);
}

// ── 3. Recompute SRI for all modified chunks (1306, 4124, 4206) ─────────────
const runtimeFiles = fs.readdirSync(STATIC).filter(f => /^runtime\.[a-f0-9]+\.js$/.test(f));
const prefixes = { '1306.43935624.chunk.js': '1306', '4124.6ffe79b5.chunk.js': '4124', '4206.9903be83.chunk.js': '4206' };
let touchedRuntimes = 0;
for (const rf of runtimeFiles) {
    const rp = `${STATIC}/${rf}`;
    let rt = fs.readFileSync(rp, 'utf8');
    let dirty = false;
    for (const [file, prefix] of Object.entries(prefixes)) {
        const urlM = rt.match(new RegExp(`${prefix}===s\\?"assets\\/static\\/(${prefix}\\.[a-f0-9]+)\\.chunk\\.js(\\?v=\\d+)?"`));
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
    if (dirty) {
        fs.writeFileSync(rp, rt);
        touchedRuntimes++;
        console.log(`fixed SRI ${rf}`);
    }
}
console.log(`runtimes updated: ${touchedRuntimes}`);

// ── 4. Re-bump the boot runtime tag in index.html ───────────────────────────
const indexPath = `${DIST}/index.html`;
let index = fs.readFileSync(indexPath, 'utf8');
const rtTagRe = /src="\/assets\/static\/(runtime\.[a-f0-9]+)\.js(\?v=\d+)?" integrity="sha384-[^"]+"/;
const m = index.match(rtTagRe);
if (!m) throw new Error('runtime script tag not found in index.html');
const runtimeHash = sri(fs.readFileSync(`${STATIC}/${m[1]}.js`));
index = index.replace(rtTagRe, `src="/assets/static/${m[1]}.js?${VERSION}" integrity="${runtimeHash}"`);
fs.writeFileSync(indexPath, index);
console.log(`bumped ${m[1]}.js in index.html -> ?${VERSION}`);

// ── 5. Verify: 0 SRI mismatches ─────────────────────────────────────────────
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
if (mm !== 0) process.exit(1);
