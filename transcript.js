const { existsSync, readdirSync, readFileSync } = require('fs');
const { join, basename } = require('path');
const { openDb } = require('./db');
const { DATA_DIR } = require('./paths');

const DIR = join(DATA_DIR, 'transcripts');
const ANSI_RE = /\x1b[\[\]()#;?]*[0-9;]*[a-zA-Z@`~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.|\r|\x07/g;
const MAX_CACHE = 50 * 1024;

const inputBuf = {};
const outputBuf = {};
const cache = {};
let broadcast = null;

function trimCache(id) {
  if (cache[id]?.length > MAX_CACHE) cache[id] = cache[id].slice(-MAX_CACHE);
}

function clearInvalidEntries(validIds) {
  if (!validIds) return;
  const db = openDb();
  if (!validIds.size) {
    db.prepare('DELETE FROM transcript_entries').run();
    return;
  }
  const ids = [...validIds];
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(`DELETE FROM transcript_entries WHERE session_id NOT IN (${placeholders})`).run(...ids);
}

function importLegacyTranscripts(validIds) {
  const db = openDb();
  const existing = db.prepare('SELECT 1 FROM transcript_entries LIMIT 1').get();
  if (existing || !existsSync(DIR)) return;

  const files = readdirSync(DIR).filter(f => f.endsWith('.jsonl'));
  const insert = db.prepare('INSERT INTO transcript_entries (session_id, ts, role, text) VALUES (?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    for (const file of files) {
      const id = basename(file, '.jsonl');
      if (validIds && !validIds.has(id)) continue;
      const lines = readFileSync(join(DIR, file), 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          insert.run(id, Number(entry.ts) || Date.now(), entry.role || 'agent', String(entry.text || ''));
        } catch {}
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function init(bc, validIds) {
  broadcast = bc;
  for (const key of Object.keys(cache)) delete cache[key];

  clearInvalidEntries(validIds);
  importLegacyTranscripts(validIds);

  const rows = openDb().prepare(`
    SELECT session_id, text
    FROM transcript_entries
    ORDER BY session_id ASC, ts ASC, id ASC
  `).all();
  for (const row of rows) {
    if (validIds && !validIds.has(row.session_id)) continue;
    if (!cache[row.session_id]) cache[row.session_id] = '';
    cache[row.session_id] += '\n' + row.text;
    trimCache(row.session_id);
  }
}

function store(id, role, text) {
  openDb().prepare(`
    INSERT INTO transcript_entries (session_id, ts, role, text)
    VALUES (?, ?, ?, ?)
  `).run(id, Date.now(), role, text);
  if (!cache[id]) cache[id] = '';
  cache[id] += '\n' + text;
  trimCache(id);
  if (broadcast) broadcast({ type: 'transcript.append', id, text });
}

function trackInput(id, data) {
  if (!inputBuf[id]) inputBuf[id] = { text: '', esc: false };
  const buf = inputBuf[id];
  for (const ch of data) {
    if (ch === '\x1b') { buf.esc = true; continue; }
    if (buf.esc) {
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '~') buf.esc = false;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const line = buf.text.trim();
      if (line) store(id, 'user', line);
      buf.text = '';
    } else if (ch === '\x7f' || ch === '\x08') {
      const chars = Array.from(buf.text);
      chars.pop();
      buf.text = chars.join('');
    } else if (ch >= ' ') {
      buf.text += ch;
    }
  }
}

function trackOutput(id, data) {
  if (!outputBuf[id]) outputBuf[id] = { text: '', timer: null };
  const buf = outputBuf[id];
  buf.text += data;
  clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flush(id), 300);
}

function flush(id) {
  const buf = outputBuf[id];
  if (!buf?.text) return;
  const clean = buf.text.replace(ANSI_RE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  buf.text = '';
  if (lines.length) store(id, 'agent', lines.join('\n'));
}

function getCache() { return { ...cache }; }

function clear(id) {
  flush(id);
  delete inputBuf[id];
  if (outputBuf[id]) {
    clearTimeout(outputBuf[id].timer);
    delete outputBuf[id];
  }
  delete cache[id];
}

module.exports = { init, trackInput, trackOutput, getCache, clear };
