# Agent Browser Side-Panel — Implementation Spec & Handoff

> **Audience:** an AI agent tasked with replicating this feature on the same (or a similar)
> self-hosted Proton **Lumo** deployment.
> **Status:** implemented, committed as `6403a55` ("Browser v3: multi-tab side-panel browser").
> **Canonical sources (read these for exact code):**
> - `LumoOS/lumo-dist/assets/static/lumo-browser-panel.js` — the entire frontend (760 lines, IIFE)
> - `LumoOS/browser-engine.cjs` — headless multi-tab engine (359 lines)
> - `LumoOS/lumo-server.cjs` — HTTP route wiring (search for `/browser/status`, ~line 1819)
> - `LumoOS/lumo-dist/index.html` — one script tag, cache-bust version
>
> This document is the spec + rationale. Where snippets are shown, they are copied from the
> real implementation.

---

## 1. What was built (one paragraph)

Lumo's header has a **files button** (`button.drawer-toggle-button`) that opens a right-side
drawer (`aside.right-drawer`). The vendor renders a Google-Drive file panel inside it
("All files in this chat / Add from Drive / Add from computer") with a
**"Context usage for this conversation"** block pinned at the bottom. We replaced the Drive
content with a full **Agent Browser**: a multi-tab, interactive, headless-Chromium browser
(tab strip, per-session URL bar, live screenshot view you can click/scroll/type into,
Back/Reload, Maximize-to-modal, per-tab close, activity log) — while keeping the vendor
panel shell (drawer, open/close animation) and the context-usage block 100% intact.

---

## 2. Ground rules (non-negotiable — read first)

1. **Never modify vendored chunks.** All vendor JS (`runtime.*.js`, `pre.*.js`, `index.*.js`,
   `unsupported.*.js`, numbered chunks like `4124.*.chunk.js`) carries `integrity="sha384-…"`
   + `crossorigin`. Editing one breaks SRI and the repo's integrity gate. The Drive panel
   source lives in such a chunk — we do **not** fork it.
2. **All our frontend code lives in exactly one file** with **no** `integrity` attribute:
   `assets/static/lumo-browser-panel.js`. Shipping changes = edit that file + bump its
   `?v=` in `index.html`. That's the whole release surface.
3. **Zero hardcoded colors.** Every color/radius/shadow is a Proton design token that the
   vendor CSS already defines: `--primary`, `--primary-minor-2`, `--background-norm`,
   `--background-weak`, `--border-weak`, `--border-norm`, `--text-norm`, `--text-weak`,
   `--text-hint`, `--signal-success`, `--signal-danger`, `--border-radius-md/lg`,
   `--shadow-lifted`. (Fallbacks like `var(--border-radius-md,8px)` are fine.)
4. **Never touch the context-usage block.** It is the last child of `.files-panel-content`
   (has class `mt-2`). The code actively re-shows it if anything ever hides it.
5. **Engine unavailable ⇒ zero footprint.** If the backend reports unavailable, the script
   injects no style, no DOM, no observers, no polling — it just retries every 8 s.
6. **Strict takeover contract.** If the vendor panel's DOM shape doesn't match the audited
   structure, refuse to take over rather than guess (gu = you might hide the wrong thing).

---

## 3. The audited vendor contract (re-audit on YOUR build!)

Before writing any code, open DevTools, click the header files button, and verify the
rendered structure of the Drive panel. On our build (Drive source = chunk `4124`,
module `2506`) it is:

```
aside.right-drawer
└─ ... 
   └─ .files-panel-content            ← takeover target (flex column)
      ├─ [0] header   : class contains "mb-4"   ("All files in this chat" + X close btn)
      ├─ [1] file list: class contains "flex-1" (Add from Drive / Add from computer …)
      ├─ …possible intermediate children…
      └─ [last] context box: class contains "mt-2"
             ("Context usage for this conversation", e.g. "58/128.0K tokens")
```

Drawer opener/closer in the header: `button.drawer-toggle-button` (toggles
`aside.right-drawer`).

The implementation encodes exactly this as a **strict classifier** — if the shape changes,
it refuses:

```js
function classifyKids(host) {
    const kids = [...host.children];
    const header = kids.length && kids[0].classList.contains('mb-4') ? kids[0] : null;
    const ctx    = [...kids].reverse().find((k) => k.classList.contains('mt-2')) || null;
    const list   = kids.find((k) => k !== header && k !== ctx && k.classList.contains('flex-1')) || null;
    return { header, ctx, list };
}
// tryPlace() bails out if (!ctx || !header)
```

**Takeover strategy:** don't fight the vendor — *let it render*, then:

- `header` and `list` kids → `style.display='none'` + `data-lbp-hidden="1"` attribute
  (tracked in `STATE.hiddenKids` so we can re-hide after vendor re-renders);
- our UI gets inserted with `host.insertBefore(ourUI, ctx)` — i.e. **before** the context box;
- the context box is never hidden, and `tryPlace()` un-hides it as a safety net:

```js
if (ctx.style.display === 'none') {        // safety: context usage must always show
    ctx.style.display = '';
    ctx.removeAttribute('data-lbp-hidden');
}
```

---

## 4. Architecture at a glance

```
┌ header ─────────────────────────────┐
│ [files button .drawer-toggle-button]│←── .lbp-fbadge badge dot (success=used, pulse=working)
└─────────────────────────────────────┘
aside.right-drawer
└─ .files-panel-content
   ├─ vendor header   (display:none, data-lbp-hidden)
   ├─ vendor list     (display:none, data-lbp-hidden)
   ├─ ┌ .lbp  (OUR UI — single DOM node, migrates between 3 homes) ┐
   │  │ .lbp-tabs     tab strip (+ new-tab btn, per-tab X)        │
   │  │ .lbp-toolbar  back · reload · URL input · max · close    │
   │  │ .lbp-stage    live JPEG frame / start page / busy / err  │
   │  │ .lbp-log      collapsible ACTIVITY log                   │
   │  └────────────────────────────────────────────────────────────┘
   └─ context box "Context usage…"  ← NEVER hidden, UI inserted before it

Maximize: the SAME .lbp node is moved into
  body > .lbp-modalwrap (fixed inset-0, z-index 4000, blurred backdrop)
        > .lbp-modalbox (role=dialog, aria-modal) 
… and moved back on restore. Escape closes the modal.

Backend: browser-engine.cjs = Playwright Chromium, one BrowserContext,
one Page per tab, JPEG frames tagged with a monotonic rev.
```

Three "homes" of the UI node: **panel** (`insertBefore` context box), **modal** (maximized),
**parked** (detached but referenced in `STATE.ui` — when the drawer unmounts entirely;
`scan()` re-places it on next open).

---

## 5. Backend: `browser-engine.cjs` spec

Playwright Chromium, `headless: true`, one shared `BrowserContext`, **one `Page` per tab**,
viewport `{ width: 1280, height: 800 }`, `deviceScaleFactor: 1`.

Key constants: `IDLE_CLOSE_MS = 5 * 60 * 1000`, `NAV_TIMEOUT_MS = 20000`,
`SETTLE_MS = 700` (wait after each mutating op so the page paints), `MAX_ACTIONS = 200`.

Playwright resolution order (so a missing module just flips status to unavailable, no crash):
`process.env.LUMO_PLAYWRIGHT_PATH` → `require.resolve('playwright')` →
`/home/z/.npm-global/lib/node_modules/playwright` → `/usr/local/lib/node_modules/playwright`.

**Core mechanics you must replicate:**

- **Monotonic frame rev.** Every screenshot bumps `state.rev` and swaps
  `state.frame = { rev, mime:'image/jpeg', b64, w:1280, h:800 }`. `captureFrame()` is
  `page.screenshot({ type:'jpeg', quality:62, timeout:15000 })` + defensive `page.url()` /
  `page.title()` reads (they throw mid-navigation — wrap in try/catch).
- **Promise-chain mutex for all mutating ops** so panel + future agent tools can't interleave:

  ```js
  function enqueue(fn) {
      state.lastUsedAt = nowMs();
      const run = state.chain.then(() => fn());
      state.chain = run.then(() => {}, () => {});
      return run;
  }
  ```

- **Snapshot is read-only and lock-free** (single-threaded atomic swap of `state.frame`;
  a poll racing a navigate simply sees old or new frame).
- **`normalizeUrl(input)`** — accepts bare domains and `localhost`
  (`foo.com` → `https://foo.com`), validates http/https only, else `null`.
- **URL-input handling** (`opNavigate`): invalid URL → `{ ok:false, error:'invalid URL' }`
  (logged as failed action); goto `domcontentloaded` + `SETTLE_MS` + captureFrame;
  on error still captureFrame (so the user sees the error page) and return `ok:false`.
- **Tab close semantics** (`opCloseTab`): remember closed tab in `state.tabHistory`
  (max 20, `unshift`) for restore chips; if the closed tab was active, activate
  `tabOrder[0]`; if **no tabs remain** → `state.frame = null; state.rev += 1;` so the
  panel falls back to its start page.
- **Idle lifecycle:** a 60 s sweeper closes the whole browser after 5 min idle
  (`lastUsedAt`), clears tabs, bumps `rev`, keeps `tabHistory`. Next API call relaunches
  transparently via `ensureBrowser()`. The panel must tolerate `frame:null` + empty
  `tabs` (that's its start-page state).
- **Action ring buffer:** every op logs `{ t: ISO, tool, summary(≤180 chars), ms, ok }`,
  capped at 200.

Exported API surface (what the server routes call):

| Export | Signature |
|---|---|
| `status()` | `{ available:true, engine:'playwright' }` or `{ available:false }` |
| `snapshot({since})` | see payload below |
| `navigate({url, tabId?})` | targets given tab or active tab; creates one if none |
| `newTab({url?})` | creates tab, becomes active |
| `closeTab({tabId})` | |
| `activateTab({tabId})` | captures a fresh frame of the newly active tab |
| `action({type,…})` | `click{x,y}` · `scroll{dx,dy}` · `key{key}` · `type{text,submit?}` · `back` · `reload` |
| `close()` | tear down browser + all tabs |

**Snapshot payload** (`snapshotSync`):

```js
{
  rev,                       // latest frame revision
  tabs: [{ id, title, url }],// insertion order
  activeTabId,
  url, title,                // of active tab ('' when none)
  active,                    // active tab's url
  frame,                     // { rev, mime, b64, w, h } — ONLY if frame.rev > since, else null
  actions: [ …last 60… ],
  tabHistory: [ …first 8 of… { url, title } ],
  engine: 'playwright',
}
```

The `since` filter is what makes 1.2 s polling cheap: no new frame ⇒ no base64 payload.

---

## 6. HTTP route wiring (`lumo-server.cjs`)

All under prefix **`/api/lumo/v1`**. Response envelope (matches the whole Lumo API):

```js
const ok = (extra) => JSON.stringify({ Code: 1000, ...extra });   // envelope: top-level fields
```

| Method & path | Body / query | Wraps |
|---|---|---|
| `GET  /browser/status` | — | `ok({ Status: engine.status() })` |
| `GET  /browser/snapshot?since=N` | — | `ok({ Snapshot: engine.snapshot({since}) })` |
| `POST /browser/navigate` | `{url, tabId?}` | result; HTTP 400 + `{ok:false,error}` on failure |
| `POST /browser/new_tab` | `{url?}` | result |
| `POST /browser/close_tab` | `{tabId}` | result |
| `POST /browser/activate_tab` | `{tabId}` | result |
| `POST /browser/action` | `{type, x?, y?, dx?, dy?, key?, text?, submit?}` | result |
| `POST /browser/close` | — | result |

The frontend's fetch wrapper mirrors this envelope:

```js
async function api(path, opts = {}) {
    // body present ⇒ POST + JSON; !r.ok ⇒ throw j.Error / j.error.message / 'HTTP '+status
    const j = await r.json();
    if (j && typeof j.Code === 'number' && j.Code !== 1000) throw new Error(j.Error || 'Code ' + j.Code);
    return j;
}
// callers read j.Status.available, j.Snapshot, etc.
```

---

## 7. Frontend: `lumo-browser-panel.js` spec

One IIFE, guarded against double-boot with `if (window.__LBP3) return; window.__LBP3 = true;`
(loaded with `defer`, so DOMContentLoaded timing is handled in boot).

### 7.1 Boot & gating

```js
async function tryMount() {
    if (STATE.available) return;
    try {
        const j = await api('/status');
        if (j?.Status?.available) {
            STATE.available = true;
            injectStyle(); startWatcher(); startPolling();
            document.addEventListener('keydown', onGlobalKey);  // Escape → un-maximize
        }
    } catch { /* not signed in / server busy */ }
    if (!STATE.available) setTimeout(tryMount, 8000);
}
```

Nothing touches the page until `/status` says available. **This is what makes the script
safe on login pages, error pages, and when the engine deps are missing.**

### 7.2 Stylesheet

One `<style id="lbp-style">` injected into `<head>`, contents = a template literal built
**exclusively from Proton tokens** (rule §2.3). Class inventory:

| Class | Purpose |
|---|---|
| `.lbp` | root: flex column, `border:1px solid var(--border-weak)`, `background:var(--background-norm)`, radius md |
| `.lbp-modalwrap` / `.lbp-modalbox` | maximize overlay: `position:fixed; inset:0; z-index:4000`, `color-mix` translucent `--background-weak` + `backdrop-filter:blur(4.5px)`; box = inset `clamp(12px,3.5vw,40px)`, radius lg, `--shadow-lifted`, `role=dialog` |
| `.lbp-tabs`, `.lbp-tab(.on)`, `.lbp-tabtitle`, `.lbp-tabx`, `.lbp-newtab` | tab strip; active tab gets `box-shadow:inset 0 -2px 0 var(--primary-minor-2)` |
| `.lbp-dot(.busy/.err)` | status dot per tab: `--signal-success` active, `--primary-minor-2` pulsing busy, `--signal-danger` non-http URL |
| `.lbp-toolbar`, `.lbp-ibtn` | toolbar row; 28×28 icon buttons w/ hover `--background-weak`, `:active` scale(.94), `:focus-visible` outline `--primary-minor-2` |
| `.lbp-urlbox`, `.lbp-urlico`, `.lbp-url` | address input; pill on `--background-weak`, focus ring `--primary-minor-2` |
| `.lbp-stage`, `.lbp-frame` | screenshot stage; `img` absolute inset-0, `object-fit:fill`, `cursor:pointer`, focusable |
| `.lbp-start*`, `.lbp-hist`, `.lbp-histchip` | empty state: globe icon tile, blurb, "example.com" input, restore-history chips |
| `.lbp-busy`, `.lbp-spin`, `.lbp-flash(.show)` | "Working…" pill (top-right), spinner, red error strip (`--signal-danger`) above stage bottom |
| `.lbp-log*`, `.lbp-chip`, `.lbp-logrow(.bad)` | collapsible ACTIVITY log; failed rows tinted `--signal-danger` |
| `.lbp-fbadge(.pulse)` | 8px dot absolutely positioned on `button.drawer-toggle-button` (script sets `position:relative` on it) |

Icons: inline SVG via a tiny `svgIcon(paths, size)` helper (`stroke:currentColor`, so they
inherit token colors) with a path map `IC = { x, plus, back, reload, maximize, minimize, globe, external }`.

### 7.3 UI tree (`buildUI()`)

```
div.lbp [data-lbp=root, role=region, aria-label="Agent browser"]
├─ div.lbp-tabs [data-lbp=tabs]
│   └─ button.lbp-newtab ("+" → actNewTab())     ← tab chips re-rendered before this
├─ div.lbp-toolbar
│   ├─ btn back → actAction('back')   ├─ btn reload → actAction('reload')
│   ├─ div.lbp-urlbox > globe-icon + input.lbp-url (Enter → actGo(value))
│   ├─ btn maximize [data-lbp=maximize] → toggleMaximize()
│   └─ btn close → closeDrawer()
├─ div.lbp-stage
│   ├─ img.lbp-frame (alt="Live browser view", tabIndex=0)
│   ├─ div.lbp-start [data-lbp=start]  (globe tile, h3 "Agent Browser",
│   │      p, .lbp-starturl input → actNewTab(v), div.lbp-hist [data-lbp=hist])
│   ├─ div.lbp-busy (spinner + "Working…")     └─ div.lbp-flash [data-lbp=flash]
└─ div.lbp-log [data-lbp=log]
    ├─ div.lbp-loghead ("ACTIVITY" + count [data-lbp=logcount] + chevron; click toggles .open)
    └─ div.lbp-logbody [data-lbp=logbody]
```

Everything interactive has `title` + `aria-label`; the img and inputs are keyboard-reachable.
Every mutating click goes through `guarded(fn)` which increments `STATE.opsPending`
(shows busy pill + pulses badge), flashes errors via `showFlash()`, and always decrements.

### 7.4 User interactions → engine calls

```js
actGo(v)        // URL bar Enter: tabs exist ? POST /navigate {url:v, tabId:activeTabId}
                //                              : POST /new_tab {url:v}   (first tab = new tab)
actNewTab(url)  // POST /new_tab {url:url||''}
actAction(type) // POST /action {type}                       (back / reload)
```

**Live view input mapping** (the part that makes it a real browser, not a preview):

```js
// click: map from displayed <img> rect to engine viewport (1280×800), then:
actAction('click', { x, y });   // clamped server-side
// wheel: e.preventDefault(); throttle to ≥140 ms between sends:
actAction('scroll', { dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
// keyboard on focused img: never hijack ctrl/meta/alt combos;
//   printable key  → actAction('type', { text: e.key });
//   special keys   → actAction('key', { key: e.key })  // Enter, Backspace, Tab, Arrows, Escape, Home, End
```

### 7.5 Maximize modal

```js
function maximize() {
    const wrap = el('div', 'lbp-modalwrap');  wrap.setAttribute('data-lbp', 'modal');
    const box  = el('div', 'lbp-modalbox');   box.setAttribute('role','dialog');
    box.setAttribute('aria-modal','true');    box.setAttribute('aria-label','Agent browser — maximized');
    box.appendChild(STATE.ui);                // MOVE the same node out of the panel
    wrap.appendChild(box); document.body.appendChild(wrap);
    STATE.maximized = true;
    // swap maximize icon → minimize; wrap.mousedown on backdrop (target===wrap) restores
}
function restoreFromModal() {
    STATE.maximized = false;  document.querySelector('[data-lbp="modal"]')?.remove();
    if (!tryPlace()) parkUI();   // drawer may be gone → park until next open
}
```

- `reassert()` early-returns while maximized (the UI legitimately lives outside the panel).
- Global `keydown` listener: `Escape` while maximized → restore.
- Polling cadence treats maximized like "drawer open" (fast poll).

### 7.6 Closing the panel

`closeDrawer()` restores from modal first, then synthetic-clicks the **vendor's own close
button** so the drawer animates the vendor way:

```js
const headerKid = STATE.hiddenKids[0];                       // the hidden vendor header
const xbtn = headerKid
    ? [...headerKid.querySelectorAll('button')].filter(b => b.querySelector('svg')).pop()
    : null;                                                  // last icon-button in it = the X
const target = xbtn || fallbackLastIconButtons || document.querySelector('button.drawer-toggle-button');
if (target) { target.click(); STATE.drawerClosedAt = Date.now(); return; }
showFlash('Close the panel with the header button.');
```

(`STATE.drawerClosedAt` exists to gate auto-open behavior/cooldowns; our filter excludes any
button inside `[data-lbp-hidden]`/`.lbp` so we never click our own UI.)

### 7.7 Takeover mechanics (the heart)

```js
function findHost() {   // prefer a laid-out host (drawer actually open) that doesn't already hold our UI
    const hosts = [...document.querySelectorAll('.files-panel-content')];
    const visible = hosts.filter(h => h.getClientRects().length > 0 && !h.contains(STATE.ui));
    return visible[0] || hosts.find(h => !h.contains(STATE.ui)) || null;
}

function tryPlace() {
    if (STATE.ui && STATE.ui.isConnected && STATE.host?.contains(STATE.ui)) return true; // already placed
    const host = findHost();          if (!host) return false;
    const { header, ctx, list } = classifyKids(host);
    if (!ctx || !header) return false;                     // shape changed → REFUSE (rule §2.6)
    for (const k of [header, list]) {                      // hide vendor pieces (idempotent)
        if (k && k.style.display !== 'none') {
            k.style.display = 'none'; k.setAttribute('data-lbp-hidden','1');
            if (!STATE.hiddenKids.includes(k)) STATE.hiddenKids.push(k);
        }
    }
    if (ctx.style.display === 'none') { ctx.style.display=''; ctx.removeAttribute('data-lbp-hidden'); }
    if (!STATE.ui) STATE.ui = buildUI();
    host.insertBefore(STATE.ui, ctx);                      // BEFORE the context box. Always.
    STATE.host = host;  return true;
}

function reassert() {                                      // runs on EVERY body mutation
    if (STATE.maximized) return;
    if (!tryPlace()) { if (STATE.ui && !STATE.ui.isConnected) parkUI(); return; }
    const { ctx } = classifyKids(STATE.host);
    if (ctx && ctx.style.display === 'none') ctx.style.display = '';   // ctx must never stay hidden
    for (const k of STATE.hiddenKids) {                    // vendor re-render may have re-shown kids
        if (!k.isConnected) { STATE.hiddenKids = STATE.hiddenKids.filter(x => x !== k); continue; }
        if (k.style.display !== 'none' && k.hasAttribute('data-lbp-hidden')) k.style.display = 'none';
    }
}

function startWatcher() {
    STATE.mo = new MutationObserver(() => scan());
    STATE.mo.observe(document.body, { childList: true, subtree: true });
}
function scan() { reassert(); if (!STATE.ui?.isConnected) tryPlace(); updateBadge(); }
```

**Badge** (`updateBadge()`): ensure a `span.lbp-fbadge` exists on `button.drawer-toggle-button`
(set its `position:relative` once); visible iff `STATE.frameRev > 0 || opsPending > 0`;
`.pulse` class while ops are pending (agent is driving).

### 7.8 Rendering from snapshot

```js
function renderSnapshot(snap) {
    STATE.tabs = snap.tabs || [];  STATE.activeTabId = snap.activeTabId;  STATE.actions = snap.actions || [];
    renderTabs();
    // URL bar refresh rule — NEVER clobber an in-progress edit:
    //   refresh only when input not focused OR active tab changed since last render
    //   (tracked via STATE.lastActiveFor).
    // stage: tabs.length ? show img / hide start : hide img / show start (+ history chips)
    if (hasTab && snap.frame && snap.frame.rev > STATE.frameRev) {   // rev-dedup: only new frames
        STATE.frameRev = snap.frame.rev;
        img.src = 'data:' + snap.frame.mime + ';base64,' + snap.frame.b64;
        updateBadge();
    }
    // no tabs → render ≤4 restore chips from snap.tabHistory (label = URL host, click = actNewTab(url))
    renderLog();
}
```

`renderTabs()` rebuilds the `.lbp-tab` chips: active gets `.on`; dot gets `.err` when the
tab URL isn't http(s); tab click → `POST /activate_tab`; per-tab ✕ →
`POST /close_tab` with `e.stopPropagation()`. `renderLog()` draws the last 40 actions
reversed (time `HH:MM:SS` from ISO, uppercase chip label via
`ACT_LABELS = { navigate:'nav', new_tab:'new', close_tab:'close', activate_tab:'focus',
click:'click', scroll:'scroll', type:'type', key:'key', back:'back', reload:'reload',
idle_close:'idle' }`, summary, `ms`), `.bad` class for failed ops.

### 7.9 Polling

```js
function drawerVisible() {            // width check survives vendor open/close animations
    const d = document.querySelector('aside.right-drawer');
    return !!d && d.getBoundingClientRect().width > 8;
}
// pollTick: GET /snapshot?since=STATE.frameRev → renderSnapshot(snap.Snapshot)
//           busyFetch re-entrancy guard; errors stored, never thrown
function schedule() {
    const wantFast = drawerVisible() || STATE.maximized || STATE.opsPending > 0;
    setTimeout(pollTick, wantFast ? 1200 : 4000);   // fast when visible/busy, cheap otherwise
}
function pollNow()  { setTimeout(pollTick, 60); }   // kick right after any user action
```

### 7.10 STATE field inventory (for a faithful reimplementation)

`available, styled, ui, host, hiddenKids[], mo, pollTimer, polling, frameRev, tabs[],
activeTabId, actions[], maximized, opsPending, busyFetch, badge, drawerClosedAt,
lastResult, wheelAt, lastActiveFor` — plus the API base `const API='/api/lumo/v1/browser'`.

---

## 8. Shipping: cache busting & patch-chain

`index.html` carries the script tag **without** `integrity` (that's deliberate — vendor
chunks have SRI, ours doesn't, so the browser re-fetches on version change):

```html
<script src="/assets/static/lumo-browser-panel.js?v=5" defer></script>
```

Release procedure for any frontend change:

1. Edit `lumo-browser-panel.js` only.
2. Bump `?v=` (e.g. `v=5` → `v=6`). One-liner: `sed -i 's|lumo-browser-panel.js?v=[0-9]*|lumo-browser-panel.js?v=6|' LumoOS/lumo-dist/index.html`
3. `node --check LumoOS/lumo-dist/assets/static/lumo-browser-panel.js`
4. Run the integrity gate: `node LumoOS/diag-all-runtime-integrity.cjs` → must report
   **0 mismatch / 0 missing** (proves no vendor chunk drifted).
5. `cd LumoOS && node --test tests/*.test.mjs`

---

## 9. Verification checklist (E2E, manual or via a headless browser agent)

- [ ] Reload Lumo with the new `?v=`; DevTools console shows `[lbp3] engine available — takeover armed` (and shows **nothing** if engine deps missing).
- [ ] Click header files button → drawer opens showing the browser UI, **not** Drive content.
- [ ] **"Context usage for this conversation" is still visible at the panel bottom** at all times (before/after takeover, after vendor re-renders, after maximize/restore, after close/reopen).
- [ ] Type an address in the start page or URL bar → frame appears; rev-dedup means no flicker on no-op polls.
- [ ] Click a link inside the frame, scroll with the wheel, focus frame + type → engine log shows click/scroll/type actions and the view updates.
- [ ] "+" opens a second tab; per-tab ✕ closes; closing last tab returns to the start page with restore chips.
- [ ] Maximize → full-screen modal (dialog role, blurred backdrop), Escape / backdrop click / minimize button restores into the panel; drawer reopen after full unmount re-attaches UI.
- [ ] Panel ✕ closes the drawer (vendor animation), badge on the header button persists while a session exists.
- [ ] Dark mode + light mode both render with token colors only (grep your CSS for `#[0-9a-f]{3,6}` → only fallbacks allowed).
- [ ] Engine idle ≥5 min → next interaction transparently relaunches (start page shows, then works again).

---

## 10. Pitfalls we hit (learn from these)

1. **Vendor re-renders restore `display`** on the kids you hid — hence `reassert()` re-hiding
   tracked kids on every mutation, and the ctx-box un-hide safety net.
2. **Don't guess the DOM.** The strict `classifyKids` contract check exists because a
   vendor class rename would otherwise cause us to hide the wrong node (including the
   context-usage block). Refuse > corrupt.
3. **URL bar focus race:** the poll loop re-renders ~1×/s; without the
   "not focused OR tab changed" rule you'd fight the user's typing.
4. **`page.url()`/`page.title()` throw mid-navigation** — always try/catch them.
5. **Frame dedup by rev**, not by URL: SPA navigations change the pixels without changing
   the URL; `since=` + monotonic rev handles both and keeps polling cheap.
6. **Coordinate mapping must use the img's live `getBoundingClientRect()`** (panel and
   modal have different sizes; the engine viewport is always 1280×800).
7. **Idle teardown is a feature:** after it, `tabs=[]` and `frame=null` with a bumped rev —
   the panel must show its start page gracefully, and the next call relaunches.
8. **Never `focus()` without `preventScroll`** — it yanks the drawer scroll position.
9. **Wheel handler must `{ passive:false }`** or `preventDefault()` is ignored and the
   host page scrolls instead of the guest page.
10. **The `?v=` bump is mandatory** on every JS edit — defer + no-integrity otherwise
    serves a stale cached copy and you'll debug ghosts.

---

## 11. Current state

- Frontend: `lumo-browser-panel.js` **v3** (guard `window.__LBP3`, log tag `[lbp3]`),
  shipped at `index.html` `?v=5`.
- Backend: `browser-engine.cjs` v3 (Playwright multi-tab), routes in `lumo-server.cjs`.
- Committed: `6403a55`. Integrity gate last run: 2585 files checked / 0 mismatch / 0 missing.
