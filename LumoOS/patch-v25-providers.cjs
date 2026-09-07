// Swap the whole injected AI Provider block (shared ZADMIN_CSS + ZAdminPanel +
// role wrapper with the non-admin read-only view) with the current source from
// patch-admin-ui.cjs, which stays the single source of truth (also used for
// post-rebuild replay).
//
// The block always sits immediately before the original BYOK form definition
// ("let la=()=>{" / "let nG=()=>{"), so the splice runs from the block start
// marker to that definition — robust no matter how the block's internals
// (CSS/panel/wrapper) evolve.
const fs = require('fs');

const STATIC = 'D:/ProtoLumo/WebClients/applications/lumo/dist/assets/static';

// per-chunk alias of the native building blocks (must match patch-admin-ui.cjs)
const ALIASES = {
    '1306.43935624.chunk.js': { SEC: 'n8', BTN: 'k', BANNER: 'ep', INPUT: 'nw', SPIN: 'av' },
    '4124.6ffe79b5.chunk.js': { SEC: 'n$', BTN: 'k', BANNER: 'eh', INPUT: 'nt', SPIN: 'r8' },
};

const src = fs.readFileSync('D:/ProtoLumo/patch-admin-ui.cjs', 'utf8');
const cssM = src.match(/const ZADMIN_CSS = ([\s\S]*?);\r?\n/);
if (!cssM) throw new Error('ZADMIN_CSS const not found');
const CSS = new Function('const ZADMIN_CSS = ' + cssM[1] + '; return ZADMIN_CSS;')();
const panelM = src.match(/const ADMIN_PANEL = `([\s\S]*?)`;/);
if (!panelM) throw new Error('ADMIN_PANEL template not found');
const PANEL = eval('`' + panelM[1] + '`');
const wrapM = src.match(/function makeWrapper\(wrapperName\) \{\s*return `([\s\S]*?)`;/);
if (!wrapM) throw new Error('makeWrapper template not found');
function fillTokens(code, alias) {
    return code
        .split('%SEC%').join(alias.SEC)
        .split('%BTN%').join(alias.BTN)
        .split('%BANNER%').join(alias.BANNER)
        .split('%INPUT%').join(alias.INPUT)
        .split('%SPIN%').join(alias.SPIN);
}

const TARGETS = [
    { f: '1306.43935624.chunk.js', wrapper: 'la2', formDef: 'let la=()=>{' },
    { f: '4124.6ffe79b5.chunk.js', wrapper: 'nG2', formDef: 'let nG=()=>{' },
];
for (const t of TARGETS) {
    const { wrapper: wrapperName, formDef } = t;
    const alias = ALIASES[t.f];
    const WRAPPER = fillTokens(eval('`' + wrapM[1] + '`'), alias);
    const BLOCK = fillTokens('var ZADMIN_CSS=' + JSON.stringify(CSS) + ';' + PANEL, alias) + WRAPPER;
    if (/%SEC%|%BTN%|%BANNER%|%INPUT%|%SPIN%/.test(BLOCK)) throw new Error(`unresolved token in block (${t.f})`);
    for (const probe of ['"checkbox"', '/api/lumo/v1/admin/config', 'providers:', 'Fetch model list',
        'Save providers', 'zap-root', 'zap-chips', 'zap-dd-menu', 'ZADMIN_CSS',
        '/api/lumo/v1/catalog', 'ModelProviders', 'zap-chip-ro', 'icon:"Cpu"',
        // MCP servers section (lumo-server.cjs MCP admin APIs)
        '/api/lumo/v1/admin/mcp/servers', 'icon:"Wrench"', 'zap-dot', 'mcp-servers.json',
        // per-user connection auth (api_key / oauth) + tool classification
        'Per-user connection', 'mcp-auth', 'Authorize URL', 'Token URL', 'Client ID',
        'classification', 'connection(s)',
        alias.SEC + ',', alias.INPUT + '.Ay', alias.BANNER + '.l', alias.SPIN + '.m']) {
        if (!BLOCK.includes(probe)) throw new Error(`block sanity check failed (${t.f}): missing ${probe}`);
    }
    const p = `${STATIC}/${t.f}`;
    let s = fs.readFileSync(p, 'utf8');

    // block start: current format (var ZADMIN_CSS=…) or pre-unification format
    let startTok;
    if (s.split('var ZADMIN_CSS=').length - 1 === 1) startTok = 'var ZADMIN_CSS=';
    else if (s.split('let ZAdminPanel=').length - 1 === 1) startTok = 'let ZAdminPanel=';
    else throw new Error(`${t.f}: AI Provider block start not found in any known format`);

    const start = s.indexOf(startTok);
    const endCount = s.split(formDef).length - 1;
    if (endCount !== 1) throw new Error(`${t.f}: expected exactly 1 "${formDef}" marker, found ${endCount}`);
    const endIdx = s.indexOf(formDef, start);
    if (endIdx === -1) throw new Error(`${t.f}: form definition not found after block start`);
    if (endIdx + formDef.length > start + 400000) throw new Error(`${t.f}: block absurdly large, aborting`);

    s = s.slice(0, start) + BLOCK + s.slice(endIdx);
    fs.writeFileSync(p, s);

    // round-trip verify: block must eval and contain the wrapper once
    new Function(s); // syntax gate for the whole chunk
    if (s.split('let ' + wrapperName + '=>').length - 1 !== 1 && s.split('let ' + wrapperName + '=').length - 1 !== 1) {
        throw new Error(`${t.f}: wrapper ${wrapperName} not found exactly once after patch`);
    }
    console.log(`patched ${t.f} (AI Provider block swapped, ${BLOCK.length} chars)`);
}
console.log('done');
