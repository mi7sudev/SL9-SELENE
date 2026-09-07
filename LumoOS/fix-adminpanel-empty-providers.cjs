// Fix ZAdminPanel crash when no providers are configured.
//
// Bug: when /admin/config returns an empty providers list, ZAdminPanel sets
// provs=[] (truthy), passes the `if(!users||!provs||!mcp)` guard, then computes
// idx=Math.min(sel,provs.length-1)=Math.min(0,-1)=-1, so cur=provs[-1]=undefined,
// and cur.avail.slice() throws "Cannot read properties of undefined (reading
// 'avail')". React's error boundary catches it, unmounts the panel, and the
// settings modal closes — so the admin can NEVER add a provider. This is the
// "admin not recognized" symptom: the panel mounts, fetches /admin/config (200),
// then crashes before rendering.
//
// Fix: in the load() callback, if the parsed providers list is empty, seed it
// with one blank provider entry so the admin immediately sees an editable form.
// Mirrors the addProvider() action's shape exactly.
//
// Applies to both chunk mirrors: 1306.43935624 and 4124.6ffe79b5. After
// patching the chunk files, recomputes their SHA-384 SRI hashes across ALL
// runtime files and re-bumps the boot runtime tag in index.html (same pattern
// as fix-routercontainer-sri.cjs).
const fs = require('fs');
const crypto = require('crypto');

const DIST = process.env.LUMO_DIST_DIR || '/home/z/my-project/LumoOS/lumo-dist';
const STATIC = `${DIST}/assets/static`;
const VERSION = 'v=42';
const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

// The two chunk mirrors that carry ZAdminPanel. The crash and the fix are
// byte-identical in both, so a single replacement string works for both files.
const TARGETS = ['1306.43935624.chunk.js', '4124.6ffe79b5.chunk.js'];
// Chunk prefixes as webpack knows them (the left side of `===s?` in runtimes).
const PREFIXES = ['1306', '4124'];

const OLD = 'setPs(ps),setSel(0)';
const NEW = 'setPs(ps.length?ps:[{id:"p1",name:"",baseUrl:"",hasApiKey:!1,models:[],avail:[],key:""}]),setSel(0)';

// 1. Patch the chunk files.
const patchedChunks = [];
for (const f of TARGETS) {
    const p = `${STATIC}/${f}`;
    let src = fs.readFileSync(p, 'utf8');
    const count = src.split(OLD).length - 1;
    if (count === 0) {
        console.log(`SKIP ${f}: pattern not found (already patched?)`);
        // Still need to recompute SRI if file was patched before but runtimes weren't.
        patchedChunks.push({ file: f, prefix: f.startsWith('1306') ? '1306' : '4124', changed: false });
        continue;
    }
    if (count !== 1) {
        throw new Error(`${f}: expected 1 occurrence of the patch anchor, found ${count}`);
    }
    src = src.replace(OLD, NEW);
    fs.writeFileSync(p, src);
    patchedChunks.push({ file: f, prefix: f.startsWith('1306') ? '1306' : '4124', changed: true });
    console.log(`patched ${f}`);
}

// 2. Recompute SRI for the (possibly modified) chunks across all runtime files.
const runtimeFiles = fs.readdirSync(STATIC).filter(f => /^runtime\.[a-f0-9]+\.js$/.test(f));
let touchedRuntimes = 0;
for (const rf of runtimeFiles) {
    const rp = `${STATIC}/${rf}`;
    let rt = fs.readFileSync(rp, 'utf8');
    let dirty = false;

    for (const prefix of PREFIXES) {
        // Find this runtime's <prefix> -> <chunkbase>.chunk.js mapping.
        const urlM = rt.match(new RegExp(`${prefix}===s\\?"assets\\/static\\/(${prefix}\\.[a-f0-9]+)\\.chunk\\.js(\\?v=\\d+)?"`));
        if (!urlM) continue;
        const chunkId = urlM[1];
        const chunkPath = `${STATIC}/${chunkId}.chunk.js`;
        if (!fs.existsSync(chunkPath)) {
            console.log(`SKIP ${rf}: ${chunkId} missing on disk`);
            continue;
        }

        // Recompute the actual SHA-384 of the file this runtime loads.
        const b64 = sri(fs.readFileSync(chunkPath)).slice('sha384-'.length);

        // Replace the expected integrity hash with the actual one.
        const intgRe = new RegExp(`(${prefix}:"sha384-)[A-Za-z0-9+/=]+(")`);
        const intM = rt.match(intgRe);
        if (intM && intM[0] !== `${prefix}:"sha384-${b64}"`) {
            rt = rt.replace(intgRe, `$1${b64}$2`);
            dirty = true;
        }

        // Bump the cache version on the chunk URL.
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

// 3. Re-bump the boot runtime tag in index.html (its content changed, so its
// own SRI in index.html must be refreshed, and the cache version bumped so
// browsers refetch the patched runtime instead of using a stale copy).
const indexPath = `${DIST}/index.html`;
let index = fs.readFileSync(indexPath, 'utf8');
const rtTagRe = /src="\/assets\/static\/(runtime\.[a-f0-9]+)\.js(\?v=\d+)?" integrity="sha384-[^"]+"/;
const m = index.match(rtTagRe);
if (!m) throw new Error('runtime script tag not found in index.html');
const runtimeHash = sri(fs.readFileSync(`${STATIC}/${m[1]}.js`));
index = index.replace(rtTagRe, `src="/assets/static/${m[1]}.js?${VERSION}" integrity="${runtimeHash}"`);
fs.writeFileSync(indexPath, index);
console.log(`bumped ${m[1]}.js in index.html -> ?${VERSION}`);

// 4. Verify: 0 SRI mismatches across the whole dist.
const verify = (() => {
    let mm = 0, ck = 0;
    for (const rf of runtimeFiles) {
        const rt = fs.readFileSync(`${STATIC}/${rf}`, 'utf8');
        const re = /(\d{3,4})===s\?"assets\/static\/([^"?]+)\.chunk\.js(?:\?v=\d+)?"/g;
        let mt;
        while ((mt = re.exec(rt)) !== null) {
            const p = mt[1], cb = mt[2];
            const ir = new RegExp(p + ':"sha384-([A-Za-z0-9+/=]+)"');
            const i = rt.match(ir);
            if (!i) continue;
            const f = fs.readdirSync(STATIC).filter(x => x === cb + '.chunk.js');
            if (!f.length) continue;
            const a = sri(fs.readFileSync(`${STATIC}/${f[0]}`));
            ck++;
            if (i[1] !== a.slice(7)) mm++;
        }
    }
    return { checked: ck, mismatches: mm };
})();
console.log(`integrity check: ${verify.checked} checked, ${verify.mismatches} mismatches`);
if (verify.mismatches !== 0) process.exit(1);
