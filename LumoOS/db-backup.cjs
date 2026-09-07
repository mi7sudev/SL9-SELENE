'use strict';
// db-backup.cjs — online snapshot of data/lumo.db using node:sqlite's backup().
// Safe to run while the server is up (WAL allows a consistent read snapshot).
// Keeps the newest KEEP backups in data/backups/ and prunes the rest.
//
// usage: node db-backup.cjs [dataDir]
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.argv[2] || process.env.LUMO_DATA_DIR || 'D:/ProtoLumo/data');
const DB_PATH = path.join(DATA_DIR, 'lumo.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = 10;

async function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`[db-backup] no database at ${DB_PATH}`);
        process.exit(1);
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `lumo-${stamp}.db`);
    const db = new DatabaseSync(DB_PATH);
    try {
        await db.backup(dest);
    } finally {
        db.close();
    }
    const size = fs.statSync(dest).size;
    console.log(`[db-backup] wrote ${dest} (${(size / 1024).toFixed(1)} KiB)`);

    const backups = fs.readdirSync(BACKUP_DIR)
        .filter((f) => /^lumo-.*\.db$/.test(f))
        .sort()
        .reverse();
    for (const old of backups.slice(KEEP)) {
        try {
            fs.unlinkSync(path.join(BACKUP_DIR, old));
            console.log(`[db-backup] pruned old backup ${old}`);
        } catch (e) {
            console.error(`[db-backup] could not prune ${old}: ${e.message}`);
        }
    }
    console.log(`[db-backup] ${Math.min(backups.length, KEEP)} backup(s) kept in ${BACKUP_DIR}`);
}

main().catch((e) => {
    console.error(`[db-backup] failed: ${e?.stack || e}`);
    process.exit(1);
});
