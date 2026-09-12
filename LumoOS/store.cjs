'use strict';
// store.cjs — SQLite persistence for the self-hosted Lumo server.
//
// Replaces the JSON-file stores in data/ with a single WAL-mode SQLite
// database (data/lumo.db) as the one source of truth. The HTTP API contract
// is unchanged: every user-facing document round-trips through a `doc` TEXT
// column holding the exact original JSON object, while extracted key columns
// (uid, ids, links, timestamps) back the indexes — the server-side cousin of
// the real Lumo client's IndexedDB layout (per-entity stores + space/
// conversation indexes). Legacy JSON files are imported once, in one
// transaction, and then renamed to *.migrated.json — never deleted — so a
// migration can be rolled back by stopping the server, deleting the DB, and
// renaming the files back.
//
// Driver: node:sqlite (DatabaseSync), built into Node >= 22.5 — zero new
// dependencies, synchronous like the rest of the server. `secret.key` is NOT
// stored here: the credential-encryption key stays a 0600 file so the key and
// the ciphertext never live in one artifact.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = 'lumo.db';
const SCHEMA_VERSION = '1';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- users are fully normalized: auth looks one user up by uid/username on
-- essentially every request
CREATE TABLE IF NOT EXISTS users (
    username     TEXT PRIMARY KEY,
    uid          TEXT NOT NULL UNIQUE,
    salt         TEXT NOT NULL,
    hash         TEXT NOT NULL,
    display_name TEXT,
    created_at   TEXT,
    role         TEXT NOT NULL DEFAULT 'user',
    disabled     INTEGER NOT NULL DEFAULT 0,
    seq          INTEGER NOT NULL
);

-- per-user collections: one row per entity; the 'doc' column holds the exact
-- JSON document the client contract defines. 'seq' preserves insertion order
-- (the JSON-file era returned documents in array order and the client relies
-- on it).
CREATE TABLE IF NOT EXISTS spaces (
    uid TEXT NOT NULL, id TEXT NOT NULL,
    create_time TEXT, update_time TEXT, delete_time TEXT,
    seq INTEGER NOT NULL, doc TEXT NOT NULL,
    PRIMARY KEY (uid, id)
);
CREATE TABLE IF NOT EXISTS conversations (
    uid TEXT NOT NULL, id TEXT NOT NULL, space_id TEXT,
    create_time TEXT, update_time TEXT, delete_time TEXT,
    seq INTEGER NOT NULL, doc TEXT NOT NULL,
    PRIMARY KEY (uid, id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_space ON conversations (uid, space_id);
CREATE TABLE IF NOT EXISTS messages (
    uid TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT,
    create_time TEXT, delete_time TEXT,
    seq INTEGER NOT NULL, doc TEXT NOT NULL,
    PRIMARY KEY (uid, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (uid, conversation_id);
CREATE TABLE IF NOT EXISTS assets (
    uid TEXT NOT NULL, id TEXT NOT NULL, space_id TEXT,
    create_time TEXT, delete_time TEXT,
    seq INTEGER NOT NULL, doc TEXT NOT NULL,
    PRIMARY KEY (uid, id)
);
CREATE INDEX IF NOT EXISTS idx_assets_space ON assets (uid, space_id);

CREATE TABLE IF NOT EXISTS user_settings (
    uid TEXT PRIMARY KEY, doc TEXT NOT NULL
);

-- single-value JSON documents (currently: the admin BYOK provider config)
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- MCP: one row per admin server definition / per-user connection record
CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL, doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_connections (
    id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, server_id TEXT NOT NULL, status TEXT,
    seq INTEGER NOT NULL, doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_owner ON mcp_connections (server_id, owner_uid);
`;

function getMeta(db, key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

function setMeta(db, key, value) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ── per-user collection ops ──────────────────────────────────────────────────
// One factory per table; every write is a single upsert so a mutating request
// touches exactly one row (the JSON era rewrote the user's whole file).
// `link` maps the document's PascalCase link field onto the indexed column.
function buildCollection(db, table, link, extraCols) {
    const linkJson = link === 'space_id' ? 'SpaceID' : link === 'conversation_id' ? 'ConversationID' : null;
    const allCols = ['uid', 'id', ...(link ? [link] : []), ...extraCols, 'seq', 'doc'];
    const placeholders = allCols
        .map((c) => (c === 'seq' ? `(SELECT COALESCE(MAX(seq), 0) + 1 FROM ${table} WHERE uid = ?)` : '?'))
        .join(', ');
    const updatable = allCols.filter((c) => c !== 'uid' && c !== 'id' && c !== 'seq');
    const upsert = db.prepare(
        `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders}) ` +
        `ON CONFLICT (uid, id) DO UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(', ')}`,
    );
    const list = db.prepare(`SELECT doc FROM ${table} WHERE uid = ? ORDER BY seq`);
    const get = db.prepare(`SELECT doc FROM ${table} WHERE uid = ? AND id = ?`);
    const del = db.prepare(`DELETE FROM ${table} WHERE uid = ? AND id = ?`);
    const wipe = db.prepare(`DELETE FROM ${table} WHERE uid = ?`);
    const parse = (row) => JSON.parse(row.doc);
    return {
        list: (uid) => list.all(uid).map(parse),
        get: (uid, id) => {
            const row = get.get(uid, id);
            return row ? parse(row) : null;
        },
        upsert: (uid, doc) => {
            const linkVal = linkJson ? [doc[linkJson] ?? null] : [];
            const vals = extraCols.map((c) => doc[c === 'create_time' ? 'CreateTime' : c === 'update_time' ? 'UpdateTime' : 'DeleteTime'] ?? null);
            upsert.run(uid, doc.ID, ...linkVal, ...vals, uid, JSON.stringify(doc));
        },
        del: (uid, id) => void del.run(uid, id),
        wipe: (uid) => void wipe.run(uid),
    };
}

const USER_COLS = ['username', 'uid', 'salt', 'hash', 'display_name', 'created_at', 'role', 'disabled'];

function userRowFromEntry(username, entry) {
    return [
        username,
        String(entry.uid),
        String(entry.salt ?? ''),
        String(entry.hash ?? ''),
        entry.displayName ?? null,
        entry.createdAt ?? null,
        entry.role === 'admin' ? 'admin' : 'user',
        entry.disabled === true ? 1 : 0,
    ];
}

function entryFromUserRow(row) {
    return {
        uid: row.uid,
        salt: row.salt,
        hash: row.hash,
        displayName: row.display_name ?? '',
        createdAt: row.created_at ?? null,
        role: row.role,
        disabled: !!row.disabled,
    };
}

function buildStore(db) {
    const userUpsert = db.prepare(
        `INSERT INTO users (${USER_COLS.join(', ')}, seq) VALUES (${USER_COLS.map(() => '?').join(', ')}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM users)) ` +
        `ON CONFLICT (username) DO UPDATE SET ${USER_COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`,
    );
    const userGetByName = db.prepare(`SELECT ${USER_COLS.join(', ')} FROM users WHERE username = ?`);
    const userGetByUid = db.prepare(`SELECT ${USER_COLS.join(', ')} FROM users WHERE uid = ?`);
    const userList = db.prepare(`SELECT ${USER_COLS.join(', ')} FROM users ORDER BY seq`);
    const userDelete = db.prepare('DELETE FROM users WHERE username = ?');
    const userCount = db.prepare('SELECT COUNT(*) AS n FROM users');

    const settingsGet = db.prepare('SELECT doc FROM user_settings WHERE uid = ?');
    const settingsPut = db.prepare('INSERT INTO user_settings (uid, doc) VALUES (?, ?) ON CONFLICT (uid) DO UPDATE SET doc = excluded.doc');

    const kvGet = db.prepare('SELECT value FROM kv WHERE key = ?');
    const kvSet = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');

    const serverUpsert = db.prepare(
        'INSERT INTO mcp_servers (id, seq, doc) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM mcp_servers), ?) ' +
        'ON CONFLICT (id) DO UPDATE SET doc = excluded.doc',
    );
    const serverGet = db.prepare('SELECT doc FROM mcp_servers WHERE id = ?');
    const serverList = db.prepare('SELECT doc FROM mcp_servers ORDER BY seq');
    const serverDelete = db.prepare('DELETE FROM mcp_servers WHERE id = ?');

    const connUpsert = db.prepare(
        'INSERT INTO mcp_connections (id, owner_uid, server_id, status, seq, doc) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM mcp_connections), ?) ' +
        'ON CONFLICT (id) DO UPDATE SET owner_uid = excluded.owner_uid, server_id = excluded.server_id, status = excluded.status, doc = excluded.doc',
    );
    const connGet = db.prepare('SELECT doc FROM mcp_connections WHERE id = ?');
    const connList = db.prepare('SELECT doc FROM mcp_connections ORDER BY seq');
    const connForOwner = db.prepare('SELECT doc FROM mcp_connections WHERE server_id = ? AND owner_uid = ? ORDER BY seq LIMIT 1');
    const connDelete = db.prepare('DELETE FROM mcp_connections WHERE id = ?');
    const parseConn = (row) => {
        const doc = JSON.parse(row.doc);
        doc.ownerUid = doc.ownerUid ?? null;
        doc.serverId = doc.serverId ?? null;
        doc.status = doc.status ?? null;
        return doc;
    };

    const spaces = buildCollection(db, 'spaces', null, ['create_time', 'update_time', 'delete_time']);
    const conversations = buildCollection(db, 'conversations', 'space_id', ['create_time', 'update_time', 'delete_time']);
    const messages = buildCollection(db, 'messages', 'conversation_id', ['create_time', 'delete_time']);
    const assets = buildCollection(db, 'assets', 'space_id', ['create_time', 'delete_time']);

    const wipeUserDataStmts = [
        'DELETE FROM spaces WHERE uid = ?',
        'DELETE FROM conversations WHERE uid = ?',
        'DELETE FROM messages WHERE uid = ?',
        'DELETE FROM assets WHERE uid = ?',
    ].map((sql) => db.prepare(sql));

    const store = {
        // ── users ──
        getUserByUsername(username) {
            const row = userGetByName.get(String(username));
            return row ? entryFromUserRow(row) : null;
        },
        getUserByUid(uid) {
            const row = userGetByUid.get(String(uid));
            return row ? { username: row.username, entry: entryFromUserRow(row) } : null;
        },
        listUsers() {
            return userList.all().map((row) => ({ username: row.username, entry: entryFromUserRow(row) }));
        },
        createUser(username, entry) {
            userUpsert.run(...userRowFromEntry(username, entry));
            return entry;
        },
        // mirrors the old whole-map RMW: `users[name] = { ...users[name], ...patch }`
        updateUser(username, patch) {
            const prev = store.getUserByUsername(username);
            if (!prev) return null;
            const next = { ...prev, ...patch };
            userUpsert.run(...userRowFromEntry(username, next));
            return next;
        },
        deleteUser(username) {
            userDelete.run(String(username));
        },
        countUsers() {
            return Number(userCount.get().n);
        },

        // ── per-user collections ──
        listSpaces: spaces.list,
        getSpace: spaces.get,
        upsertSpace: spaces.upsert,
        wipeSpaces: spaces.wipe,
        listConversations: conversations.list,
        getConversation: conversations.get,
        upsertConversation: conversations.upsert,
        listMessages: messages.list,
        getMessage: messages.get,
        upsertMessage: messages.upsert,
        deleteMessage: messages.del,
        listAssets: assets.list,
        getAsset: assets.get,
        upsertAsset: assets.upsert,
        // the spaces DELETE endpoint wipes the four collections (settings kept)
        wipeUserData(uid) {
            for (const stmt of wipeUserDataStmts) stmt.run(String(uid));
        },
        // admin user deletion: everything owned by the uid, settings included
        deleteUserData(uid) {
            for (const stmt of wipeUserDataStmts) stmt.run(String(uid));
            db.prepare('DELETE FROM user_settings WHERE uid = ?').run(String(uid));
        },
        // reassembles the legacy whole-user document (migration verification /
        // debugging). Settings is always a key, null when unset — same as the
        // old loadUserData defaults.
        assembleUserDoc(uid) {
            return {
                spaces: spaces.list(uid),
                conversations: conversations.list(uid),
                messages: messages.list(uid),
                assets: assets.list(uid),
                settings: store.getSettings(uid),
            };
        },

        // ── user settings ──
        getSettings(uid) {
            const row = settingsGet.get(String(uid));
            return row ? JSON.parse(row.doc) : null;
        },
        putSettings(uid, doc) {
            settingsPut.run(String(uid), JSON.stringify(doc));
        },

        // ── single-value documents ──
        getKv(key) {
            const row = kvGet.get(String(key));
            if (!row) return null;
            try { return JSON.parse(row.value); } catch { return null; }
        },
        setKv(key, value) {
            kvSet.run(String(key), JSON.stringify(value));
        },

        // ── MCP server definitions (docs include env/oauth secrets, exactly
        // like the old mcp-servers.json — server-side only, never exported) ──
        listMcpServers() {
            return serverList.all().map((row) => JSON.parse(row.doc));
        },
        getMcpServer(id) {
            const row = serverGet.get(String(id));
            return row ? JSON.parse(row.doc) : null;
        },
        upsertMcpServer(doc) {
            serverUpsert.run(String(doc.id), JSON.stringify(doc));
        },
        deleteMcpServer(id) {
            serverDelete.run(String(id));
        },

        // ── MCP connection records (doc includes the AES-256-GCM credential
        // blob; key columns back the per-server/per-owner lookups) ──
        listConnectionRecords() {
            return connList.all().map(parseConn);
        },
        getConnectionRecord(id) {
            const row = connGet.get(String(id));
            return row ? parseConn(row) : null;
        },
        // the user's record for a server (own record wins over 'tenant' is
        // decided by the caller — this is just the indexed lookup)
        findConnectionRecordFor(serverId, ownerUid) {
            const row = connForOwner.get(String(serverId), String(ownerUid));
            return row ? parseConn(row) : null;
        },
        upsertConnectionRecord(doc) {
            connUpsert.run(
                String(doc.id),
                String(doc.ownerUid ?? ''),
                String(doc.serverId ?? ''),
                doc.status ?? null,
                JSON.stringify(doc),
            );
        },
        deleteConnectionRecord(id) {
            connDelete.run(String(id));
        },
    };
    return store;
}

// ── legacy JSON migration ────────────────────────────────────────────────────
// Runs at most once per database. All imports happen inside one transaction
// (migrated_at is written in it too, so a crash mid-migration rolls back
// cleanly and retries on the next boot); the original files are renamed to
// *.migrated.json only AFTER a successful commit.
function migrateLegacy(db, dataDir, log) {
    if (getMeta(db, 'migrated_at')) return null;
    const fixed = ['users.json', 'admin-config.json', 'mcp-servers.json', 'mcp-connections.json'];
    const uidFiles = fs.existsSync(dataDir)
        ? fs.readdirSync(dataDir).filter((f) => /^uid-.+\.json$/.test(f)).sort()
        : [];
    const candidates = [...fixed, ...uidFiles]
        .map((f) => path.join(dataDir, f))
        .filter((p) => fs.existsSync(p));

    if (!candidates.length) {
        // fresh install: remember it so later boots don't rescan data/
        setMeta(db, 'migrated_at', new Date().toISOString());
        return { imported: {} };
    }

    const readJsonFile = (p) => {
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (e) {
            log(`[store] WARNING: ${path.basename(p)} is not valid JSON (${e.message}); nothing was imported from it`);
            return undefined;
        }
    };
    const renames = [];
    const counts = {};
    db.exec('BEGIN');
    try {
        const store = buildStore(db);
        for (const p of candidates) {
            const base = path.basename(p);
            const parsed = readJsonFile(p);
            counts[base] = 0;
            if (parsed === undefined) { renames.push(p); continue; }
            if (base === 'users.json' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                for (const [username, entry] of Object.entries(parsed)) {
                    if (!entry || typeof entry !== 'object' || !entry.uid) continue;
                    store.createUser(username, entry);
                    counts[base]++;
                }
            } else if (base === 'admin-config.json' && parsed && typeof parsed === 'object') {
                // stored raw — the legacy single-provider shape is still
                // normalized on read by lumo-server.cjs, exactly as before
                store.setKv('admin_config', parsed);
                counts[base] = 1;
            } else if (base === 'mcp-servers.json' && parsed && typeof parsed === 'object') {
                for (const s of Array.isArray(parsed.servers) ? parsed.servers : []) {
                    if (!s || typeof s !== 'object' || !s.id) continue;
                    store.upsertMcpServer(s);
                    counts[base]++;
                }
            } else if (base === 'mcp-connections.json' && parsed && typeof parsed === 'object') {
                for (const c of Array.isArray(parsed.connections) ? parsed.connections : []) {
                    if (!c || typeof c !== 'object' || !c.id) continue;
                    store.upsertConnectionRecord(c);
                    counts[base]++;
                }
            } else if (/^uid-.+\.json$/.test(base)) {
                const uid = base.slice(0, -'.json'.length);
                if (parsed && typeof parsed === 'object') {
                    for (const doc of Array.isArray(parsed.spaces) ? parsed.spaces : []) {
                        if (doc && typeof doc === 'object' && doc.ID) { store.upsertSpace(uid, doc); counts[base]++; }
                    }
                    for (const doc of Array.isArray(parsed.conversations) ? parsed.conversations : []) {
                        if (doc && typeof doc === 'object' && doc.ID) { store.upsertConversation(uid, doc); counts[base]++; }
                    }
                    for (const doc of Array.isArray(parsed.messages) ? parsed.messages : []) {
                        if (doc && typeof doc === 'object' && doc.ID) { store.upsertMessage(uid, doc); counts[base]++; }
                    }
                    for (const doc of Array.isArray(parsed.assets) ? parsed.assets : []) {
                        if (doc && typeof doc === 'object' && doc.ID) { store.upsertAsset(uid, doc); counts[base]++; }
                    }
                    if (parsed.settings && typeof parsed.settings === 'object') store.putSettings(uid, parsed.settings);
                }
            }
            renames.push(p);
        }
        setMeta(db, 'migrated_at', new Date().toISOString());
        db.exec('COMMIT');
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* not in a transaction anymore */ }
        throw e;
    }
    // commit succeeded — now move the originals aside (never delete)
    for (const p of renames) {
        const dest = p.replace(/\.json$/, '') + '.migrated.json';
        try {
            fs.renameSync(p, fs.existsSync(dest) ? `${dest}.${Date.now()}` : dest);
        } catch (e) {
            log(`[store] WARNING: could not rename ${path.basename(p)} after migration: ${e.message} (the data is already in the database)`);
        }
    }
    for (const [f, n] of Object.entries(counts)) log(`[store] migrated ${f} -> ${n} record(s)`);
    log('[store] legacy JSON stores migrated; originals kept as *.migrated.json');
    return { imported: counts };
}

// Open (and create/schema-bootstrap/migrate) the store for a data directory.
// Call once per process; the returned handle is safe to share.
function openStore(dataDir, { log = () => {} } = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, DB_FILE);
    const db = new DatabaseSync(dbPath);
    // WAL: readers (tests, backup tool) can read while the server writes;
    // busy_timeout keeps rare cross-process contention from erroring.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    if (getMeta(db, 'schema_version') === null) setMeta(db, 'schema_version', SCHEMA_VERSION);
    const migration = migrateLegacy(db, dataDir, log);
    return { db, dbPath, store: buildStore(db), migration };
}

module.exports = { openStore, DB_FILE };

// ── CLI: `node store.cjs --migrate [dataDir]` ────────────────────────────────
// Runs the same import + summary the server does on first boot. Useful for
// migrating explicitly before starting the server.
if (require.main === module) {
    const usage = 'usage: node store.cjs --migrate [dataDir]';
    if (!process.argv.includes('--migrate')) {
        console.error(usage);
        process.exit(2);
    }
    const dataDirArg = process.argv[process.argv.indexOf('--migrate') + 1];
    const dataDir = path.resolve(dataDirArg || process.env.LUMO_DATA_DIR || 'D:/ProtoLumo/data');
    const t0 = Date.now();
    const { db, dbPath, store, migration } = openStore(dataDir, { log: (m) => console.log(m) });
    console.log(`[store] database: ${dbPath}`);
    console.log(`[store] users: ${store.countUsers()}, servers: ${store.listMcpServers().length}, connections: ${store.listConnectionRecords().length}`);
    if (!migration || !Object.keys(migration.imported || {}).length) console.log('[store] nothing to migrate (already migrated or fresh install)');
    console.log(`[store] done in ${Date.now() - t0} ms`);
    db.close();
}
