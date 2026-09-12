# AGENTS.md — SL9-SELENE

This repository is **fully self-contained**. Everything needed to run the
Lumo web app lives in this repo — there are **no submodules and no
external dependencies on other repositories**. If you cloned this repo and
a folder looks "missing" (e.g. `LumoOS/`), that is a stale clone from the
old history; re-clone fresh and it will be there.

## What this is

A Proton-Lumo-style AI chat application ("Lumo") running entirely local:

- **Frontend** — pre-built SPA in `LumoOS/lumo-dist/` (served as static
  files; you do NOT need to build it)
- **Backend** — `LumoOS/lumo-server.cjs`, a self-contained Node.js server
  (no TypeScript build step; run it directly)
- **Database** — SQLite via Node's built-in `node:sqlite` (no native
  installs). File auto-creates at `LumoOS/data/lumo.db` on first boot.
- **MCP** — optional automation tool server (`LumoOS/automation-mcp-server.cjs`)
  for external MCP clients; not required to run the app.

## Requirements

- **Node.js >= 22.5** (uses built-in `node:sqlite`). Node 24 recommended.
- (Optional) npm — only for the two helper packages below.

## Quick start (any OS)

```sh
node LumoOS/lumo-server.cjs
```

Then open **http://localhost:8090** — that's it.

The server serves on port 8090 by default and uses repo-relative paths:

| Setting | Default | Override via |
|---|---|---|
| Port | `8090` | `LUMO_PORT` env var |
| Frontend dist | `LumoOS/lumo-dist` (script-relative) | `LUMO_DIST_DIR` |
| Data dir (SQLite) | `LumoOS/data` (script-relative) | `LUMO_DATA_DIR` |

`data/` auto-creates on first boot with an empty database; the first user
to sign up becomes the admin (see `/guest` → sign-up flow).

## Optional: npm helper packages

The server runs fine without any `npm install`. Two optional npm packages
unlock extra features:

| Package | Needed for | Without it |
|---|---|---|
| `openpgp` | PGP key generation at signup | Server boots; PGP features unavailable (warning logged) |
| `@modelcontextprotocol/sdk` | `automation-mcp-server.cjs` (external MCP tool access) | Main app unaffected |

To enable:

```sh
cd LumoOS && npm install
```

## Run with npm (same server, convenience alias)

From the repo root:

```sh
npm run dev
```

(`package.json` also holds the legacy Next.js/Prisma scaffold configs —
`build`/`start`/`db:*` scripts target that scaffold, not the Lumo server.
The Lumo app is the actual product: use `dev` or the direct node command.)

## Direct REST API connections ("connections")

The agent can call external REST APIs through governed connections:

- **Admin adds a connection** — either in chat (`lumo__connection_create`:
  agent collects name, base URL, auth header, allowed methods, then asks for
  confirmation) or via Settings → MCP Servers / the import JSON box
  (`transport: "rest"`). The API key itself is **never entered in chat** — the
  agent returns a one-time setup URL where the key is entered in the browser
  and stored AES-256-GCM-encrypted (`data/secret.key`).
- **What the agent gets** — one governed tool per connection,
  `<serverid>__api_request` (method constrained to the allowlist, path
  relative to the base URL, query/body/extraHeaders). The credential is
  injected server-side and never appears in args, results, or logs. Reach is
  SSRF-guarded; only allowed methods pass.
- **Validation is honest** — a connection only reaches `ready` after a real
  authenticated health check (`healthPath`); a rejected key becomes
  `needs_reauth`, never a silent success.
- **MCP servers still work as before** — stdio/HTTP MCP servers with tool
  discovery, per-user api_key/OAuth connections, tool cards in the UI.
- **Writes require approval** — on rest connections, POST/PUT/PATCH/DELETE
  wait for an explicit user yes in chat (`confirmWrites`, default on; the
  admin can disable per connection). Both the request and the confirmation
  land in the audit trail.
- **Every agent run is durable** — each MCP-engaged chat creates a run record
  (status: running → completed/failed/aborted) plus a redacted audit event
  per tool call (`tool_start` / `tool_done` / `tool_error` /
  `approval_requested` / `approval_granted`). Message content is never
  stored (messages are end-to-end encrypted by design). APIs:
  `GET /api/lumo/v1/runs`, `GET /api/lumo/v1/runs/:id`,
  `GET /api/lumo/v1/admin/runs`.
- **Runs are visible in the app** — Settings → "Agent runs" lists your runs
  and links to the server-rendered timeline at `/runs` (list) and
  `/runs/<id>` (full event trail). Chats carry their conversation id
  (`zap_conv_id`) so runs are attributed to the chat they belonged to.
- **After any dist-affecting change**: run `node bust-cache-admin.cjs` and
  `node diag-all-runtime-integrity.cjs` — 0 mismatches is required (the SPA
  carries SRI hashes; a stale hash white-screens the app).

## Verification checklist (for agents)

After starting, confirm:

1. `curl http://localhost:8090/` → 302 redirect to `/guest`
2. `curl http://localhost:8090/guest` → HTTP 200 (SPA HTML)
3. `curl http://localhost:8090/api/lumo/v1/spaces` → HTTP 401
   (`{"Code":8002,"Error":"Unauthorized"}`) — proves API routing + auth work
4. A static asset from the HTML (`/assets/static/…js`) → HTTP 200

## Repository layout

```
LumoOS/                  the Lumo app (fully vendored, no submodule)
  lumo-server.cjs        backend entry point — node this file
  store.cjs              SQLite persistence layer (node:sqlite)
  mcp-manager.cjs        admin MCP server management
  mcp-connections.cjs    user MCP connections + BYOK provider proxy
  automation-mcp-server.cjs  optional MCP stdio tool server
  lumo-dist/             pre-built frontend (do NOT need to rebuild)
  data/                  runtime SQLite DB (gitignored, auto-created)
  *.cjs fix-*/patch-*    one-shot patch scripts used during development
db/ download/ examples/  legacy scaffold assets
prisma/                  legacy scaffold schema (unused by Lumo)
tests/                   runtime integration tests for the Lumo server
src/                     legacy Next.js scaffold (unused by Lumo)
```

## Troubleshooting

- **"LumoOS is missing"** — stale clone from before the vendoring; re-clone.
  This repo has no `.gitmodules`; `git submodule` commands are not needed
  and will do nothing.
- **Port already in use** — `LUMO_PORT=3000 node LumoOS/lumo-server.cjs`
  (or any free port).
- **`node:sqlite` not found** — Node too old; install Node >= 22.5.
- **Fresh boot has no users** — expected; first signup = admin.
- **Windows paths** — all defaults are script-relative; nothing is
  hardcoded to a machine. `LUMO_DIST_DIR`/`LUMO_DATA_DIR` accept both
  forward- and back-slash paths.

## Notes on history

This repo superseded an earlier `mi7sudev/LumoOS` repository which is
**outdated and unrelated** — ignore it entirely; all current source of
truth lives here in SL9-SELENE.
