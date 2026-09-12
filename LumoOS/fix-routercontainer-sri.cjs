// Fix SRI integrity for chunk 1681 (RouterContainer) across all runtime files.
//
// The repo was committed with patched RouterContainer.*.chunk.js files whose
// SHA-384 hashes no longer match the `1681:"sha384-..."` value baked into the
// webpack runtime files. The browser fetches the chunk (HTTP 200) but rejects
// it on integrity mismatch -> ChunkLoadError -> "Something went wrong" after
// login. bust-cache-admin.cjs only covers chunks 4206/1306/4124/1230, NOT
// 1681, so this script closes that gap.
//
// Mirrors bust-cache-admin.cjs: for each runtime, follows its own 1681 URL
// mapping, recomputes the SHA-384 of the RouterContainer file it actually
// loads, writes the correct hash back, and bumps the URL to VERSION. Then
// re-bumps the boot runtime tag in index.html (modifying a runtime changes
// its own SHA, so the index.html integrity attribute must be refreshed too).
const fs = require('fs');
const crypto = require('crypto');

const DIST = process.env.LUMO_DIST_DIR || '/home/z/my-project/LumoOS/lumo-dist';
const STATIC = `${DIST}/assets/static`;
const VERSION = 'v=41';
const CHUNK_PREFIX = '1681';
const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

const runtimeFiles = fs.readdirSync(STATIC).filter(f => /^runtime\.[a-f0-9]+\.js$/.test(f));
let touched = 0;
for (const rf of runtimeFiles) {
    const rp = `${STATIC}/${rf}`;
    let rt = fs.readFileSync(rp, 'utf8');
    let dirty = false;

    // Find this runtime's 1681 -> RouterContainer.HASH.chunk.js mapping.
    const urlM = rt.match(new RegExp(`${CHUNK_PREFIX}===s\\?"assets\\/static\\/(RouterContainer\\.[a-f0-9]+)\\.chunk\\.js(\\?v=\\d+)?"`));
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
    const intgRe = new RegExp(`(${CHUNK_PREFIX}:"sha384-)[A-Za-z0-9+/=]+(")`);
    const intM = rt.match(intgRe);
    if (intM && intM[0] !== `${CHUNK_PREFIX}:"sha384-${b64}"`) {
        rt = rt.replace(intgRe, `$1${b64}$2`);
        dirty = true;
    }

    // Bump the cache version on the RouterContainer URL.
    const urlRe = new RegExp(`"assets/static/${chunkId.replace(/[.]/g, '\\.')}\\.chunk\\.js(\\?v=\\d+)?"`);
    if (urlRe.test(rt)) {
        rt = rt.replace(urlRe, `"assets/static/${chunkId}.chunk.js?${VERSION}"`);
        dirty = true;
    }

    if (dirty) {
        fs.writeFileSync(rp, rt);
        touched++;
        console.log(`fixed ${rf} -> ${chunkId}`);
    }
}
console.log(`runtimes fixed: ${touched}`);

// Re-bump the boot runtime tag in index.html (its content changed, so its
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
