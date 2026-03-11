const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('../paths');
const { runMigrations } = require('./migrate');

let db = null;

function openDb() {
  if (db) return db;

  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  runMigrations(db);
  return db;
}

function closeDb() {
  if (!db) return;
  if (typeof db.close === 'function') db.close();
  db = null;
}

module.exports = { openDb, closeDb };
