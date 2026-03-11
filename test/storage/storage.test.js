const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(__dirname, '..', '..');
const RESULT_PREFIX = '__RESULT__';

function wrapScript(source) {
  return `
    (async () => {
      ${source}
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
}

async function runNode(home, source, env = {}) {
  const { stdout } = await execFileAsync(process.execPath, ['-e', wrapScript(source)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      ...env,
    },
  });

  const line = stdout
    .split('\n')
    .map(entry => entry.trim())
    .filter(Boolean)
    .reverse()
    .find(entry => entry.startsWith(RESULT_PREFIX));

  if (!line) return null;
  return JSON.parse(line.slice(RESULT_PREFIX.length));
}

async function makeHome() {
  const home = await mkdtemp(join(os.tmpdir(), 'clideck-storage-'));
  await mkdir(join(home, '.clideck'), { recursive: true });
  return home;
}

test('config is imported from legacy json once and persisted through SQLite', async () => {
  const home = await makeHome();
  try {
    await writeFile(join(home, '.clideck', 'config.json'), JSON.stringify({
      defaultPath: '/tmp/projects',
      prompts: [{ id: 'p1', title: 'Hello', text: 'world' }],
    }, null, 2));

    const imported = await runNode(home, `
      const config = require('./config');
      const { DatabaseSync } = require('node:sqlite');
      const { DB_PATH } = require('./paths');
      const cfg = config.load();
      const db = new DatabaseSync(DB_PATH);
      const row = db.prepare('SELECT config_json FROM app_config WHERE id = ?').get('default');
      process.stdout.write('${RESULT_PREFIX}' + JSON.stringify({
        defaultPath: cfg.defaultPath,
        promptCount: cfg.prompts.length,
        stored: JSON.parse(row.config_json).defaultPath,
      }) + '\\n');
    `);

    assert.equal(imported.defaultPath, '/tmp/projects');
    assert.equal(imported.promptCount, 1);
    assert.equal(imported.stored, '/tmp/projects');

    const roundTrip = await runNode(home, `
      const config = require('./config');
      const cfg = config.load();
      cfg.defaultPath = '/var/workspaces';
      config.save(cfg);
      process.stdout.write('${RESULT_PREFIX}' + JSON.stringify(config.load()) + '\\n');
    `);
    assert.equal(roundTrip.defaultPath, '/var/workspaces');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('resumable sessions migrate from json and persist through restart via SQLite', async () => {
  const home = await makeHome();
  try {
    await writeFile(join(home, '.clideck', 'sessions.json'), JSON.stringify([
      {
        id: 'legacy-session',
        name: 'Legacy Session',
        commandId: 'cmd1',
        cwd: '/tmp/legacy',
        themeId: 'catppuccin-mocha',
        sessionToken: 'tok_legacy',
        projectId: null,
        muted: false,
        lastPreview: 'legacy preview',
        lastActivityAt: '2026-03-11T00:00:00.000Z',
        savedAt: '2026-03-11T00:00:00.000Z',
      },
    ], null, 2));

    const imported = await runNode(home, `
      const sessions = require('./sessions');
      sessions.loadSessions();
      process.stdout.write('${RESULT_PREFIX}' + JSON.stringify(sessions.getResumable()) + '\\n');
    `);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].id, 'legacy-session');

    await runNode(home, `
      const sessions = require('./sessions');
      sessions.loadSessions();
      sessions.getSessions().set('live-session', {
        name: 'Live Session',
        commandId: 'cmd1',
        cwd: '/tmp/live',
        themeId: 'catppuccin-mocha',
        sessionToken: 'tok_live',
        projectId: null,
        muted: true,
        lastPreview: 'live preview',
        lastActivityAt: '2026-03-11T00:05:00.000Z',
        pty: { kill() {} },
      });
      sessions.shutdown({
        commands: [{ id: 'cmd1', canResume: true, resumeCommand: 'resume {{sessionId}}' }],
      });
      process.stdout.write('${RESULT_PREFIX}' + JSON.stringify({ ok: true }) + '\\n');
    `);

    const reloaded = await runNode(home, `
      const sessions = require('./sessions');
      sessions.loadSessions();
      process.stdout.write('${RESULT_PREFIX}' + JSON.stringify(sessions.getResumable()) + '\\n');
    `);

    assert.equal(reloaded.length, 2);
    assert.ok(reloaded.some(session => session.id === 'legacy-session'));
    assert.ok(reloaded.some(session => session.id === 'live-session' && session.muted === true));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('transcripts migrate from jsonl and hydrate cache from SQLite after restart', async () => {
  const home = await makeHome();
  try {
    await mkdir(join(home, '.clideck', 'transcripts'), { recursive: true });
    await writeFile(join(home, '.clideck', 'transcripts', 's1.jsonl'), [
      JSON.stringify({ ts: 1, role: 'user', text: 'legacy user line' }),
      JSON.stringify({ ts: 2, role: 'agent', text: 'legacy agent line' }),
    ].join('\n') + '\n');

    const imported = await runNode(home, `
      const transcript = require('./transcript');
      transcript.init(null, new Set(['s1']));
      process.stdout.write('${RESULT_PREFIX}' + JSON.stringify(transcript.getCache()) + '\\n');
    `);
    assert.match(imported.s1, /legacy user line/);
    assert.match(imported.s1, /legacy agent line/);

    const updated = await runNode(home, `
      const { setTimeout: delay } = require('node:timers/promises');
      const transcript = require('./transcript');
      transcript.init(null, new Set(['s1']));
      transcript.trackInput('s1', 'whoami\\n');
      transcript.trackOutput('s1', 'result from agent');
      await delay(350);
      process.stdout.write('${RESULT_PREFIX}' + JSON.stringify(transcript.getCache()) + '\\n');
    `);
    assert.match(updated.s1, /whoami/);
    assert.match(updated.s1, /result from agent/);

    const reloaded = await runNode(home, `
      const transcript = require('./transcript');
      transcript.init(null, new Set(['s1']));
      process.stdout.write('${RESULT_PREFIX}' + JSON.stringify(transcript.getCache()) + '\\n');
    `);
    assert.match(reloaded.s1, /legacy user line/);
    assert.match(reloaded.s1, /whoami/);
    assert.match(reloaded.s1, /result from agent/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
