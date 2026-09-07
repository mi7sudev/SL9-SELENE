// Cache/SRI bust for patched chunks (4206, 1306, 4124, 1230).
// Per-runtime correct: follows each runtime's own URL mapping for the prefix,
// recomputes SHA-384 of the file it actually loads, and bumps the URL to
// VERSION. Re-bumps the boot runtime tag in index.html.
const fs = require('fs');
const crypto = require('crypto');

const STATIC = 'D:/ProtoLumo/WebClients/applications/lumo/dist/assets/static';
const DIST = 'D:/ProtoLumo/WebClients/applications/lumo/dist';
const VERSION = 'v=40';
const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

const PREFIXES = ['4206', '1306', '4124', '1230'];

const runtimeFiles = fs.readdirSync(STATIC).filter(f => /^runtime\.[a-f0-9]+\.js$/.test(f));
let touched = 0;
for (const rf of runtimeFiles) {
    const rp = `${STATIC}/${rf}`;
    let rt = fs.readFileSync(rp, 'utf8');
    let dirty = false;
    for (const prefix of PREFIXES) {
        const urlM = rt.match(new RegExp(`${prefix}===s\\?"assets\\/static\\/(${prefix}\\.[a-f0-9]+)\\.chunk\\.js(\\?v=\\d+)?"`));
        if (!urlM) continue;
        const chunkId = urlM[1];
        const chunkPath = `${STATIC}/${chunkId}.chunk.js`;
        if (!fs.existsSync(chunkPath)) {
            console.log(`SKIP ${rf}: ${prefix} -> ${chunkId} missing`);
            continue;
        }
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
        touched++;
        console.log(`busted ${rf}`);
    }
}
console.log(`runtimes busted: ${touched}`);

const indexPath = `${DIST}/index.html`;
let index = fs.readFileSync(indexPath, 'utf8');
const rtTagRe = /src="\/assets\/static\/(runtime\.[a-f0-9]+)\.js(\?v=\d+)?" integrity="sha384-[^"]+"/;
const m = index.match(rtTagRe);
if (!m) throw new Error('runtime script tag not found in index.html');
const runtimeHash = sri(fs.readFileSync(`${STATIC}/${m[1]}.js`));
index = index.replace(rtTagRe, `src="/assets/static/${m[1]}.js?${VERSION}" integrity="${runtimeHash}"`);
fs.writeFileSync(indexPath, index);
console.log(`bumped ${m[1]}.js in index.html -> ?${VERSION}`);