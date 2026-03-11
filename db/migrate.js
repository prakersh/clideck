const { existsSync, mkdirSync, readdirSync, readFileSync } = require('fs');
const { join } = require('path');

const MIGRATIONS_DIR = join(__dirname, 'migrations');

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function listMigrationFiles() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort();
}

function runMigrations(db) {
  mkdirSync(MIGRATIONS_DIR, { recursive: true });
  ensureMigrationsTable(db);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version)
  );

  for (const file of listMigrationFiles()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(file, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

module.exports = { runMigrations };
