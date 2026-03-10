const { existsSync, readFileSync } = require('fs');
const os = require('os');
const { join } = require('path');
const { defaultShell, binName, parseCommand } = require('./utils');

const PRESETS = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
for (const preset of PRESETS) {
  if (preset.presetId === 'shell') preset.command = defaultShell;
}

const POSIX_ALIAS_FILES = [
  { shell: '/bin/zsh', source: '~/.zshrc', path: join(os.homedir(), '.zshrc') },
  { shell: '/bin/bash', source: '~/.bashrc', path: join(os.homedir(), '.bashrc') },
];
const ALIAS_SKIP_TOKENS = new Set(['command', 'builtin', 'noglob', 'nocorrect']);
const FUNCTION_SKIP_TOKENS = new Set(['if', 'then', 'fi', 'local', 'echo', 'return', 'export', '[', 'exec']);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

let aliasMap = new Map();

function getPresets() {
  return PRESETS;
}

function stripInlineComment(line) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#') break;
    out += ch;
  }
  return out.trim();
}

function shellInvocationTarget(command) {
  const parts = parseCommand(command || '');
  if (parts.length < 2) return null;
  const shell = binName(parts[0]);
  if (!['zsh', 'bash'].includes(shell)) return null;
  if (parts[1].startsWith('-')) return null;
  return { shell, token: parts[1], rest: parts.slice(1).join(' ') };
}

function firstRunnableToken(command) {
  const parts = parseCommand(command || '');
  let index = 0;
  while (index < parts.length && ENV_ASSIGNMENT_RE.test(parts[index])) index++;
  while (index < parts.length && ALIAS_SKIP_TOKENS.has(parts[index])) index++;
  return parts[index] || '';
}

function parseAliasLine(line, shellInfo) {
  const cleaned = stripInlineComment(line);
  if (!cleaned.startsWith('alias ')) return null;
  const match = cleaned.match(/^alias\s+([A-Za-z0-9_.-]+)\s*=\s*(["'])(.*)\2$/);
  if (!match) return null;
  const [, name, quote, rawBody] = match;
  const body = rawBody
    .replace(new RegExp(`\\\\${quote}`, 'g'), quote)
    .replace(/\\\\/g, '\\');
  const target = firstRunnableToken(body);
  if (!target) return null;
  return {
    name,
    body,
    kind: 'alias',
    shellPath: shellInfo.shell,
    source: shellInfo.source,
    target,
  };
}

function findFunctionTarget(body) {
  const lines = body.split(/\r?\n/).map(line => stripInlineComment(line).trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const token = firstRunnableToken(lines[index]);
    if (!token || FUNCTION_SKIP_TOKENS.has(token)) continue;
    return token;
  }
  return '';
}

function parseFunctions(content, shellInfo, next) {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const start = line.match(/^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*\(\)\s*\{\s*$/);
    if (!start) continue;

    const [, name] = start;
    const body = [];
    index++;
    while (index < lines.length && !/^\s*}\s*$/.test(lines[index])) {
      body.push(lines[index]);
      index++;
    }
    const bodyText = body.join('\n').trim();
    const target = findFunctionTarget(bodyText);
    if (!bodyText || !target) continue;
    next.set(name, {
      name,
      body: bodyText,
      kind: 'function',
      shellPath: shellInfo.shell,
      source: shellInfo.source,
      target,
    });
  }
}

function resolveAliasTarget(alias, seen = new Set()) {
  if (!alias || seen.has(alias.name)) return alias?.resolvedBin || alias?.target || null;
  seen.add(alias.name);
  const nested = aliasMap.get(alias.target);
  if (nested) return resolveAliasTarget(nested, seen);
  return binName(alias.target);
}

function matchPresetByBin(bin) {
  return PRESETS.find(preset => binName(preset.command) === bin) || null;
}

function loadAliases() {
  const next = new Map();
  if (process.platform === 'win32') return next;

  for (const file of POSIX_ALIAS_FILES) {
    if (!existsSync(file.path)) continue;
    let content = '';
    try {
      content = readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const alias = parseAliasLine(line, file);
      if (alias) next.set(alias.name, alias);
    }
    parseFunctions(content, file, next);
  }

  aliasMap = next;
  for (const alias of aliasMap.values()) {
    alias.resolvedBin = resolveAliasTarget(alias);
    alias.presetId = matchPresetByBin(alias.resolvedBin)?.presetId || null;
  }
  return aliasMap;
}

function refreshAgentRegistry() {
  loadAliases();
  return { presets: PRESETS, aliases: aliasMap };
}

function getAliases() {
  if (!aliasMap.size) loadAliases();
  return [...aliasMap.values()];
}

function getAliasInfo(command) {
  if (!aliasMap.size) loadAliases();
  const token = firstRunnableToken(command);
  if (token && aliasMap.has(token)) return aliasMap.get(token) || null;
  const shellCall = shellInvocationTarget(command);
  if (!shellCall) return null;
  return aliasMap.get(shellCall.token) || null;
}

function findPresetForCommand(command) {
  const alias = getAliasInfo(command);
  const resolvedBin = alias?.resolvedBin || binName(command || '');
  if (!resolvedBin) return null;
  return matchPresetByBin(resolvedBin);
}

function usesPreset(command, presetId) {
  return findPresetForCommand(command)?.presetId === presetId;
}

function deriveResumeCommand(command, preset) {
  if (!preset?.resumeCommand) return null;
  const trimmed = preset.resumeCommand.trim();
  const firstSpace = trimmed.indexOf(' ');
  const suffix = firstSpace === -1 ? '' : trimmed.slice(firstSpace);
  return `${(command || '').trim()}${suffix}`;
}

function shouldAdoptPresetDefaults(cmd) {
  return !cmd.presetId || (
    !cmd.isAgent &&
    !cmd.canResume &&
    !cmd.resumeCommand &&
    !cmd.sessionIdPattern &&
    !cmd.outputMarker &&
    !cmd.bridge
  );
}

function syncCommandWithPreset(cmd) {
  const preset = findPresetForCommand(cmd.command);
  const alias = getAliasInfo(cmd.command);

  if (alias) {
    cmd.shellAlias = alias.name;
    cmd.shellAliasShell = alias.shellPath;
    cmd.shellAliasSource = alias.source;
  } else {
    delete cmd.shellAlias;
    delete cmd.shellAliasShell;
    delete cmd.shellAliasSource;
  }

  if (!preset) {
    delete cmd.presetId;
    delete cmd.bridge;
    if (!cmd.icon) cmd.icon = 'terminal';
    if (cmd.telemetryEnabled === undefined) cmd.telemetryEnabled = false;
    if (cmd.telemetryStatus === undefined) cmd.telemetryStatus = null;
    return null;
  }

  const adoptDefaults = shouldAdoptPresetDefaults(cmd);
  cmd.presetId = preset.presetId;
  cmd.icon = preset.icon;
  if (adoptDefaults) {
    cmd.isAgent = preset.isAgent;
    cmd.canResume = preset.canResume;
  } else {
    if (cmd.isAgent === undefined) cmd.isAgent = preset.isAgent;
    if (cmd.canResume === undefined) cmd.canResume = preset.canResume;
  }
  if ((cmd.resumeCommand == null || adoptDefaults) && preset.resumeCommand) {
    cmd.resumeCommand = deriveResumeCommand(cmd.command, preset);
  }
  if ((cmd.sessionIdPattern == null || adoptDefaults) && preset.sessionIdPattern) {
    cmd.sessionIdPattern = preset.sessionIdPattern;
  }
  if ((cmd.outputMarker == null || adoptDefaults) && preset.outputMarker) {
    cmd.outputMarker = preset.outputMarker;
  }
  if (preset.bridge) cmd.bridge = preset.bridge;
  else delete cmd.bridge;

  if (preset.presetId === 'claude-code') {
    cmd.telemetryEnabled = true;
    cmd.telemetryStatus = { ok: true };
  } else {
    if (cmd.telemetryEnabled === undefined) cmd.telemetryEnabled = false;
    if (cmd.telemetryStatus === undefined) cmd.telemetryStatus = null;
  }

  return preset;
}

function discoverAliasCommands(commands) {
  const existing = new Set(commands.filter(cmd => cmd.enabled !== false).map((cmd) => {
    const alias = getAliasInfo(cmd.command);
    return alias?.name || (cmd.command || '').trim();
  }).filter(Boolean));
  for (const alias of getAliases()) {
    if (!alias.presetId || existing.has(alias.name)) continue;
    const preset = PRESETS.find(item => item.presetId === alias.presetId);
    if (!preset) continue;
    commands.push({
      id: crypto.randomUUID(),
      label: alias.name,
      icon: preset.icon,
      command: alias.name,
      enabled: true,
      defaultPath: '',
      isAgent: preset.isAgent,
      canResume: preset.canResume,
      resumeCommand: deriveResumeCommand(alias.name, preset),
      sessionIdPattern: preset.sessionIdPattern || null,
      outputMarker: preset.outputMarker || null,
      telemetryEnabled: preset.presetId === 'claude-code',
      telemetryStatus: preset.presetId === 'claude-code' ? { ok: true } : null,
      bridge: preset.bridge,
      presetId: preset.presetId,
      shellAlias: alias.name,
      shellAliasShell: alias.shellPath,
      shellAliasSource: alias.source,
      autoDetected: true,
    });
    existing.add(alias.name);
  }
}

function getAliasesForPreset(presetId) {
  return getAliases().filter(alias => alias.presetId === presetId);
}

function parseSpawnCommand(command) {
  if (process.platform === 'win32') return parseCommand(command);
  const alias = getAliasInfo(command);
  if (!alias) return parseCommand(command);
  const shellCall = shellInvocationTarget(command);
  const shellCommand = shellCall?.rest || command;
  return [alias.shellPath, '-ic', shellCommand];
}

loadAliases();

module.exports = {
  deriveResumeCommand,
  discoverAliasCommands,
  findPresetForCommand,
  getAliasInfo,
  getAliases,
  getAliasesForPreset,
  getPresets,
  parseSpawnCommand,
  refreshAgentRegistry,
  syncCommandWithPreset,
  usesPreset,
};
