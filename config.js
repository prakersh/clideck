const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const os = require('os');
const { openDb } = require('./db');
const { DATA_DIR } = require('./paths');
const { defaultShell, binName } = require('./utils');
const {
  discoverAliasCommands,
  getPresets,
  syncCommandWithPreset,
} = require('./agent-registry');

const CONFIG_PATH = join(DATA_DIR, 'config.json');
const CONFIG_ROW_ID = 'default';

const STARTER_PROMPTS = [
  {
    id: 'starter-prompt-update-documentation',
    name: 'Update documentation',
    text: 'Our docs needs to be updated based on the latest diff changes. Please review the latest changes and udpate the docs accordingly. List the changes you did in concise points in your response. Thanks.',
  },
  {
    id: 'starter-prompt-investigate-codebase',
    name: 'Investigate codebase',
    text: `Learn the codebase and investigate it for:
- Critical issues
- Serious logical issues
- Things you dont understand why they are there
- Redundent code
- Ugly workarounds / plasters / band-aids

list your fidings please.`,
  },
  {
    id: 'starter-prompt-reviewer-findings',
    name: 'Reviewer findings',
    text: 'Here are the reviewer findings, if you find that any are valid and relevant, please fix with pure solutions, simple approaches, never apply workarounds / plasters.\nWhen finish, list what you fix and how:',
  },
];

const STARTER_ROLES = [
  {
    id: 'starter-role-programmer',
    name: 'Programmer',
    instructions: `You are the main programmer of this project.
Do you not apply workarounds or bandaids, prefer pure solutions.
NEVER use plan tool/mode, start to build immediatly and ask questions along the way if any.
Check if any external findings are valid before applying changes, the reviewer doesnt always updated with the full scope.
When you done with changes, list concisely what you did.

Learn the project quickly if exist. Go over the structure, code and functionality.
Let me know when you are ready.`,
  },
  {
    id: 'starter-role-reviewer',
    name: 'Reviewer',
    instructions: `You are the code reviewer in this project.
Your task is check the coder output and list critical / logical design flow issues, ugly workarounds or functionalty you just dont understand why its there. Do not waste time and list insignificunt findings.

If you didnt find anything, response with no findings.

You never write code!.

Quickly learn the project if exist. Go over the structure, code and functionality and let me know when you are ready.`,
  },
  {
    id: 'starter-role-product-manager',
    name: 'Product manager',
    instructions: `You are the product manager of this project, you should understand why we do what we do and what is the best way to do it. You dont care about technical limitations or directions, the only thing matter to you is the user UI/UX and how this agents team will ship a top notch, professional deliveries.
Do not allow the team to round angles and skip small stuff that will basly impact the user.

You never write code!
You dont use your plan tool/mode - instead you are planning immediatly as you go.

Go over the project if exist and understand from the code, documentations and readme what is it and why we do it.

Let me know when you are ready`,
  },
];

const DEFAULTS = {
  defaultPath: join(os.homedir(), 'Documents'),
  commands: [
    {
      id: '1', label: 'Shell', icon: 'terminal', command: defaultShell, enabled: true,
      defaultPath: '', isAgent: false, canResume: false, resumeCommand: null, sessionIdPattern: null,
    },
  ],
  confirmClose: true,
  notifyIdle: true,
  notifySoundEnabled: true,
  notifySound: 'soft-beep',
  notifyMinWork: 0,
  defaultTheme: 'catppuccin-mocha',
  defaultShell,
  prompts: [],
  roles: [],
  projects: [],
};

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }
const PRESETS = getPresets();

function matchPreset(cmd) {
  const bin = binName(cmd.command);
  return PRESETS.find(p => binName(p.command) === bin);
}

function normalize(input, { discoverAliases = false } = {}) {
  const cfg = { ...deepCopy(DEFAULTS), ...deepCopy(input || {}) };
  if (!Array.isArray(cfg.commands) || !cfg.commands.length) cfg.commands = deepCopy(DEFAULTS.commands);

  // Migrate profiles → defaultTheme
  if (cfg.profiles && !cfg.defaultTheme) {
    const defProfile = cfg.profiles.find(p => p.id === cfg.defaultProfile) || cfg.profiles[0];
    cfg.defaultTheme = defProfile?.themeId || 'default';
  }
  delete cfg.profiles;
  delete cfg.defaultProfile;
  if (!cfg.defaultTheme || cfg.defaultTheme === 'solarized-dark') cfg.defaultTheme = 'catppuccin-mocha';
  cfg.defaultShell = defaultShell;

  // Backfill and sync fields from presets and alias-matched variants.
  for (const cmd of cfg.commands) {
    const preset = cmd.presetId ? PRESETS.find(p => p.presetId === cmd.presetId) : matchPreset(cmd);
    // Stamp presetId for reliable lookup
    if (preset && !cmd.presetId) cmd.presetId = preset.presetId;
    // Icon syncs from preset only when the user hasn't customised it. A custom
    // icon (set via the picker — see settings.js isValidCustomIcon) carries a
    // distinct shape: an emoji grapheme, a path/url, or the string 'terminal'
    // explicitly chosen by the user. We only stamp the preset icon when the
    // current value is missing or matches a stale preset asset path.
    if (preset) {
      const presetIcons = new Set(PRESETS.map(p => p.icon).filter(Boolean));
      if (!cmd.icon || presetIcons.has(cmd.icon)) cmd.icon = preset.icon;
    } else if (!cmd.icon) {
      cmd.icon = 'terminal';
    }
    if (cmd.isAgent === undefined)          cmd.isAgent = preset?.isAgent ?? false;
    if (cmd.canResume === undefined)        cmd.canResume = preset?.canResume ?? false;
    if (cmd.resumeCommand === undefined)    cmd.resumeCommand = preset?.resumeCommand || null;
    if (cmd.sessionIdPattern === undefined) cmd.sessionIdPattern = preset?.sessionIdPattern || null;
    if (cmd.outputMarker === undefined)     cmd.outputMarker = preset?.outputMarker || null;
    // Claude Code telemetry is built-in, always on
    if (preset?.telemetryEnabled === true) cmd.telemetryEnabled = true;
    else if (preset?.presetId === 'claude-code') cmd.telemetryEnabled = true;
    else if (cmd.telemetryEnabled === undefined) cmd.telemetryEnabled = false;
    if (cmd.telemetryStatus === undefined)  cmd.telemetryStatus = null;
    // Sync bridge config from preset
    if (preset?.bridge) cmd.bridge = preset.bridge;
    // Codex: keep shipped default commands aligned with the current preset.
    // Only rewrite the known default strings so custom Codex commands stay intact.
    if (preset?.presetId === 'codex') {
      if (cmd.command === 'codex' || cmd.command === 'codex --no-alt-screen') cmd.command = preset.command;
      if (cmd.resumeCommand === 'codex resume {{sessionId}}' || cmd.resumeCommand === 'codex resume {{sessionId}} --no-alt-screen') {
        cmd.resumeCommand = preset.resumeCommand;
      }
    }
  }

  // Auto-add any shipped presets not yet in the commands list
  for (const preset of PRESETS) {
    const exists = cfg.commands.some(c => c.presetId === preset.presetId || matchPreset(c)?.presetId === preset.presetId);
    if (!exists) {
      cfg.commands.push({
        id: crypto.randomUUID(), presetId: preset.presetId, label: preset.name, icon: preset.icon,
        command: preset.command, enabled: true, defaultPath: '',
        isAgent: preset.isAgent, canResume: preset.canResume,
        resumeCommand: preset.resumeCommand, sessionIdPattern: preset.sessionIdPattern,
        outputMarker: preset.outputMarker || null,
      });
    }
  }

  if (discoverAliases) discoverAliasCommands(cfg.commands);
  for (const cmd of cfg.commands) syncCommandWithPreset(cmd);

  if (!cfg.projects) cfg.projects = [];
  if (!cfg.roles) cfg.roles = [];
  return cfg;
}

function load() {
  const db = openDb();
  const row = db.prepare('SELECT config_json FROM app_config WHERE id = ? LIMIT 1').get(CONFIG_ROW_ID);
  if (row?.config_json) {
    try {
      return normalize(JSON.parse(row.config_json), { discoverAliases: true });
    } catch {}
  }

  let next = null;
  if (existsSync(CONFIG_PATH)) {
    try {
      next = normalize(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')), { discoverAliases: true });
    } catch {}
  }
  if (!next) {
    // Fresh install — seed starter prompts and roles so the user has examples.
    next = normalize({
      ...deepCopy(DEFAULTS),
      prompts: deepCopy(STARTER_PROMPTS),
      roles: deepCopy(STARTER_ROLES),
    }, { discoverAliases: true });
  }
  save(next);
  return next;
}

function save(config) {
  const db = openDb();
  const normalized = normalize(config);
  const payload = JSON.stringify(normalized, null, 2);
  db.prepare(`
    INSERT INTO app_config (id, config_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `).run(CONFIG_ROW_ID, payload, Date.now());
  return normalized;
}

module.exports = { load, normalize, save };
