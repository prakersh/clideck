const { DB_PATH } = require('../paths');
const { runMigrations } = require('./migrate');

let db = null;
let DatabaseSync = null;

function loadDatabaseSync() {
  if (DatabaseSync) return DatabaseSync;

  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function emitWarningPatched(warning, ...args) {
    const warningName = typeof warning === 'object' && warning?.name
      ? warning.name
      : typeof args[0] === 'string'
        ? args[0]
        : '';
    const message = typeof warning === 'string' ? warning : warning?.message || '';

    if (warningName === 'ExperimentalWarning' && /sqlite/i.test(message)) return;
    return originalEmitWarning.call(process, warning, ...args);
  };

  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } finally {
    process.emitWarning = originalEmitWarning;
  }

  return DatabaseSync;
}

function openDb() {
  if (db) return db;

  const SqliteDatabaseSync = loadDatabaseSync();
  db = new SqliteDatabaseSync(DB_PATH);
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
