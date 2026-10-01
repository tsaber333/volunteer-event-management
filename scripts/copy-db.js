#!/usr/bin/env node
// Copies a SQLite database (e.g. live -> test site) using SQLite's online
// backup, so the source app can keep running while it is copied.
//
// Usage: node scripts/copy-db.js <source.db> [target.db]
// The target defaults to DB_PATH (from .env) or ./db/volunteer.db.
// Stop the app that uses the target first: its old -wal/-shm files are
// removed so they can't be replayed into the fresh copy.
require('dotenv').config();
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const [from, to = process.env.DB_PATH || './db/volunteer.db'] = process.argv.slice(2);
if (!from) {
  console.error('Usage: node scripts/copy-db.js <source.db> [target.db]');
  process.exit(1);
}
const source = path.resolve(from);
const target = path.resolve(to);
if (source === target) {
  console.error('Source and target are the same file.');
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error(`Source not found: ${source}`);
  process.exit(1);
}

(async () => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.copying`;
  fs.rmSync(temp, { force: true });

  const src = new Database(source, { readonly: true, fileMustExist: true });
  await src.backup(temp);
  src.close();

  const copy = new Database(temp, { readonly: true });
  const ok = copy.pragma('integrity_check', { simple: true });
  const count = table => copy.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  const summary = `${count('events')} events, ${count('registrations')} registrations`;
  copy.close();
  if (ok !== 'ok') {
    fs.rmSync(temp, { force: true });
    console.error(`Copy failed its integrity check (${ok}); target left unchanged.`);
    process.exit(1);
  }

  for (const suffix of ['-wal', '-shm']) fs.rmSync(target + suffix, { force: true });
  fs.renameSync(temp, target);
  console.log(`Copied ${source} -> ${target} (${summary}).`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
