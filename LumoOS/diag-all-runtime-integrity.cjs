// Check integrity for every (runtime, chunk) pair across ALL runtimes.
const fs = require('fs');
const crypto = require('crypto');
const dir = 'D:/ProtoLumo/WebClients/applications/lumo/dist/assets/static';
const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

const runtimeFiles = fs.readdirSync(dir).filter(f => /^runtime\.[a-f0-9]+\.js$/.test(f));
let totalMismatch = 0, totalChecked = 0;
for (const rf of runtimeFiles) {
    const rt = fs.readFileSync(`${dir}/${rf}`, 'utf8');
    // Find all URL -> chunk mappings
    const urlRe = /(\d{3,4})===s\?"assets\/static\/([^"?]+)\.chunk\.js(?:\?v=\d+)?"/g;
    let m;
    while ((m = urlRe.exec(rt)) !== null) {
        const prefix = m[1], chunkBase = m[2];
        const intgRe = new RegExp(prefix + ':"sha384-([A-Za-z0-9+/=]+)"');
        const intg = rt.match(intgRe);
        if (!intg) continue;
        // We need to find the actual file. The chunkBase might be "2813.2d965ce4"
        // and the actual file is "2813.2d965ce4.chunk.js". Skip source maps.
        const files = fs.readdirSync(dir).filter(f => f === chunkBase + '.chunk.js');
        const actualFile = files.length ? files[0] : null;
        if (!actualFile) continue;
        const actual = sri(fs.readFileSync(`${dir}/${actualFile}`));
        totalChecked++;
        if (intg[1] !== actual.slice(7)) {
            totalMismatch++;
            console.log(`MISMATCH ${rf} -> ${chunkBase} (file=${actualFile}): expected=${intg[1].slice(0,16)} actual=${actual.slice(7, 23)}`);
        }
    }
}
console.log(`checked: ${totalChecked}, mismatches: ${totalMismatch}`);