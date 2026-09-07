// Second pass: neutralize the remaining proton.me references that the first
// pass didn't catch.
const fs = require('fs');
const crypto = require('crypto');

const DIST = process.env.LUMO_DIST_DIR || '/home/z/my-project/LumoOS/lumo-dist';
const STATIC = `${DIST}/assets/static`;
const VERSION = 'v=59';
const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

const TARGETS = ['1306.43935624.chunk.js', '4124.6ffe79b5.chunk.js', '6991.de9c5138.chunk.js'];

// 1. The apps switcher URL builder: `https://proton.me${(t=n[a.og])?`/${t}`:""}${e}`
//    Exported as "C". Replace the template literal base with a local "#"
const APPS_URL_OLD = 'return`https://proton.me${(t=n[a.og])?`/${t}`:""}${e}`';
const APPS_URL_NEW = 'return"#"';

// 2. In 9333: m="https://proton.me/" used as URL parser base
//    Replace with a localhost base (keeps URL parsing working, no external call)
const URL_BASE_OLD = 'm="https://proton.me/"';
const URL_BASE_NEW = 'm="http://localhost/"';

let total = 0;
for (const f of TARGETS) {
    const p = `${STATIC}/${f}`;
    let src = fs.readFileSync(p, 'utf8');
    let changes = 0;

    if (src.includes(APPS_URL_OLD)) {
        src = src.replace(APPS_URL_OLD, APPS_URL_NEW);
        changes++;
        console.log(`  ${f}: neutralized apps switcher URL builder`);
    }

    if (changes > 0) {
        fs.writeFileSync(p, src);
        console.log(`OK ${f}: ${changes} changes`);
        total += changes;
    }
}

// Patch 9333 separately
const p9333 = `${STATIC}/9333.3bd33a21.chunk.js`;
let src9333 = fs.readFileSync(p9333, 'utf8');
if (src9333.includes(URL_BASE_OLD)) {
    src9333 = src9333.replace(URL_BASE_OLD, URL_BASE_NEW);
    fs.writeFileSync(p9333, src9333);
    console.log(`OK 9333: neutralized URL parser base`);
    total++;
}

console.log(`Total: ${total}`);

// Recompute SRI
const runtimeFiles = fs.readdirSync(STATIC).filter(f => /^runtime\.[a-f0-9]+\.js$/.test(f));
const prefixes = { '1306.43935624.chunk.js': '1306', '4124.6ffe79b5.chunk.js': '4124', '6991.de9c5138.chunk.js': '6991', '9333.3bd33a21.chunk.js': '9333' };
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

// Final audit
console.log('\n=== Final audit: remaining proton.me references ===');
for (const f of [...TARGETS, '9333.3bd33a21.chunk.js']) {
    const p = `${STATIC}/${f}`;
    const src = fs.readFileSync(p, 'utf8');
    const matches = src.match(/https?:\/\/[a-z]*proton\.[a-z]+[^\s"')]*/g) || [];
    if (matches.length > 0) {
        const unique = [...new Set(matches)];
        console.log(`${f}: ${matches.length} total, ${unique.length} unique`);
        unique.forEach(u => console.log(`  ${u}`));
    } else {
        console.log(`${f}: CLEAN (0 references)`);
    }
}
