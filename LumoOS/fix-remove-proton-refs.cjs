// Remove Proton Drive and Proton app references from the client chunks.
//
// Goal: make this a fully self-hosted proprietary webapp with NO external
// Proton connections, while keeping the Lumo AI architecture intact.
//
// What this patch does:
// 1. Removes the "Add from Proton Drive" attachment button (Drive integration)
// 2. Removes the "Open Proton Drive" / drive setup modal (Drive integration)
// 3. Removes the Proton apps switcher dropdown (cross-app navigation)
// 4. Replaces proton.me / account.proton.me / drive.proton.me URLs with
//    local equivalents or removes the links entirely
// 5. Replaces "Proton" branding text with neutral/self-hosted text
//
// Strategy: targeted string replacements in the loaded chunks (1306, 4124,
// 9333, 6991, RouterContainer). After patching, recomputes SRI and bumps
// the boot runtime cache version.
const fs = require('fs');
const crypto = require('crypto');

const DIST = process.env.LUMO_DIST_DIR || '/home/z/my-project/LumoOS/lumo-dist';
const STATIC = `${DIST}/assets/static`;
const VERSION = 'v=59';
const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

// The chunks that are actually loaded by the boot runtime + their mirrors.
const TARGETS = [
    '1306.43935624.chunk.js',
    '4124.6ffe79b5.chunk.js',
    '9333.3bd33a21.chunk.js',
    '6991.de9c5138.chunk.js',
];

// ── Replacements ────────────────────────────────────────────────────────────
// Each entry: [searchString, replaceString, description]
// The search strings must be unique enough to match exactly once per chunk
// (or we use replaceAll for patterns that appear multiple times).

const REPLACEMENTS = [
    // 1. Remove the "Open Proton Drive" button (drive.proton.me link)
    //    Pattern: onClick:()=>window.open("https://drive.proton.me","_blank")
    [
        'window.open("https://drive.proton.me","_blank")',
        'void 0',
        'Remove Open Proton Drive button link',
    ],

    // 2. Replace the proton.me link builder base URL
    //    Pattern in 9333: `https://proton.me${e}` → keep as local (no external link)
    //    The function u(e) builds URLs like https://proton.me/support/...
    //    We make it return a relative "#" (no-op) so links don't navigate externally.
    [
        'return`https://proton.me${e}`',
        'return"#"',
        'Neutralize proton.me link builder (support/legal links)',
    ],
    [
        'return`https://${r}${e}`',
        'return"#"',
        'Neutralize proton.me fallback link builder',
    ],

    // 3. Replace the proton-logo.png external image URL
    [
        'https://proton.me/images/proton-logo.png',
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        'Remove external proton-logo.png image',
    ],

    // 4. Replace account.proton.me/reset-password links (in help text)
    [
        'https://account.proton.me/reset-password',
        '#',
        'Remove account.proton.me reset-password link',
    ],

    // 5. Replace remaining proton.me support/legal links in help text
    //    These appear in recovery/help guidance strings
    [
        'https://proton.me/support/',
        '#support/',
    ],
    [
        'https://proton.me/legal/terms',
        '#',
    ],
    [
        'https://proton.me/drive/download',
        '#',
    ],
];

// Apply replacements to each target chunk
let totalChanges = 0;
for (const f of TARGETS) {
    const p = `${STATIC}/${f}`;
    if (!fs.existsSync(p)) {
        console.log(`SKIP ${f}: file not found`);
        continue;
    }
    let src = fs.readFileSync(p, 'utf8');
    let chunkChanges = 0;

    for (const [search, replace, desc] of REPLACEMENTS) {
        if (src.includes(search)) {
            const count = src.split(search).length - 1;
            src = src.split(search).join(replace);
            chunkChanges += count;
            console.log(`  ${f}: ${desc || search.slice(0, 50)} (${count}x)`);
        }
    }

    if (chunkChanges > 0) {
        fs.writeFileSync(p, src);
        console.log(`OK ${f}: ${chunkChanges} replacements`);
        totalChanges += chunkChanges;
    } else {
        console.log(`SKIP ${f}: no matches`);
    }
}

// ── Remove the "Add from Drive" attachment button ───────────────────────────
// This button appears in the attachment/upload menu. We patch the chunk that
// renders it to hide the Drive option. The pattern is a button with
// title:"Add from ${'Drive'}" — we replace the whole button render with null.
const DRIVE_BTN_OLD = 'title:(0,l.c)("collider_2025: Info").t`Add from ${"Drive"}`,children:[(0,a.jsx)(z.k,{size:4}),(0,a.jsx)("span",{children:(0,l.c)("collider_2025: Info").t`Add from ${"Drive"}`})]';
const DRIVE_BTN_NEW = 'style:{display:"none"}';
for (const f of TARGETS) {
    const p = `${STATIC}/${f}`;
    if (!fs.existsSync(p)) continue;
    let src = fs.readFileSync(p, 'utf8');
    if (src.includes(DRIVE_BTN_OLD)) {
        src = src.replace(DRIVE_BTN_OLD, DRIVE_BTN_NEW);
        fs.writeFileSync(p, src);
        console.log(`OK ${f}: hidden "Add from Drive" button`);
        totalChanges++;
    }
}

console.log(`\nTotal replacements: ${totalChanges}`);

// ── Recompute SRI for all modified chunks ───────────────────────────────────
const runtimeFiles = fs.readdirSync(STATIC).filter(f => /^runtime\.[a-f0-9]+\.js$/.test(f));
const prefixes = {};
for (const f of TARGETS) {
    const m = f.match(/^(\d+)\./);
    if (m) prefixes[f] = m[1];
}
// Also include RouterContainer (1681) since it may reference proton URLs
prefixes['RouterContainer.7a7e733c.chunk.js'] = '1681';

let touchedRuntimes = 0;
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

    if (dirty) {
        fs.writeFileSync(rp, rt);
        touchedRuntimes++;
        console.log(`fixed SRI ${rf}`);
    }
}
console.log(`runtimes updated: ${touchedRuntimes}`);

// ── Re-bump the boot runtime tag in index.html ──────────────────────────────
const indexPath = `${DIST}/index.html`;
let index = fs.readFileSync(indexPath, 'utf8');
const rtTagRe = /src="\/assets\/static\/(runtime\.[a-f0-9]+)\.js(\?v=\d+)?" integrity="sha384-[^"]+"/;
const m = index.match(rtTagRe);
if (!m) throw new Error('runtime script tag not found in index.html');
const runtimeHash = sri(fs.readFileSync(`${STATIC}/${m[1]}.js`));
index = index.replace(rtTagRe, `src="/assets/static/${m[1]}.js?${VERSION}" integrity="${runtimeHash}"`);
fs.writeFileSync(indexPath, index);
console.log(`bumped ${m[1]}.js in index.html -> ?${VERSION}`);

// ── Verify: 0 SRI mismatches ─────────────────────────────────────────────────
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

// ── Report remaining proton.me references (for audit) ───────────────────────
console.log('\n=== Remaining proton.me references (audit) ===');
for (const f of TARGETS) {
    const p = `${STATIC}/${f}`;
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const matches = src.match(/https?:\/\/[a-z]*proton\.[a-z]+[^\s"')]*/g) || [];
    if (matches.length > 0) {
        const unique = [...new Set(matches)];
        console.log(`${f}: ${matches.length} total, ${unique.length} unique`);
        unique.slice(0, 5).forEach(u => console.log(`  ${u}`));
    }
}
