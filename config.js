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

const DEFAULTS = {
  defaultPath: join(os.homedir(), 'Documents'),
  commands: [
    {
      id: '1', label: 'Shell', icon: 'terminal', command: defaultShell, enabled: true,
      defaultPath: '', isAgent: false, canResume: false, resumeCommand: null, sessionIdPattern: null,
    },
  ],
  confirmClose: true,
  notifySoundEnabled: true,
  notifySound: 'soft-beep',
  defaultTheme: 'catppuccin-mocha',
  defaultShell,
  prompts: [],
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
    // Icon always syncs from preset — the preset is the source of truth for logos
    if (preset) cmd.icon = preset.icon;
    else if (!cmd.icon) cmd.icon = 'terminal';
    if (cmd.isAgent === undefined)          cmd.isAgent = preset?.isAgent ?? false;
    if (cmd.canResume === undefined)        cmd.canResume = preset?.canResume ?? false;
    if (cmd.resumeCommand === undefined)    cmd.resumeCommand = preset?.resumeCommand || null;
    if (cmd.sessionIdPattern === undefined) cmd.sessionIdPattern = preset?.sessionIdPattern || null;
    if (cmd.outputMarker === undefined)     cmd.outputMarker = preset?.outputMarker || null;
    // Claude Code telemetry is built-in, always on
    if (preset?.presetId === 'claude-code') cmd.telemetryEnabled = true;
    else if (cmd.telemetryEnabled === undefined) cmd.telemetryEnabled = false;
    if (cmd.telemetryStatus === undefined)  cmd.telemetryStatus = null;
    // Sync bridge config from preset
    if (preset?.bridge) cmd.bridge = preset.bridge;
    // Codex: add --no-alt-screen to avoid blank screen in embedded xterm
    if (preset?.presetId === 'codex') {
      if (cmd.command === 'codex') cmd.command = preset.command;
      if (cmd.resumeCommand === 'codex resume {{sessionId}}') cmd.resumeCommand = preset.resumeCommand;
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
  if (!next) next = normalize(DEFAULTS, { discoverAliases: true });
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
