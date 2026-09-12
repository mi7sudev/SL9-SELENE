# MCP (Model Context Protocol) servers in self-hosted Lumo

This instance can act as a full **MCP client**: the admin configures MCP
servers, and chats can transparently use the tools those servers expose. The
model decides when to call a tool; execution happens server-side (where the
secrets and the server processes live); the chat renders native tool cards
for every call. There is no dependency on Proton's hosted services.

## Architecture (one paragraph)

`Settings → AI Provider → MCP servers` (admin panel) → `data/mcp-servers.json`
→ `mcp-manager.cjs` (official `@modelcontextprotocol/sdk`) ← stdio / Streamable
HTTP / SSE transports. During a streaming chat, `lumo-server.cjs`'s BYOK proxy
advertises the enabled tools to the model (`tools` + `tool_choice:"auto"`),
accumulates `delta.tool_calls`, executes each call through the manager, feeds
the results back as `role:"tool"` messages (max 5 rounds), and streams the
final answer to the client. Tool activity reaches the UI as synthetic
`zap_tool` SSE frames which `patch-mcp-toolcards.cjs` (applied to chunks
1306/4124) converts into Lumo's native tool-call blocks.

## Adding a server

Admin → Settings → AI Provider → **MCP servers** section → **+ Add server**.

- **Transport `stdio`** — runs a local command (spawned directly, no shell).
  Example (filesystem server):
  - Command: `npx`
  - Arguments (one per line): `-y`, `@modelcontextprotocol/server-filesystem`, `D:\some\path`
  - **Windows note:** `npx`, `uvx` and other `.cmd` shims work through the
    SDK's cross-spawn wrapper. If a command fails to spawn, use
    `cmd` with first argument `/c` (e.g. command `cmd`, args `/c`, `npx`, `-y`, …).
- **Transport `http`** — a remote MCP endpoint URL (Streamable HTTP, with a
  legacy SSE fallback). Example: `https://example.com/mcp`.
- **Environment variables** — for stdio servers; values are stored only in
  `data/mcp-servers.json` (gitignored), are never returned by any API (only
  key *names*), never exported, and are redacted from logs.
- **Trusted local endpoint** (http only) — by default loopback/private URLs
  are refused (SSRF guard). Check this only for MCP endpoints you host yourself.
- **Per-user connection — who authorizes this server** (http only) — how the
  credentials for reaching this server are obtained (see the next section):
  - `Shared` (default, `auth: none`) — one instance-wide connection the admin
    manages; all signed-in users' chats can use the tools.
  - `API key` (`auth: api_key`) — each user connects with their own key via a
    one-time, server-rendered setup page; stored encrypted, never in chat.
    Optional generic header name/prefix (default `Authorization: Bearer`).
  - `OAuth` (`auth: oauth`) — each user authorizes through the provider's
    authorize/token endpoints (admin-registered client id/secret, scopes,
    optional PKCE). Chat can never register or change these URLs.

After saving, press **Connect**. The status dot shows
`connected / connecting / disconnected / error / disabled`. **Test** reconnects
and re-discovers capabilities. Discovered tools appear as chips — untick a
tool to disable it (**disabled tools are never sent to the model at all**, so
they cannot be invoked, even by a prompt injection).

## Permissions model

- Server level: `Enabled` toggle — a disabled server never connects.
- Tool level: per-tool chips (default **enabled** for newly discovered tools).
- **Write-capable gating** — tool annotations from the MCP server drive a
  classification shown on the admin chips: `readOnlyHint: true` → *read-only*
  (usable once discovered); `readOnlyHint: false` or `destructiveHint: true`
  → *write* (⚠ badge; **disabled unless the admin explicitly enables the
  tool**); unannotated → *unclassified* (default-on, treat with care). The
  gate is enforced when tools are advertised **and** again immediately before
  execution — a stale or fabricated tool call for a non-approved tool is
  rejected before any external action.
- User-level mutes (below) are the third axis; all three are evaluated by one
  canonical policy function used everywhere.
- There are currently no interactive confirmation dialogs in chat; per-tool
  disable is the enforcement mechanism. Treat any server you add as trusted
  code with the permissions of the `lumo-server` process.

## Per-user connections (control plane)

Servers with `api_key`/`oauth` auth are **connected per user**. Two planes are
kept separate: the *data plane* (MCP tool calls, above) and the *control plane*
(`mcp-connections.cjs`) which manages the authenticated links. Server
definitions and connection records live in the instance's SQLite database
(`data/lumo.db`, see `store.cjs`) as separate tables — `mcp_servers` and
`mcp_connections`:

- `mcp_servers` rows — definitions (admin-owned, unchanged document format
  plus the `auth` fields; the whole definition is the row's `doc`).
- `mcp_connections` rows — one record per user connection:
  `{ id, serverId, ownerUid, status, credential, error, createdAt, updatedAt,
  lastValidatedAt, lastDiscoveredAt }` (indexed by `(server_id, ownerUid)`).
  Credentials are AES-256-GCM encrypted inside the record's `doc`; the key
  lives in `data/secret.key` (created on first use, 32 random bytes) —
  deliberately NOT in the database, so the key and the ciphertext never share
  a file. On first boot the legacy `mcp-servers.json` / `mcp-connections.json`
  stores were imported and renamed to `*.migrated.json` (inert backups).

**Lifecycle:** `available` (implicit, nothing stored) → `authorizing` (waiting
for the user to finish the setup/authorize URL) → `connected` (brief
transitional state while validating) → `ready`; failures map to `failed`
(including `error.code: "discovery_failed"` when the transport connects but
tool discovery does not answer, and `"auth_denied"` when the user denies or
abandons the provider's authorization page — the one-time state is consumed,
nothing is stored, and reconnecting restarts cleanly), `needs_reauth`
(credential rejected — e.g. 401/403 from the server), or `revoked`. `ready` is
reached **only** after a real transport connect + tool discovery succeed (the
record's `lastDiscoveredAt` is stamped only by an actual `tools/list` answer) —
the agent can never claim success earlier, and the "Connected" web page is
served only after that same validation. Data-plane tools of an auth server are
advertised/executed only when the requester owns a `ready` connection (own
record wins over an admin's `'tenant'` record). Flow tokens are single-use,
expiring (OAuth state 10 min, setup 15 min), and capped per account (20 live
authorizations); `/mcp/*` pages are fixed-window rate-limited per IP (60/min).

**Agent-managed setup** — users can say "connect my <service>", "show my
connected services", "reconnect <service>", or "disconnect <service>" in chat.
The model drives four reserved control tools (`lumo__*` prefix, executed
server-side before any MCP dispatch, rendered as native tool cards):

- `lumo__connections_list` — allowlisted definitions + the user's honest
  connection states.
- `lumo__connection_connect {serverId, confirm}` — requires an explicit
  confirmation round-trip in chat (`confirm:false` → `needsConfirmation`).
  `api_key` servers return a one-time setup URL; `oauth` servers return an
  authorize URL (server-generated one-time `state`, PKCE `S256`, 10-min TTL);
  `none` servers are instance-shared and answered with an explanation.
- `lumo__connection_status {serverId}` — honest state + safe error codes.
- `lumo__connection_disconnect {serverId, confirm}` — wipes the credential,
  closes the per-connection transport, revokes the record.

One-time setup pages (`GET|POST /mcp/setup/<flowId>`, 15-min single-use token,
rate-limited) are minimal server-rendered HTML; the key is POSTed directly to
this server and never transits chat, the model, localStorage, or URLs. "Connect
this MCP server" resolves only against admin-configured servers — chat can
never register commands, URLs, environments, or transports.

**Catalog endpoint** — `GET /api/lumo/v1/mcp/connections` (any active signed-in
user) returns `{ Account, Version, Connections[] }` for the prompt bar. Each
connection is a redacted projection: `Id, Name, Auth, Status, Error (code only),
ToolCount, Tools (names only, null when not discovered), LastDiscoveredAt,
LastValidatedAt` — never commands, urls, env, schemas, or credentials. `Status`
is one of `ready`, `authorizing`, `needs_reauth`, `failed`, `unavailable`,
`not_discovered`, `available` (definition exists, not connected yet), or
`revoked` (this user disconnected; they can reconnect). Disabled servers are
omitted. The endpoint never triggers a connect; `not_discovered` means exactly
that. `Version` hashes the server/permission/record-update state so the UI can
cheaply detect changes.

## Prompt bar: MCP connections

The Tools menu has an **MCP connections** view (third view of the existing
tool popover, `patch-mcp-promptbar.cjs`): one row per enabled server with an
honest status dot + ARIA text (`Ready`, `Authorizing…`, `Needs sign-in`,
`Unavailable`, `Not checked`, `Available`), tool-name hints, a Retry row when
the catalog fetch fails (the view is never hidden on error), and a
per-connection toggle (muted rows dim, matching the disabled-connector
convention). Status dots reuse the app's `--signal-*` theme tokens, so they
match the admin panel and adapt to light/dark themes. Toggles write
`{account, muted[]}` to `localStorage["lumo.mcp.disabled.v1"]` (uid-stamped —
resets on account switch; multi-tab sync via the storage event; malformed
storage is discarded and self-heals). The muted ids travel to the server as a
**request-scoped deny-list** (`zap_mcp: {off: string[]}`, ≤64 entries, deduped,
malformed → ignored): the chat loop skips muted servers *before* any connect,
strips the field from every request path, and a fabricated call for a muted
server is refused at execution. The footer makes the contract explicit:
managed by your administrator; toggling off only hides tools from your chats.

## Import / export

- **Import** accepts the standard `{"mcpServers": {name: {command, args, env, url, type}}}`
  format. Imported servers always start **disabled** — nothing imported ever
  executes until you explicitly enable it.
- **Export** downloads a standard-format file with all env values blanked.

## Behavior in chat

- Streaming chats on admin-provided models get the tools allowed by the
  canonical policy: admin-enabled server ∩ admin-enabled tool ∩ auth gating
  (shared, or the requester's own `ready` connection) ∖ request-muted. Muted
  servers are skipped *before* any connect/spawn; `muted=N` is visible in the
  per-request log line. Auto-connect happens on demand, with a 60s backoff
  after a failed attempt. Title generation and non-stream calls never see
  tools.
- Up to **5 tool rounds** per message; each tool call times out after **60s**;
  results are truncated to **16,000 chars** (4,000-char preview in the card).
- If the provider rejects `tools`, the proxy automatically retries without
  them (same compatibility mechanism as the Answer Mode parameters).
- Tool results are framed as *untrusted external data* both to the model
  (system note + per-result framing) and in the UI; control-plane results are
  framed as "[Connection manager result]".

## Debugging

- Logs: `lumo-server.log` — `[MCP]` lines (connects, discoveries, tool calls,
  failures), `[MCP-CONN]` lines (connection flows: started, validation failed,
  ready) and `control lumo__* -> ok|error` audit lines per request. All lines
  pass through secret redaction; credentials never appear.
- Verbose mode: set `LUMO_MCP_DEBUG=1` when starting the server.
- A stdio server's stderr tail (last 2 KB, redacted) is visible via the admin
  API's server view.
- The server shuts down cleanly on SIGINT/SIGTERM — stdio children are killed
  so no orphaned MCP processes remain.

## Running the test suite

```
node --test tests/*.test.mjs
```

The tests spawn `lumo-server.cjs` with `LUMO_PORT`/`LUMO_DATA_DIR` overrides
against `tests/fake-mcp-server.cjs`, `tests/fake-mcp-http-server.cjs`,
`tests/stub-oauth-provider.cjs` and `tests/stub-provider.cjs` — they never
touch `data/` or the real provider. Pre-boot fixtures are legacy JSON stores
migrated by the server on first boot; mid-run server-list changes go through
the real admin API (the SQLite store is the source of truth, so rewriting
fixture files mid-run would be inert). `tests/store.test.mjs` covers the
storage layer itself: schema, row ops, ordering, and the legacy-JSON
migration (round-trip fidelity, idempotent second boot, corrupt-file
tolerance, and the delete-DB + rename-backs rollback). The connections suite
covers the full lifecycle matrix (api_key/OAuth success, wrong/expired/
replayed state, revoke, needs_reauth, discovery failure, ownership/cross-user
denial, secret-leakage proofs, write-approval enforcement at advertisement
and execution, request-muted stale-call rejection, control-plane round
trips).

## Security notes

- Only add MCP servers you trust: a stdio server runs arbitrary local code;
  an http server returns arbitrary content into model context.
- Prompt injection through tool output is a real risk. The loop instructs the
  model to treat results as data, but the model is not a security boundary —
  write-capable tools stay disabled unless explicitly approved (see the
  permissions model), and users can mute any connection per request.
- MCP env secrets are stored in plaintext inside the `mcp_servers` rows of
  gitignored `data/lumo.db`; **per-connection credentials** (API keys, OAuth
  tokens) are AES-256-GCM encrypted in the `mcp_connections` rows with the
  key in `data/secret.key`. Neither is ever returned by an API, written to
  logs/tool results/model context/localStorage, or included in URLs. The
  whole `data/` directory (including `lumo.db*` and `backups/`) must never
  be committed. `node db-backup.cjs` takes an online WAL snapshot into
  `data/backups/` (keeps the newest 10).
- OAuth callbacks and setup flows are one-time (state/flow tokens are deleted
  before validation), time-limited, rate-limited per IP, and validated against
  the allowlisted definition — replayed, forged, or expired links die with a
  "Link expired" page.
- SSRF: http/SSE endpoints resolving to loopback/private addresses are
  refused unless explicitly marked trusted.
