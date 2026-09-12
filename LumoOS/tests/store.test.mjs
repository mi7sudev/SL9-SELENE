// store.test.mjs — the SQLite storage layer (store.cjs): schema bootstrap,
// row-level ops + ordering, users normalization, cascade wipes, and the
// legacy JSON migration (round-trip fidelity, idempotency, corrupt-file
// tolerance, and the documented rollback path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { openStore, DB_FILE } = require(path.join(ROOT, 'store.cjs'));

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumo-store-test-'));

test('fresh install: empty store, WAL mode, migration marker stamped, second open is a no-op', () => {
    const dir = mkDir();
    const first = openStore(dir, { log: () => {} });
    assert.equal(first.store.countUsers(), 0);
    assert.ok(first.db.prepare("SELECT value FROM meta WHERE key = 'migrated_at'").get());
    assert.equal(first.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    first.db.close();

    const second = openStore(dir, { log: () => {} });
    assert.equal(second.store.countUsers(), 0);
    second.db.close();
});

test('users: normalized round-trip, uid lookup, update merge preserves fields, delete', () => {
    const { db, store } = openStore(mkDir(), { log: () => {} });
    store.createUser('alice', { uid: 'uid-a1', salt: 's1', hash: 'h1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00Z', role: 'admin', disabled: false });
    store.createUser('bob', { uid: 'uid-b2', salt: 's2', hash: 'h2', displayName: 'Bob', createdAt: '2026-01-02T00:00:00Z', role: 'user', disabled: true });

    assert.deepEqual(store.getUserByUsername('alice'), {
        uid: 'uid-a1', salt: 's1', hash: 'h1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00Z', role: 'admin', disabled: false,
    });
    const byUid = store.getUserByUid('uid-b2');
    assert.equal(byUid.username, 'bob');
    assert.equal(byUid.entry.disabled, true); // int round-trips as a real boolean
    assert.equal(store.getUserByUid('uid-nope'), null);

    const updated = store.updateUser('bob', { role: 'admin', disabled: false });
    assert.equal(updated.role, 'admin');
    assert.equal(updated.hash, 'h2'); // merge keeps untouched fields
    assert.equal(store.countUsers(), 2);
    assert.deepEqual(store.listUsers().map((u) => u.username).sort(), ['alice', 'bob']);

    store.deleteUser('bob');
    assert.equal(store.getUserByUsername('bob'), null);
    assert.equal(store.countUsers(), 1);
    db.close();
});

test('collections: exact doc round-trip, insertion order survives updates, per-row delete, wipes', () => {
    const { db, store } = openStore(mkDir(), { log: () => {} });
    const uid = 'uid-x';
    const c1 = { ID: 'conv-1', SpaceID: 'space-1', CreateTime: 't1', UpdateTime: 't1', IsStarred: false, Encrypted: 'e1' };
    const c2 = { ID: 'conv-2', SpaceID: 'space-1', CreateTime: 't2', UpdateTime: 't2', IsStarred: false, Encrypted: 'e2' };
    const c3 = { ID: 'conv-3', SpaceID: 'space-2', CreateTime: 't3', UpdateTime: 't3', IsStarred: true, Encrypted: 'e3' };
    store.upsertConversation(uid, c1);
    store.upsertConversation(uid, c2);
    store.upsertConversation(uid, c3);

    // exact round-trip: every original key preserved, nothing invented
    assert.deepEqual(store.getConversation(uid, 'conv-2'), c2);

    // update in place (rename/star) rewrites one row and keeps list order
    c2.IsStarred = true;
    c2.UpdateTime = 't2b';
    store.upsertConversation(uid, c2);
    const list = store.listConversations(uid);
    assert.deepEqual(list.map((c) => c.ID), ['conv-1', 'conv-2', 'conv-3']);
    assert.deepEqual(list[1], c2);
    assert.deepEqual(list[0], c1);

    // link column powers the indexed space join
    assert.equal(list.filter((c) => c.SpaceID === 'space-1').length, 2);

    // messages: hard delete touches exactly one row
    const m1 = { ID: 'msg-1', ConversationID: 'conv-1', ParentID: null, Role: 1, Status: 2, CreateTime: 't1', Encrypted: 'm', MessageTag: null };
    const m2 = { ID: 'msg-2', ConversationID: 'conv-1', ParentID: 'msg-1', Role: 2, Status: 2, CreateTime: 't2', Encrypted: 'm2', MessageTag: null };
    store.upsertMessage(uid, m1);
    store.upsertMessage(uid, m2);
    assert.deepEqual(store.getMessage(uid, 'msg-1'), m1);
    store.deleteMessage(uid, 'msg-1');
    assert.equal(store.getMessage(uid, 'msg-1'), null);
    assert.deepEqual(store.getMessage(uid, 'msg-2'), m2);

    // spaces DELETE (wipe) clears the four collections but keeps settings;
    // deleteUserData clears everything
    store.putSettings(uid, { UserSettingsTag: 'tag', Encrypted: 'settings-blob', CreateTime: 't', UpdateTime: 't' });
    store.wipeUserData(uid);
    assert.deepEqual(store.listConversations(uid), []);
    assert.deepEqual(store.listMessages(uid), []);
    assert.deepEqual(store.listSpaces(uid), []);
    assert.equal(store.getSettings(uid).Encrypted, 'settings-blob');
    store.deleteUserData(uid);
    assert.equal(store.getSettings(uid), null);
    db.close();
});

test('mcp servers + connection records: row ops, stable order, owner lookup, delete', () => {
    const { db, store } = openStore(mkDir(), { log: () => {} });
    store.upsertMcpServer({ id: 'a', name: 'A', env: { K: 'v' } });
    store.upsertMcpServer({ id: 'b', name: 'B' });
    store.upsertMcpServer({ id: 'a', name: 'A2', env: { K: 'v2' } }); // update keeps position
    assert.deepEqual(store.listMcpServers().map((s) => s.id), ['a', 'b']);
    assert.equal(store.getMcpServer('a').name, 'A2');
    assert.deepEqual(store.getMcpServer('a').env, { K: 'v2' }); // secrets stay in the doc
    store.deleteMcpServer('b');
    assert.deepEqual(store.listMcpServers().map((s) => s.id), ['a']);

    const rec = (id, owner) => ({ id, serverId: 'a', ownerUid: owner, status: 'ready', credential: null });
    store.upsertConnectionRecord(rec('c1', 'u1'));
    store.upsertConnectionRecord(rec('c2', 'tenant'));
    store.upsertConnectionRecord({ ...rec('c1', 'u1'), status: 'revoked', credential: null });
    assert.deepEqual(store.listConnectionRecords().map((r) => r.id), ['c1', 'c2']);
    assert.equal(store.listConnectionRecords()[0].status, 'revoked');
    assert.equal(store.findConnectionRecordFor('a', 'u1').id, 'c1');
    assert.equal(store.findConnectionRecordFor('a', 'tenant').id, 'c2'); // tenant scope is a plain owner value here
    assert.equal(store.findConnectionRecordFor('a', 'anyone'), null); // the service layer adds the tenant fallback
    store.deleteConnectionRecord('c1');
    assert.equal(store.getConnectionRecord('c1'), null);
    db.close();
});

test('legacy migration: doc-for-doc round-trip, originals renamed, second boot idempotent, rollback works', () => {
    const dir = mkDir();
    const user = { uid: 'uid-m1', salt: 'sa', hash: 'hh', displayName: 'Admin', createdAt: '2026-02-03T00:00:00Z', role: 'admin', disabled: false };
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ admin: user }));
    const userDoc = {
        spaces: [{ ID: 'space-9', CreateTime: 'ts', UpdateTime: 'ts', Encrypted: 'sp', SpaceKey: 'k' }],
        conversations: [
            { ID: 'conv-9', SpaceID: 'space-9', CreateTime: 'ts', UpdateTime: 'ts', IsStarred: false, Encrypted: 'cv' },
            { ID: 'conv-10', SpaceID: 'space-9', CreateTime: 'ts2', UpdateTime: 'ts2', IsStarred: true, Encrypted: 'cv2' },
        ],
        messages: [{ ID: 'msg-9', ConversationID: 'conv-9', ParentID: null, Role: 1, Status: 2, CreateTime: 'ts', Encrypted: 'ms', MessageTag: null }],
        assets: [{ ID: 'asset-9', SpaceID: 'space-9', AssetTag: 'tag-9', CreateTime: 'ts', Encrypted: 'as', DeleteTime: null }],
        settings: { UserSettingsTag: 'tag', Encrypted: 'st', CreateTime: 'ts', UpdateTime: 'ts' },
    };
    // the per-user file name IS the uid (uid-m1 + '.json'), as in production
    fs.writeFileSync(path.join(dir, 'uid-m1.json'), JSON.stringify(userDoc));
    // deliberately the legacy flat provider shape: normalization stays the
    // server's job on read, the store keeps the raw document
    fs.writeFileSync(path.join(dir, 'admin-config.json'), JSON.stringify({ baseUrl: 'http://p/v1', apiKey: 'sk-live', models: ['m1'] }));
    fs.writeFileSync(path.join(dir, 'mcp-servers.json'), JSON.stringify({
        servers: [{ id: 'srv1', name: 'S', transport: 'stdio', command: 'x', args: [], env: { T: 'v' }, enabled: true }],
    }));
    fs.writeFileSync(path.join(dir, 'mcp-connections.json'), JSON.stringify({
        connections: [{ id: 'conn-9', serverId: 'srv1', ownerUid: 'uid-m1', status: 'ready', credential: 'v1:iv:tag:ct', error: null, createdAt: 'ts', updatedAt: 'ts', lastValidatedAt: 'ts', lastDiscoveredAt: 'ts' }],
    }));

    const boot1 = [];
    const { db, store } = openStore(dir, { log: (m) => boot1.push(m) });
    assert.deepEqual(store.getUserByUsername('admin'), { ...user, disabled: false });
    assert.deepEqual(store.assembleUserDoc('uid-m1'), userDoc);
    assert.deepEqual(store.getKv('admin_config'), { baseUrl: 'http://p/v1', apiKey: 'sk-live', models: ['m1'] });
    assert.equal(store.listMcpServers().length, 1);
    assert.equal(store.listConnectionRecords()[0].credential, 'v1:iv:tag:ct');
    assert.equal(boot1.filter((l) => l.includes('migrated ')).length, 5, 'one migration line per legacy file');
    // originals renamed, never deleted
    for (const f of ['users.migrated.json', 'uid-m1.migrated.json', 'admin-config.migrated.json', 'mcp-servers.migrated.json', 'mcp-connections.migrated.json']) {
        assert.ok(fs.existsSync(path.join(dir, f)), `${f} kept as backup`);
        assert.equal(fs.existsSync(path.join(dir, f.replace('.migrated.json', '.json'))), false, `${f} no longer live`);
    }
    db.close();

    // second boot: no re-import, data unchanged
    const boot2 = [];
    const { db: db2, store: s2 } = openStore(dir, { log: (m) => boot2.push(m) });
    assert.equal(boot2.filter((l) => l.includes('migrated ')).length, 0);
    assert.equal(s2.countUsers(), 1);
    assert.deepEqual(s2.assembleUserDoc('uid-m1'), userDoc);
    db2.close();

    // documented rollback: stop, delete the DB, rename backups back, re-open
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(dir, DB_FILE + suffix), { force: true });
    for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.migrated.json')) {
            fs.renameSync(path.join(dir, f), path.join(dir, f.replace('.migrated.json', '.json')));
        }
    }
    const { db: db3, store: s3 } = openStore(dir, { log: () => {} });
    assert.equal(s3.countUsers(), 1);
    assert.deepEqual(s3.assembleUserDoc('uid-m1'), userDoc);
    db3.close();
});

test('corrupt legacy file: tolerated with a warning, renamed aside, nothing imported from it', () => {
    const dir = mkDir();
    fs.writeFileSync(path.join(dir, 'users.json'), '{ this is not json');
    fs.writeFileSync(path.join(dir, 'admin-config.json'), JSON.stringify({ providers: [] }));
    const logs = [];
    const { db, store } = openStore(dir, { log: (m) => logs.push(m) });
    assert.equal(store.countUsers(), 0);
    assert.deepEqual(store.getKv('admin_config'), { providers: [] });
    assert.ok(logs.some((l) => l.includes('not valid JSON')), 'corruption is logged loudly');
    assert.ok(fs.existsSync(path.join(dir, 'users.migrated.json')));
    db.close();
});
