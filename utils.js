const { chmodSync, statSync, readdirSync } = require('fs');
const { dirname, join } = require('path');
const { homedir } = require('os');

function ensurePtyHelper() {
  if (process.platform === 'win32') return;
  try {
    const pkgDir = dirname(require.resolve('node-pty/package.json'));
    const helper = join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    const mode = statSync(helper).mode & 0o777;
    if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o111);
  } catch {}
}

function parseCommand(str) {
  const parts = [];
  let current = '';
  let inQuote = null;
  for (const ch of str) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  if (!parts.length) return [defaultShell];
  // On Windows, node-pty can't resolve non-.exe commands via PATH (e.g. claude, codex).
  // Wrap through cmd.exe /c so Windows handles PATHEXT resolution natively.
  if (process.platform === 'win32' && !parts[0].match(/\.(exe|com)$/i) && !/^[a-z]:\\/i.test(parts[0])) {
    return [process.env.COMSPEC || 'cmd.exe', '/c', ...parts];
  }
  return parts;
}

function resolveValidDir(dir) {
  const expanded = expandHomePath(dir);
  try {
    if (expanded && statSync(expanded).isDirectory()) return expanded;
  } catch {}
  return homedir();
}

function listDirs(path) {
  const expanded = expandHomePath(path);
  try {
    return readdirSync(expanded, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .sort();
  } catch (e) {
    return { error: e.message };
  }
}

function expandHomePath(input) {
  if (typeof input !== 'string' || !input) return input;
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

const defaultShell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/zsh';

function binName(command) {
  const m = command.match(/^(['"])(.*?)\1/);
  const exec = m ? m[2] : command;
  return exec.split(/[\\/]/).pop().split(/\s/)[0].replace(/\.(exe|cmd)$/i, '');
}

module.exports = { ensurePtyHelper, parseCommand, resolveValidDir, listDirs, expandHomePath, defaultShell, binName };
