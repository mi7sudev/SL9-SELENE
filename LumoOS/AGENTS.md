# ProtoLumo — Project Charter (governs all agent work in this workspace)

## Mission

Self-host Proton Lumo as a **fully self-contained, proprietary instance** for our own
LAN use: complete control over infrastructure, providers, models, configuration, and
branding. **No dependency on Proton's Lumo service.** The existing Proton Lumo
architecture is the foundation — we adapt it, we do not rebuild it.

## Architecture rule (primary)

Proton Lumo's existing architecture and infrastructure are the **source of truth**.

- Before adding any feature, enhancement, or refactor: find how Proton Lumo already
  handles the same concern in `WebClients/` (sibling components, stores, API client,
  entrypoint/auth flow, webpack/SRI pipeline) and **extend or adapt that approach**.
- Never introduce a parallel system where Proton has a native one.
- Source-level changes (in `WebClients/applications/lumo/src/`) survive rebuilds and
  are preferred. Dist-level patches (`patch-*.cjs` against minified chunks) are
  transitional — they are wiped by any rebuild, must live in patch tooling, and
  should be lifted into source when the affected area is next touched.
- After any dist-affecting change: run `node bust-cache-admin.cjs` (cache/SRI bump)
  and `node diag-all-runtime-integrity.cjs` — 0 mismatches is required.

## Providers & models

- **There is no built-in model and no "NVIDIA model".** Models exist only through AI
  providers configured in **Admin Settings → AI Provider** (BYOK).
- BYOK is Proton's own alternative-provider mechanism; our system extends it into an
  **instance-wide, admin-managed** provider/model catalog. The admin owns providers
  (name, base URL, API key) and the allowed model lists; users can only use
  admin-selected models; there are no defaults.
- Keep every path **model- and provider-agnostic**: no provider names, no
  provider-specific defaults in client or server code. Provider-specific quirks
  (e.g. thinking parameters) are handled generically with graceful fallbacks.
- Answer Mode semantics: Fast = normal thinking (plain request); Thinking = deep
  think (`reasoning_effort:"high"` + a provider-agnostic system nudge), working for
  any model from any provider.

## MCP (tools + connections)

- MCP servers are **admin-owned infrastructure**, governed by the same rules as AI
  providers: configured in the admin panel, stored in gitignored `data/lumo.db`
  (SQLite, `store.cjs`; `mcp_servers` rows), env secrets server-side only (APIs
  return key names, never values). See `MCP.md`.
- The admin curates servers; every signed-in user's chats may use the enabled tools.
  Tool execution happens **server-side** in the BYOK proxy (`mcp-manager.cjs` +
  `@modelcontextprotocol/sdk` — the root's only npm dependency); secrets and MCP
  child processes never reach the client.
- **Connections** (`mcp-connections.cjs`) are the control plane and stay separate
  from server definitions: per-user records in `data/lumo.db` (`mcp_connections`
  rows) with AES-256-GCM encrypted credentials (`data/secret.key` holds the key,
  deliberately outside the database). Users
  connect/reconnect/disconnect through reserved `lumo__*` chat tools (confirmation
  required before any credential step; `ready` only after real connect + discovery);
  only admins register server definitions — chat can never add URLs, commands,
  env, or transports. `api_key`/`oauth` servers expose tools only against the
  requester's own ready connection; write-capable tools (annotations) additionally
  require explicit admin approval, enforced at advertisement **and** execution.
- Client-side pieces (`patch-mcp-toolcards.cjs`: native tool-card rendering via
  synthetic `zap_tool` SSE frames; `patch-mcp-promptbar.cjs`: Tools-menu
  "MCP connections" view + user mute toggles + `zap_mcp` request-scoped deny-list,
  with `patch-mcp-promptbar.manifest.json` recording per-file sha256 before/after)
  are dist patches — transitional, same rebuild rules as the other `patch-*.cjs`
  scripts; run the manifest-producing patch chain and the integrity diag after
  any rebuild.

## Security invariants

- Provider API keys exist **only** server-side in gitignored `data/lumo.db` (the
  SQLite store, `store.cjs` — admin config, users, per-user data, MCP server
  definitions; legacy `*.json` stores were migrated on first boot and live on as
  inert `*.migrated.json` backups), MCP env secrets only in that same database,
  per-user connection credentials only AES-256-GCM encrypted in it (key in
  `data/secret.key`, kept outside the DB).
  Never in client bundles, source, or root scripts. Admin GETs return `hasApiKey` /
  `envKeys`, never values; logs pass through redaction and must never contain
  connection credentials, setup URLs' tokens in chat, or OAuth state values.
- `data/` (password hashes, keys, `lumo.db*`, `backups/`) and `*.log` (contains
  message snippets) are never committed.
- Admin gating is enforced server-side (`requireAdmin`), including self-protection
  (admin cannot demote/disable/delete themselves).

## Working process

- Use the Matt Pocock skills repo (https://github.com/mattpocock/skills) as the
  reference methodology — especially `code-review` (two-axis: Standards vs Spec,
  run as parallel sub-agents; sibling Proton code is the standards source) — for
  analyzing the codebase and reviewing changes.
- Every behavior change is verified through the real UI plus server logs; test
  users/data are cleaned up afterwards (`data/` ends admin-only).
