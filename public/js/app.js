import { state, send } from './state.js';
import { esc, binName, findPresetForCommand, resolveIconPath } from './utils.js';
import { addTerminal, removeTerminal, select, startRename, startProjectRename, setSessionTheme, openMenu, closeMenu, setStatus, updateMuteIndicator, updatePreview, markUnread, applyFilter, setTab, renderResumable, regroupSessions, toggleProjectCollapse, setSessionProject, estimateSize, restartComplete, positionMenu, setLayoutMode, fitVisibleTerminals, writeOutput, addPill, updatePill, removePill, appendPillLog, setPillLogs, closePillLog } from './terminals.js';
import { renderSettings, updateVersionFooter } from './settings.js';
import { openCreator, closeCreator, refreshCreator } from './creator.js';
import { handleDirsResponse, handleMkdirResponse, openFolderPicker } from './folder-picker.js';
import { confirmClose } from './confirm.js';
import { applyTheme } from './profiles.js';
import { toggleMode, applyMode } from './color-mode.js';
import { showToast } from './toast.js';
import './nav.js';
import { initDrag, wasDragging } from './drag.js';
import { registerHotkey, unregisterHotkey, unregisterAllForPlugin } from './hotkeys.js';
import { handleVirtualTerminalKey, renderPrompts } from './prompts.js';

const AUTH_REFRESH_MS = 60 * 60 * 1000;
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const authTitle = document.getElementById('auth-title');
const authSubtitle = document.getElementById('auth-subtitle');
const authForm = document.getElementById('auth-form');
const authStatus = document.getElementById('auth-status');
const authError = document.getElementById('auth-error');
const authSubmit = document.getElementById('auth-submit');
const authUsername = document.getElementById('auth-username');
const authPassword = document.getElementById('auth-password');

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return;
  if (location.protocol !== 'https:' && !LOCALHOST_HOSTS.has(location.hostname)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => {
        pwaInstallState.swRegistered = true;
        pwaInstallState.swRegistrationError = null;
      })
      .catch((error) => {
        pwaInstallState.swRegistered = false;
        pwaInstallState.swRegistrationError = error;
        console.warn('[pwa] service worker registration failed:', error);
      });
  });
}

// PWA Install prompt
let deferredInstallPrompt = null;
const mobileInstallButton = document.getElementById('mobile-install-btn');
const pwaInstallState = {
  swRegistered: false,
  swRegistrationError: null,
};

function setupPWAInstall() {
  const displayModeQuery = window.matchMedia('(display-mode: standalone)');

  const isStandalone = () => (
    displayModeQuery.matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || window.navigator.standalone === true
  );

  const syncInstallButton = () => {
    if (!mobileInstallButton) return;
    mobileInstallButton.hidden = isStandalone();
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    syncInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    syncInstallButton();
    showToast('CliDeck installed successfully!');
  });
  mobileInstallButton?.addEventListener('click', async () => {
    if (isStandalone()) {
      syncInstallButton();
      return;
    }

    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') deferredInstallPrompt = null;
      syncInstallButton();
      return;
    }

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isHttpsButUntrusted = location.protocol === 'https:' && !window.isSecureContext;
    if (isHttpsButUntrusted) {
      showToast('HTTPS is active, but this certificate is not trusted on this device. Trust the cert and reload.', { duration: 4800 });
      return;
    }
    if (!window.isSecureContext) {
      showToast('Install requires HTTPS (or localhost). Open CliDeck in a secure context and reload.', { duration: 4200 });
      return;
    }
    if (!('serviceWorker' in navigator)) {
      showToast('This browser does not support Service Workers, so app install is unavailable.', { duration: 4200 });
      return;
    }
    if (pwaInstallState.swRegistrationError) {
      showToast('Install is blocked because Service Worker registration failed. Check certificate trust and reload.', { duration: 4800 });
      return;
    }
    if (isIOS) {
      showToast('Use Share -> Add to Home Screen to install CliDeck.', { duration: 4200 });
      return;
    }

    showToast('Install prompt is unavailable in this browser. Use browser menu: Install app/Add to Home Screen.', { duration: 4600 });
  });

  if (typeof displayModeQuery.addEventListener === 'function') {
    displayModeQuery.addEventListener('change', syncInstallButton);
  } else if (typeof displayModeQuery.addListener === 'function') {
    displayModeQuery.addListener(syncInstallButton);
  }
  syncInstallButton();
}

function setAuthError(message = '') {
  authError.textContent = message;
  authError.classList.toggle('hidden', !message);
}

function setAuthStatus(message, { loading = false } = {}) {
  authStatus.textContent = message;
  authStatus.classList.toggle('loading', loading);
}

function showAuthShell({ setupRequired = false, error = '', loading = false, status } = {}) {
  document.body.classList.add('auth-required');
  document.body.classList.remove('auth-pending');
  authTitle.textContent = setupRequired ? 'Create the local admin account' : 'Sign in to CliDeck';
  authSubtitle.textContent = setupRequired
    ? 'This machine does not have an admin account yet. The first login creates it locally and enables a seven-day session.'
    : 'CliDeck keeps the control plane behind a local admin session. Sign in to unlock sessions, settings, and plugins.';
  authSubmit.textContent = setupRequired ? 'Create admin account' : 'Sign in';
  authForm.classList.remove('hidden');
  setAuthError(error);
  setAuthStatus(status || (setupRequired ? 'Create the first local admin account to continue.' : 'Enter your local admin credentials.'), { loading });
  if (!document.activeElement || document.activeElement === document.body) {
    (setupRequired ? authUsername : authPassword).focus();
  }
}

function showAppShell() {
  document.body.classList.remove('auth-required', 'auth-pending');
  setAuthError('');
  setAuthStatus('Authenticated.', { loading: false });
  if (location.pathname === '/login') history.replaceState({}, '', '/');
}

function stopAuthRefresh() {
  clearInterval(state.authRefreshTimer);
  state.authRefreshTimer = null;
}

function startAuthRefresh() {
  stopAuthRefresh();
  if (!state.auth.authenticated) return;
  state.authRefreshTimer = setInterval(() => {
    refreshAuthState({ suppressUi: true }).catch(() => {});
  }, AUTH_REFRESH_MS);
}

async function requestAuthState() {
  const res = await fetch('/auth/me', { credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function refreshAuthState({ suppressUi = false } = {}) {
  const result = await requestAuthState();

  if (result.ok) {
    state.auth.ready = true;
    state.auth.authenticated = true;
    state.auth.setupRequired = false;
    state.auth.user = result.data.user;
    showAppShell();
    startAuthRefresh();
    return true;
  }

  state.auth.ready = true;
  state.auth.authenticated = false;
  state.auth.setupRequired = !!result.data?.setupRequired;
  state.auth.user = null;
  stopAuthRefresh();

  if (!suppressUi) showAuthShell({ setupRequired: state.auth.setupRequired });
  return false;
}

async function submitAuthForm(event) {
  event.preventDefault();
  setAuthError('');
  setAuthStatus(state.auth.setupRequired ? 'Creating local admin account…' : 'Signing in…', { loading: true });
  authSubmit.disabled = true;

  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: authUsername.value.trim(),
        password: authPassword.value,
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setAuthError(payload.error || 'Sign-in failed.');
      showAuthShell({
        setupRequired: !!payload.setupRequired || state.auth.setupRequired,
        status: 'Authentication failed. Check the credentials and try again.',
      });
      return;
    }

    authPassword.value = '';
    await refreshAuthState();
    connect();
  } catch (error) {
    setAuthError(error.message || 'Unable to reach the local server.');
    showAuthShell({
      setupRequired: state.auth.setupRequired,
      status: 'Could not reach the local auth endpoint.',
    });
  } finally {
    authSubmit.disabled = false;
  }
}

async function logout() {
  state.auth.loggingOut = true;
  stopAuthRefresh();
  if (state.ws) {
    try { state.ws.close(1000, 'logout'); } catch {}
    state.ws = null;
  }

  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}

  state.auth.authenticated = false;
  state.auth.user = null;
  state.auth.loggingOut = false;
  history.replaceState({}, '', '/login');
  showAuthShell({ setupRequired: false, status: 'Signed out.' });
}

const shownAgentHealthToasts = new Set();
let reconnectReplaySkip = null;

function connect() {
  if (!state.auth.authenticated) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${protocol}://${location.host}`);

  state.ws.onopen = () => {
    // Skip replaying output the client already has in its buffers
    reconnectReplaySkip = new Set(state.terms.keys());
    send({ type: 'remote.status' });
    syncSplitToggleButton();
  };

  state.ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'config':
        state.cfg = msg.config;
        applyMode(state.cfg.colorMode || 'dark');
        regroupSessions();
        renderSettings();
        renderPrompts();
        refreshCreator();
        for (const [, entry] of state.terms) applyTheme(entry.term, entry.themeId);
        break;
      case 'themes':
        state.themes = msg.themes;
        renderSettings();
        break;
      case 'presets':
        state.presets = msg.presets;
        renderSettings();
        refreshCreator();
        for (const p of state.presets) {
          if (p.available && p.health && !p.health.ok && p.health.reason !== 'Not installed' && !shownAgentHealthToasts.has(p.presetId)) {
            shownAgentHealthToasts.add(p.presetId);
            showToast(`${p.name}: ${p.health.reason}`, { id: `agent-health-${p.presetId}`, type: p.versionOk === false ? 'error' : 'warn', duration: 0, title: 'Agent Attention' });
          }
        }
        break;
      case 'sessions.resumable':
        state.resumable = msg.list;
        renderResumable();
        break;
      case 'sessions':
        {
          const liveIds = new Set(msg.list.map(s => s.id));
          for (const id of [...state.terms.keys()]) {
            if (!liveIds.has(id)) removeTerminal(id);
          }
          msg.list.forEach(s => addTerminal(s.id, s.name, s.themeId, s.commandId, s.projectId, s.muted, s.lastPreview, s.presetId));
          if (!state.active || !state.terms.has(state.active)) {
            if (msg.list.length) select(msg.list[0].id);
          }
        }
        break;
      case 'created':
        if (!state.terms.has(msg.id)) addTerminal(msg.id, msg.name, msg.themeId, msg.commandId, msg.projectId, msg.muted, msg.lastPreview, msg.presetId);
        select(msg.id);
        applyFilter();
        closeMobileSidebar();
        break;
      case 'output': {
        const entry = state.terms.get(msg.id);
        if (msg.replay && reconnectReplaySkip?.has(msg.id) && entry) break;
        if (entry) {
          writeOutput(msg.id, msg.data);
          updatePreview(msg.id);
          markUnread(msg.id);
        }
        break;
      }
      case 'closed':
        removeTerminal(msg.id);
        break;
      case 'session.restarted':
        console.log('[restart] got session.restarted from server', msg);
        restartComplete(msg.id, msg);
        break;
      // Telemetry/bridge working/idle
      case 'session.status':
        setStatus(msg.id, msg.working);
        break;
      // Server requests terminal capture (e.g. after PermissionRequest hook)
      case 'terminal.capture': {
        const ce = state.terms.get(msg.id);
        if (ce?.term) {
          const buf = ce.term.buffer.active;
          const lines = [];
          for (let i = 0; i < buf.length; i++) { const line = buf.getLine(i); if (line) lines.push(line.translateToString(true)); }
          send({ type: 'terminal.buffer', id: msg.id, lines, menuVersion: msg.menuVersion });
        }
        break;
      }
      case 'session.history': {
        const entry = state.terms.get(msg.id);
        if (msg.replay && reconnectReplaySkip?.has(msg.id) && entry) break;
        if (entry && !entry.queue(msg.text + '\n')) entry.term.write(msg.text + '\n');
        updatePreview(msg.id);
        break;
      }
      // Bridge preview text (OpenCode plugin)
      case 'session.preview': {
        const pe = state.terms.get(msg.id);
        if (pe && msg.text) {
          pe.lastPreviewText = msg.text;
          pe.lastActivityAt = Date.now();
          const el = document.querySelector(`.group[data-id="${msg.id}"] .session-preview`);
          if (el) el.textContent = msg.text;
          // Persist bridge preview on server — picked up by 30s auto-save
          send({ type: 'session.setPreview', id: msg.id, text: msg.text, timestamp: new Date().toISOString() });
        }
        break;
      }
      /* [OLD-STATUS] I/O burst heuristic — replaced by onRender detection in terminals.js
      case 'stats': {
        for (const [sid, st] of Object.entries(msg.stats)) {
          const entry = state.terms.get(sid);
          if (!entry) continue;
          const cmd = state.cfg.commands.find(c => c.id === entry.commandId);
          if (cmd?.bridge) continue;
          const net = Math.max(st.rawRateOut || 0, st.rawRateIn || 0);
          const burstUp = (st.burstMs || 0) > (entry.prevBurst || 0) && st.burstMs > 0;
          const userTyping = (st.rawRateIn || 0) > 0 && (st.rawRateIn || 0) < 50;
          entry.prevBurst = st.burstMs || 0;

          const isWorking = burstUp && net >= 800 && !userTyping;
          const isIdle = !burstUp && net < 800;

          if (isWorking) entry.workTicks = (entry.workTicks || 0) + 1;
          else entry.workTicks = 0;
          if (isIdle) entry.idleTicks = (entry.idleTicks || 0) + 1;
          else entry.idleTicks = 0;

          if (entry.workTicks >= 2) {
            if (!entry.working) send({ type: 'session.statusReport', id: sid, working: true });
            setStatus(sid, true);
          } else if (entry.idleTicks >= 2) {
            if (entry.working) send({ type: 'session.statusReport', id: sid, working: false });
            setStatus(sid, false);
          }
        }
        break;
      }
      [OLD-STATUS] */
      case 'transcript.cache':
        state.transcriptCache = msg.cache;
        for (const [id, text] of Object.entries(msg.cache)) {
          const entry = state.terms.get(id);
          if (entry) entry.searchText = text;
        }
        break;
      case 'transcript.append': {
        state.transcriptCache[msg.id] = (state.transcriptCache[msg.id] || '') + '\n' + msg.text;
        const entry = state.terms.get(msg.id);
        if (entry) {
          entry.searchText = (entry.searchText || '') + '\n' + msg.text;
          if (state.filter.query) applyFilter();
        }
        break;
      }
      case 'dirs':
        handleDirsResponse(msg);
        break;
      case 'dirs.mkdir':
        handleMkdirResponse(msg);
        break;
      case 'session.theme': {
        const entry = state.terms.get(msg.id);
        if (entry) {
          entry.themeId = msg.themeId;
          applyTheme(entry.term, msg.themeId);
        }
        break;
      }
      case 'session.setProject': {
        const entry = state.terms.get(msg.id);
        if (entry) { entry.projectId = msg.projectId; regroupSessions(); }
        break;
      }
      case 'session.mute': {
        const entry = state.terms.get(msg.id);
        if (entry) { entry.muted = !!msg.muted; updateMuteIndicator(msg.id); }
        break;
      }
      case 'session.needsSetup': {
        const entry = state.terms.get(msg.id);
        if (entry) showTelemetrySetup(entry.commandId, msg.id);
        break;
      }
      case 'renamed': {
        const el = document.querySelector(`.group[data-id="${msg.id}"] .name`);
        if (el && el.contentEditable !== 'true') el.textContent = msg.name;
        break;
      }
      case 'telemetry.autosetup.result': {
        const toast = document.querySelector(`[data-setup-preset="${msg.presetId}"]`);
        if (!toast) break;
        const actionsEl = toast.querySelector('.setup-actions');
        if (msg.success) {
          const sid = (toast.dataset.sessionId && toast.dataset.sessionId !== 'null' && toast.dataset.sessionId !== 'undefined')
            ? toast.dataset.sessionId
            : '';
          actionsEl.innerHTML = `
            <div class="flex-1 flex items-center gap-1.5 text-xs text-emerald-400">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>
              Configured
            </div>
            ${sid ? `<button class="restart-btn px-3 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">Restart Session</button>` : ''}
            <button class="dismiss-btn px-3 py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">Dismiss</button>`;
          actionsEl.querySelector('.dismiss-btn').onclick = () => toast.remove();
          if (sid) actionsEl.querySelector('.restart-btn').onclick = () => {
            const entry = state.terms.get(sid);
            send({ type: 'session.restart', id: sid, themeId: entry?.themeId, cols: entry?.term?.cols, rows: entry?.term?.rows });
            toast.remove();
          };
        } else {
          shownSetup.delete(msg.presetId);
          const btn = toast.querySelector('.auto-setup-btn');
          btn.textContent = 'Failed — configure manually';
          btn.className = 'auto-setup-btn flex-1 px-3 py-2 text-xs font-medium bg-red-600/20 text-red-400 border border-red-500/30 rounded-lg cursor-default';
        }
        break;
      }
      case 'project.openPath.result':
        if (!msg.success) showToast(msg.error || 'Failed to open project folder', { type: 'error' });
        break;
      case 'sessions.saved':
        flashSaveIndicator();
        break;
      case 'plugins':
        loadPlugins(msg.list);
        break;
      case 'plugin.install.result': {
        const btn = document.querySelector(`.plugin-install-btn[data-plugin-id="${msg.pluginId}"]`);
        if (!btn) break;
        if (msg.success) {
          btn.textContent = 'Installed';
          btn.className = btn.className.replace('bg-blue-600 hover:bg-blue-500 text-white', 'bg-emerald-600/20 text-emerald-400 cursor-default');
        } else {
          btn.textContent = 'Failed';
          btn.className = btn.className.replace('bg-blue-600 hover:bg-blue-500', 'bg-red-600/20 text-red-400 cursor-default');
          btn.disabled = false;
        }
        break;
      }
      case 'pills':
        {
          const liveIds = new Set(msg.list.map(p => p.id));
          for (const id of [...state.pills.keys()]) {
            if (!liveIds.has(id)) removePill(id);
          }
          for (const p of msg.list) {
            if (state.pills.has(p.id)) updatePill(p);
            else addPill(p);
          }
        }
        break;
      case 'pill.added':
        addPill(msg.pill);
        break;
      case 'pill.updated':
        updatePill(msg.pill);
        break;
      case 'pill.removed':
        removePill(msg.id);
        break;
      case 'pill.log':
        appendPillLog(msg.id, msg.entry);
        break;
      case 'pill.logs':
        setPillLogs(msg.id, msg.logs);
        break;
      case 'plugin.delete.error':
        showToast(`Failed to remove plugin: ${msg.error}`, { duration: 4000 });
        break;
      case 'remote.status':
        handleRemoteStatus(msg);
        break;
      case 'remote.paired':
        handleRemotePaired(msg);
        break;
      case 'remote.unpaired':
        handleRemoteUnpaired();
        break;
      case 'remote.error':
        handleRemoteError(msg.error);
        break;
      case 'remote.install.progress':
        appendInstallLog(msg.text);
        break;
      case 'remote.install.done':
        handleInstallDone(msg.success);
        break;
      case 'remote.update':
        remoteUpdateInfo = msg?.available ? msg : null;
        if (remotePreflight?.pending) {
          remotePreflight.updateSeen = true;
          finishRemotePreflight();
        }
        break;
      default:
        if (msg.type?.startsWith('plugin.')) dispatchPluginMessage(msg);
        break;
    }
  };

  state.ws.onclose = async () => {
    state.ws = null;
    if (state.auth.loggingOut) return;

    let authenticated = false;
    try {
      authenticated = await refreshAuthState({ suppressUi: true });
    } catch {
      if (state.auth.authenticated) {
        setTimeout(connect, 1000);
      }
      return;
    }

    if (!authenticated) {
      history.replaceState({}, '', '/login');
      showAuthShell({ setupRequired: state.auth.setupRequired });
      return;
    }

    setTimeout(connect, 1000);
  };
}

const mobileSidebarQuery = window.matchMedia('(max-width: 960px)');
const mobileKeybarToggle = document.getElementById('mobile-keybar-toggle');
const mobileRefreshButton = document.getElementById('mobile-refresh-btn');
const mobileKeybar = document.getElementById('mobile-keybar');
const mobileSelectToggle = document.getElementById('mobile-select-toggle');
const splitToggleButton = document.getElementById('split-toggle');
const mobileTopNav = document.getElementById('mobile-top-nav');
const MOBILE_KEYBOARD_THRESHOLD = 90;
const PULL_REFRESH_START_ZONE_RATIO = 0.25;
const PULL_REFRESH_TRIGGER_PX = 72;
const DIRECT_SEQUENCES = {
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+l': '\x0c',
  'shift+tab': '\x1b[Z',
};
const pullRefreshState = {
  tracking: false,
  armed: false,
  startY: 0,
};

function triggerFullRefresh() {
  const url = new URL(window.location.href);
  url.searchParams.set('_reload', String(Date.now()));
  window.location.replace(url.toString());
}

function resetPullRefreshState() {
  pullRefreshState.tracking = false;
  pullRefreshState.startY = 0;
  pullRefreshState.armed = false;
  mobileRefreshButton?.classList.remove('pull-armed');
}

function canStartPullRefresh(event) {
  if (!mobileSidebarQuery.matches) return false;
  if (document.body.classList.contains('auth-pending') || document.body.classList.contains('auth-required')) return false;
  if (document.body.classList.contains('mobile-nav-open')) return false;
  if (document.body.classList.contains('mobile-selection-mode')) return false;
  if (!document.getElementById('settings-overlay')?.classList.contains('hidden')) return false;
  if (document.getElementById('session-creator') || document.getElementById('project-creator')) return false;
  if (!mobileTopNav || !mobileTopNav.contains(event.target)) return false;
  if (event.target?.closest?.('button, a, input, textarea, select, [role="button"]')) return false;

  const touch = event.touches?.[0];
  if (!touch) return false;
  if (event.touches.length !== 1) return false;
  if (touch.clientY > window.innerHeight * PULL_REFRESH_START_ZONE_RATIO) return false;
  return true;
}

function closeMobileSidebar() {
  document.body.classList.remove('mobile-nav-open');
}

function syncModifierButtons() {
  mobileKeybar?.querySelectorAll('[data-modifier]').forEach((btn) => {
    const active = !!state.mobileKeybar.modifiers[btn.dataset.modifier];
    btn.classList.toggle('mod-active', active);
  });
}

function syncSelectionButton() {
  mobileSelectToggle?.classList.toggle('select-active', !!state.mobileKeybar.selectionMode);
}

function setMobileSelectionMode(enabled) {
  state.mobileKeybar.selectionMode = !!enabled && mobileSidebarQuery.matches;
  document.body.classList.toggle('mobile-selection-mode', state.mobileKeybar.selectionMode);
  syncSelectionButton();
}

function syncSplitToggleButton() {
  if (!splitToggleButton) return;
  const splitMode = state.layout.mode === 'split';
  splitToggleButton.dataset.mode = splitMode ? 'split' : 'single';
  splitToggleButton.textContent = splitMode ? 'Single View' : 'Split View';
  splitToggleButton.setAttribute('aria-pressed', String(splitMode));
}

function setWorkspaceLayout(mode) {
  setLayoutMode(mode);
  syncSplitToggleButton();
}

function toggleSplitLayout() {
  if (mobileSidebarQuery.matches) return;
  setWorkspaceLayout(state.layout.mode === 'split' ? 'single' : 'split');
}

function refreshActiveTerminalViewport({ scrollBottom = false } = {}) {
  fitVisibleTerminals({ scrollBottom, activeOnly: true });
}

function getMobileKeyboardInset() {
  if (!mobileSidebarQuery.matches || !window.visualViewport) return 0;
  const vv = window.visualViewport;
  return Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
}

function syncMobileKeyboardViewport() {
  if (!mobileSidebarQuery.matches) {
    document.documentElement.style.setProperty('--mobile-kb-offset', '0px');
    document.body.classList.remove('mobile-keyboard-open');
    return;
  }

  const inset = getMobileKeyboardInset();
  document.documentElement.style.setProperty('--mobile-kb-offset', `${inset}px`);
  const keyboardOpen = inset > MOBILE_KEYBOARD_THRESHOLD;
  document.body.classList.toggle('mobile-keyboard-open', keyboardOpen);

  if (keyboardOpen) {
    setMobileKeybarOpen(false);
    setMobileSelectionMode(false);
    refreshActiveTerminalViewport();
  }
}

function clearModifierLatch() {
  state.mobileKeybar.modifiers.ctrl = false;
  state.mobileKeybar.modifiers.alt = false;
  state.mobileKeybar.modifiers.shift = false;
  syncModifierButtons();
}

function setMobileKeybarOpen(nextOpen) {
  state.mobileKeybar.open = !!nextOpen && mobileSidebarQuery.matches;
  document.body.classList.toggle('mobile-keybar-open', state.mobileKeybar.open);
  if (!state.mobileKeybar.open) setMobileSelectionMode(false);
}

function toggleMobileSidebar(force) {
  if (!mobileSidebarQuery.matches) return;
  const next = force ?? !document.body.classList.contains('mobile-nav-open');
  document.body.classList.toggle('mobile-nav-open', next);
}

function sendTerminalKey(seq) {
  if (!state.active || !seq) return;
  send({ type: 'input', id: state.active, data: seq });
}

function arrowModifierCode(mods) {
  const shift = mods.shift ? 1 : 0;
  const alt = mods.alt ? 1 : 0;
  const ctrl = mods.ctrl ? 1 : 0;
  if (!shift && !alt && !ctrl) return null;
  return 1 + shift + (alt * 2) + (ctrl * 4);
}

function csi(final, mods) {
  if (!mods) return `\x1b[${final}`;
  return `\x1b[1;${mods}${final}`;
}

function controlChar(letter) {
  const code = letter.toUpperCase().charCodeAt(0);
  if (code < 65 || code > 90) return null;
  return String.fromCharCode(code - 64);
}

function sequenceForVirtualKey(key, mods) {
  if (key === 'ArrowUp') return csi('A', arrowModifierCode(mods));
  if (key === 'ArrowDown') return csi('B', arrowModifierCode(mods));
  if (key === 'ArrowRight') return csi('C', arrowModifierCode(mods));
  if (key === 'ArrowLeft') return csi('D', arrowModifierCode(mods));
  if (key === 'Home') return csi('H', arrowModifierCode(mods));
  if (key === 'End') return csi('F', arrowModifierCode(mods));
  if (key === 'Escape') return '\x1b';
  if (key === 'Enter') return '\r';
  if (key === 'Backspace') return '\x7f';
  if (key === 'Tab') {
    return mods.shift ? '\x1b[Z' : '\t';
  }
  if (key.length === 1) {
    if (mods.ctrl) return controlChar(key);
    const char = mods.shift ? key.toUpperCase() : key.toLowerCase();
    return mods.alt ? `\x1b${char}` : char;
  }
  return null;
}

function handleMobileKeybarPress(button) {
  if (!button) return;
  if (button === mobileSelectToggle) return;
  if (state.mobileKeybar.selectionMode) setMobileSelectionMode(false);
  const modifier = button.dataset.modifier;
  if (modifier) {
    state.mobileKeybar.modifiers[modifier] = !state.mobileKeybar.modifiers[modifier];
    syncModifierButtons();
    return;
  }

  const sequence = button.dataset.sequence;
  if (sequence) {
    sendTerminalKey(DIRECT_SEQUENCES[sequence]);
    clearModifierLatch();
    return;
  }

  const key = button.dataset.key;
  if (!key) return;
  if (handleVirtualTerminalKey(key)) {
    clearModifierLatch();
    return;
  }

  sendTerminalKey(sequenceForVirtualKey(key, state.mobileKeybar.modifiers));
  clearModifierLatch();
}

document.getElementById('mobile-nav-toggle').addEventListener('click', () => toggleMobileSidebar());
document.getElementById('mobile-nav-close').addEventListener('click', closeMobileSidebar);
document.getElementById('mobile-sidebar-backdrop').addEventListener('click', closeMobileSidebar);
mobileRefreshButton?.addEventListener('click', triggerFullRefresh);
mobileKeybarToggle?.addEventListener('click', () => setMobileKeybarOpen(!state.mobileKeybar.open));
mobileSelectToggle?.addEventListener('click', () => {
  setMobileSelectionMode(!state.mobileKeybar.selectionMode);
  if (!state.mobileKeybar.open) setMobileKeybarOpen(true);
});
mobileKeybar?.addEventListener('click', (event) => {
  handleMobileKeybarPress(event.target.closest('.mobile-key-btn'));
});
splitToggleButton?.addEventListener('click', toggleSplitLayout);
document.addEventListener('clideck:panel-switched', () => {
  if (mobileSidebarQuery.matches) closeMobileSidebar();
});
document.addEventListener('touchstart', (event) => {
  if (!canStartPullRefresh(event)) {
    resetPullRefreshState();
    return;
  }
  pullRefreshState.tracking = true;
  pullRefreshState.startY = event.touches[0].clientY;
  pullRefreshState.armed = false;
  mobileRefreshButton?.classList.remove('pull-armed');
}, { passive: true });
document.addEventListener('touchmove', (event) => {
  if (!pullRefreshState.tracking) return;
  const touch = event.touches?.[0];
  if (!touch) return;
  const delta = touch.clientY - pullRefreshState.startY;
  if (delta <= 0) {
    if (pullRefreshState.armed) {
      pullRefreshState.armed = false;
      mobileRefreshButton?.classList.remove('pull-armed');
    }
    return;
  }

  const armed = delta >= PULL_REFRESH_TRIGGER_PX;
  if (armed !== pullRefreshState.armed) {
    pullRefreshState.armed = armed;
    mobileRefreshButton?.classList.toggle('pull-armed', armed);
  }
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!pullRefreshState.tracking) return;
  const shouldRefresh = pullRefreshState.armed;
  resetPullRefreshState();
  if (shouldRefresh) triggerFullRefresh();
}, { passive: true });
document.addEventListener('touchcancel', resetPullRefreshState, { passive: true });
mobileSidebarQuery.addEventListener('change', (e) => {
  if (!e.matches) {
    resetPullRefreshState();
    closeMobileSidebar();
    setMobileKeybarOpen(false);
    setMobileSelectionMode(false);
    document.documentElement.style.setProperty('--mobile-kb-offset', '0px');
    document.body.classList.remove('mobile-keyboard-open');
    syncSplitToggleButton();
    fitVisibleTerminals({ force: true });
  } else {
    setWorkspaceLayout('single');
    syncMobileKeyboardViewport();
  }
});
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncMobileKeyboardViewport);
  window.visualViewport.addEventListener('scroll', syncMobileKeyboardViewport);
}
window.addEventListener('resize', () => requestAnimationFrame(syncMobileKeyboardViewport));
document.addEventListener('focusin', (event) => {
  if (!mobileSidebarQuery.matches) return;
  const isTerminalInput = event.target?.classList?.contains('xterm-helper-textarea');
  if (!isTerminalInput) return;
  closeMobileSidebar();
  setMobileKeybarOpen(false);
  setTimeout(() => {
    syncMobileKeyboardViewport();
    refreshActiveTerminalViewport();
  }, 20);
});
document.addEventListener('focusout', () => {
  if (!mobileSidebarQuery.matches) return;
  setTimeout(syncMobileKeyboardViewport, 80);
});

authForm.addEventListener('submit', submitAuthForm);
document.getElementById('rail-logout').addEventListener('click', logout);

// Sidebar events
const sessionList = document.getElementById('session-list');
sessionList.addEventListener('projects-rendered', () => renderProjectActions());

sessionList.addEventListener('click', (e) => {
  closeCreator();
  closeProjectCreator();

  // Project header click — toggle collapse (skip if just finished a drag)
  const projHeader = e.target.closest('.project-header');
  if (e.target.closest('.project-path-btn')) {
    const projId = e.target.closest('.project-header')?.dataset.projectId;
    if (projId) send({ type: 'project.openPath', id: projId });
    return;
  }
  if (e.target.closest('.plugin-project-btn')) return; // handled by btn's own click listener
  if (projHeader && !e.target.closest('.project-menu-btn') && !wasDragging()) {
    toggleProjectCollapse(projHeader.dataset.projectId);
    return;
  }
  // Project menu button
  if (e.target.closest('.project-menu-btn')) {
    const projId = e.target.closest('.project-group')?.dataset.projectId;
    if (projId) openProjectMenu(projId, e.target.closest('.project-menu-btn'));
    return;
  }

  // Previous sessions menu button
  if (e.target.closest('.prev-sessions-menu-btn')) {
    openPrevSessionsMenu(e.target.closest('.prev-sessions-menu-btn'));
    return;
  }

  // Resumable session click
  const resumableRow = e.target.closest('[data-resumable-id]');
  if (resumableRow) {
    send({ type: 'session.resume', id: resumableRow.dataset.resumableId });
    closeMobileSidebar();
    return;
  }

  // Pill row click — handled by pill's own listener
  if (e.target.closest('.pill-row')) return;

  const item = e.target.closest('.group');
  if (!item) return;

  if (state.layout.mode === 'split' && mobileSidebarQuery.matches) {
    setWorkspaceLayout('single');
  }

  // Menu button
  if (e.target.closest('.menu-btn')) {
    openMenu(item.dataset.id, e.target.closest('.menu-btn'));
    return;
  }

  select(item.dataset.id);
  closeMobileSidebar();
});

sessionList.addEventListener('dblclick', (e) => {
  const nameEl = e.target.closest('.name');
  if (nameEl) {
    const id = e.target.closest('.group[data-id]')?.dataset.id;
    if (id) startRename(id);
  }
  // Project name rename
  const projNameEl = e.target.closest('.project-name');
  if (projNameEl) {
    const projId = e.target.closest('.project-group')?.dataset.projectId;
    if (projId) startProjectRename(projId);
  }
});

// Session delete from context menu — always confirm
sessionList.addEventListener('session-delete', async (e) => {
  const id = e.detail.id;
  const ok = await confirmClose();
  if (!ok) return;
  send({ type: 'close', id });
});

// Mode toggle theme switch — dispatched from color-mode.js to avoid circular import
let modeToastQueued = false;
document.addEventListener('clideck-theme-switch', (e) => {
  setSessionTheme(e.detail.id, e.detail.themeId, { showBanner: false });
  if (!modeToastQueued) {
    modeToastQueued = true;
    queueMicrotask(() => {
      modeToastQueued = false;
      showModeToast();
    });
  }
});

function showModeToast() {
  showToast('If a terminal looks off, right-click the session and choose <strong class="text-slate-200">Refresh session</strong>.', {
    type: 'warn', duration: 4000, id: 'mode', html: true,
  });
}

document.getElementById('btn-new').addEventListener('click', () => {
  send({ type: 'checkAvailability' });
  openCreator();
});
document.getElementById('btn-new-project').addEventListener('click', () => {
  closeCreator();
  openProjectCreator();
});

// Search & filter toolbar
document.getElementById('search-input').addEventListener('input', (e) => {
  state.filter.query = e.target.value;
  applyFilter();
});
document.querySelectorAll('.filter-tab').forEach(btn => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});



// Telemetry setup notification — shown once per agent type
const shownSetup = new Set();
document.addEventListener('clideck:setup', (e) => showTelemetrySetup(e.detail.commandId, null));
function showTelemetrySetup(commandId, sessionId) {
  const cmd = state.cfg.commands.find(c => c.id === commandId);
  if (!cmd) return;
  // Skip if telemetry is already configured via settings
  if (cmd.telemetryEnabled && cmd.telemetryStatus?.ok) return;
  const preset = findPresetForCommand(cmd.command, state.presets, cmd.presetId);
  if (!preset) return;
  const setupRaw = preset.telemetrySetup || preset.pluginSetup;
  if (!setupRaw || shownSetup.has(preset.presetId)) return;
  shownSetup.add(preset.presetId);

  const port = location.port || '4000';
  const setupText = setupRaw.replace(/\{\{port\}\}/g, port);
  const [desc, ...codeParts] = setupText.split('\n\n');
  const code = codeParts.join('\n\n');
  const auto = preset.telemetryAutoSetup;
  const iconSrc = preset.icon?.startsWith('/') ? resolveIconPath(preset.icon) : null;
  const title = preset.bridge ? 'Bridge Plugin' : 'Status Tracking';

  const toast = document.createElement('div');
  toast.dataset.setupPreset = preset.presetId;
  if (sessionId) toast.dataset.sessionId = sessionId;
  toast.dataset.commandId = commandId;
  toast.className = 'fixed bottom-5 left-4 right-4 sm:left-auto sm:right-5 sm:w-auto z-[500] w-full max-w-[360px] bg-slate-800/95 backdrop-blur-sm border border-slate-700/60 rounded-xl shadow-2xl shadow-black/60';
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(12px)';
  toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';

  toast.innerHTML = `
    <div class="flex items-center gap-2.5 px-4 pt-3.5 pb-1">
      ${iconSrc ? `<img src="${esc(iconSrc)}" class="w-5 h-5 object-contain flex-shrink-0">` : ''}
      <span class="text-[13px] font-semibold text-slate-200">${esc(preset.name)} — ${title}</span>
      <button class="dismiss-btn ml-auto w-6 h-6 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <p class="px-4 pt-1 pb-2.5 text-xs text-slate-400 leading-relaxed">${esc(desc)}</p>
    ${code ? `<div class="mx-4 mb-3 px-3 py-2.5 bg-slate-900/70 rounded-lg border border-slate-700/40">
      <pre class="text-[11px] text-emerald-400/80 font-mono leading-relaxed whitespace-pre-wrap">${esc(code)}</pre>
    </div>` : ''}
    <div class="setup-actions px-4 pb-3.5 flex items-center gap-2">
      ${auto ? `<button class="auto-setup-btn flex-1 px-3 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
        ${esc(auto.label)}
      </button>` : ''}
      <button class="dismiss-btn px-3 py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">Dismiss</button>
    </div>`;

  toast.querySelectorAll('.dismiss-btn').forEach(b => b.onclick = () => {
    shownSetup.delete(preset.presetId);
    toast.remove();
  });

  const autoBtn = toast.querySelector('.auto-setup-btn');
  if (autoBtn) {
    autoBtn.onclick = () => {
      autoBtn.disabled = true;
      autoBtn.innerHTML = `<svg class="w-3.5 h-3.5 inline animate-spin -mt-px mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2a10 10 0 0 1 10 10"/></svg>Configuring…`;
      autoBtn.className = 'auto-setup-btn flex-1 px-3 py-2 text-xs font-medium bg-slate-700 text-slate-300 rounded-lg cursor-wait';
      send({ type: 'telemetry.autosetup', presetId: preset.presetId });
    };
  }

  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });
}

// --- Project context menu ---
let projectMenuCleanup = null;

function resumeDormantSessions(ids, label) {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return;
  showToast(`Starting ${uniqueIds.length} dormant session${uniqueIds.length > 1 ? 's' : ''}${label ? ` from ${label}` : ''}…`, { duration: 3000 });
  uniqueIds.forEach((id, index) => {
    setTimeout(() => {
      if (state.resumable.some(s => s.id === id)) send({ type: 'session.resume', id });
    }, index * 1000);
  });
}

function openProjectMenu(projectId, anchorEl) {
  if (projectMenuCleanup) projectMenuCleanup();
  const proj = (state.cfg.projects || []).find(p => p.id === projectId);
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'fixed z-[400] min-w-[160px] bg-slate-800 border border-slate-700 rounded-lg shadow-xl shadow-black/40 py-1';
  // Count dormant (resumable) sessions in this project
  const dormantIds = state.resumable.filter(s => s.projectId === projectId).map(s => s.id);
  const hasDormant = dormantIds.length > 0;

  menu.innerHTML = `
    <div class="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Color</div>
    <div class="px-3 pb-2 flex gap-1.5">
      ${PROJECT_COLORS.map(c => `
        <button class="color-pick w-5 h-5 rounded-full transition-transform hover:scale-125 ${proj?.color === c ? 'ring-2 ring-white/40 scale-110' : ''}" data-color="${c}" style="background:${c}"></button>
      `).join('')}
    </div>
    <div class="border-t border-slate-700/50 my-1"></div>
    <button class="pm-action flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="rename">
      <svg class="w-4 h-4 flex-shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      Rename
    </button>
    <button class="pm-action flex items-center gap-2 w-full px-3 py-2 text-sm ${hasDormant ? 'text-slate-300 hover:bg-slate-700 cursor-pointer' : 'text-slate-600 cursor-default'} transition-colors text-left" data-action="start-dormant" ${hasDormant ? '' : 'disabled'}>
      <svg class="w-4 h-4 flex-shrink-0 ${hasDormant ? 'text-slate-400' : 'text-slate-600'}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="7 5 19 12 7 19 7 5"/></svg>
      Start all dormant sessions
    </button>
    <button class="pm-action flex items-center gap-2 w-full px-3 py-2 text-sm ${hasDormant ? 'text-slate-300 hover:bg-slate-700 cursor-pointer' : 'text-slate-600 cursor-default'} transition-colors text-left" data-action="clear-dormant" ${hasDormant ? '' : 'disabled'}>
      <svg class="w-4 h-4 flex-shrink-0 ${hasDormant ? 'text-slate-400' : 'text-slate-600'}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>
      Clear dormant sessions
    </button>
    <button class="pm-action flex items-center gap-2 w-full px-3 py-2 text-sm text-red-400 hover:bg-slate-700 transition-colors text-left" data-action="delete">
      <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      Delete project
    </button>`;
  positionMenu(menu, rect);
  const onClick = (e) => {
    // Color pick
    const colorBtn = e.target.closest('.color-pick');
    if (colorBtn && proj) {
      proj.color = colorBtn.dataset.color;
      send({ type: 'config.update', config: state.cfg });
      regroupSessions();
      if (projectMenuCleanup) projectMenuCleanup();
      return;
    }
    const btn = e.target.closest('.pm-action');
    if (!btn) return;
    if (projectMenuCleanup) projectMenuCleanup();
    if (btn.dataset.action === 'rename') {
      startProjectRename(projectId);
      return;
    }
    if (btn.dataset.action === 'start-dormant') {
      const ids = [...document.querySelectorAll(`.project-group[data-project-id="${projectId}"] .project-sessions [data-resumable-id]`)]
        .map(el => el.dataset.resumableId);
      if (!ids.length) return;
      resumeDormantSessions(ids, `"${proj?.name || 'project'}"`);
      return;
    }
    if (btn.dataset.action === 'clear-dormant') {
      const ids = state.resumable.filter(s => s.projectId === projectId).map(s => s.id);
      if (!ids.length) return;
      confirmClose(`Clear ${ids.length} dormant session${ids.length > 1 ? 's' : ''} from "${proj?.name}"?`, 'Clear').then(ok => {
        if (ok) for (const id of ids) send({ type: 'close', id });
      });
      return;
    }
    if (btn.dataset.action === 'delete') {
      const count = [...state.terms.values()].filter(e => e.projectId === projectId).length;
      const msg = count
        ? `Delete project "${proj?.name}"? This will close ${count} active session${count > 1 ? 's' : ''}.`
        : `Delete project "${proj?.name}"?`;
      confirmClose(msg, 'Delete').then(ok => {
        if (ok) send({ type: 'project.delete', id: projectId });
      });
    }
  };
  const onOutside = (e) => { if (!menu.contains(e.target)) { if (projectMenuCleanup) projectMenuCleanup(); } };
  menu.addEventListener('click', onClick);
  requestAnimationFrame(() => document.addEventListener('click', onOutside));
  projectMenuCleanup = () => {
    menu.removeEventListener('click', onClick);
    document.removeEventListener('click', onOutside);
    menu.remove();
    projectMenuCleanup = null;
  };
}

// --- Previous Sessions menu ---
let prevMenuCleanup = null;
function openPrevSessionsMenu(anchorEl) {
  if (prevMenuCleanup) prevMenuCleanup();
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'fixed z-[400] min-w-[160px] bg-slate-800 border border-slate-700 rounded-lg shadow-xl shadow-black/40 py-1';

  // Clear exactly the dormant sessions currently rendered in "Previous Sessions".
  // This keeps the action aligned with the UI even if a session has a stale projectId
  // that no longer resolves to a real project group.
  const dormantIds = [...document.querySelectorAll('#resumable-section [data-resumable-id]')]
    .map(el => el.dataset.resumableId)
    .filter(Boolean);

  menu.innerHTML = `
    <button class="pv-action flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="clear-dormant">
      <svg class="w-4 h-4 flex-shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>
      Clear dormant sessions
    </button>`;
  positionMenu(menu, rect);
  const onClick = (e) => {
    const btn = e.target.closest('.pv-action');
    if (!btn) return;
    if (prevMenuCleanup) prevMenuCleanup();
    confirmClose(`Clear ${dormantIds.length} dormant session${dormantIds.length > 1 ? 's' : ''}?`, 'Clear').then(ok => {
      if (ok) for (const id of dormantIds) send({ type: 'close', id });
    });
  };
  const onOutside = (e) => { if (!menu.contains(e.target)) { if (prevMenuCleanup) prevMenuCleanup(); } };
  menu.addEventListener('click', onClick);
  requestAnimationFrame(() => document.addEventListener('click', onOutside));
  prevMenuCleanup = () => {
    menu.removeEventListener('click', onClick);
    document.removeEventListener('click', onOutside);
    menu.remove();
    prevMenuCleanup = null;
  };
}

// --- Project creator ---
const PROJECT_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#84cc16'];
const FOLDER_SVG = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

function closeProjectCreator() {
  document.getElementById('project-creator')?.remove();
}

function openProjectCreator() {
  if (document.getElementById('project-creator')) { closeProjectCreator(); return; }
  // Close session creator if open
  closeCreator();

  const defaultPath = state.cfg.defaultPath || '';

  const card = document.createElement('div');
  card.id = 'project-creator';
  card.className = 'p-3 border-b border-slate-700/50 bg-slate-800/30';
  card.innerHTML = `
    <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Project folder</div>
    <div class="flex items-center gap-1.5 mb-2">
      <input id="pc-path" type="text" value="${esc(defaultPath)}" placeholder="Project folder path"
        class="flex-1 px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-400 placeholder-slate-600 outline-none focus:border-blue-500 transition-colors font-mono">
      <button id="pc-browse" class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md border border-slate-700 text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors" title="Browse">
        ${FOLDER_SVG}
      </button>
    </div>
    <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
      Project name <span class="text-slate-600 font-medium normal-case tracking-normal">(auto-filled from folder name)</span>
    </div>
    <input id="pc-name" type="text" maxlength="35" placeholder="Project name"
      class="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors mb-2">
    <div class="flex items-center gap-2">
      <button id="pc-create" class="px-4 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors">Create</button>
      <button id="pc-cancel" class="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors">Cancel</button>
    </div>`;

  const list = document.getElementById('session-list');
  list.parentElement.insertBefore(card, list);

  const nameInput = card.querySelector('#pc-name');
  const pathInput = card.querySelector('#pc-path');
  pathInput.focus();

  // Auto-fill project name from last folder in path
  const autoFillName = () => {
    const path = pathInput.value.trim();
    if (!path) return;
    const lastFolder = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (lastFolder && !nameInput.dataset.userEdited) {
      nameInput.value = lastFolder;
    }
  };
  pathInput.addEventListener('input', autoFillName);
  pathInput.addEventListener('change', autoFillName);
  nameInput.addEventListener('input', () => { nameInput.dataset.userEdited = '1'; });

  const doCreate = () => {
    const path = pathInput.value.trim();
    const lastFolder = path ? path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
    const name = nameInput.value.trim() || lastFolder;
    if (!name) { nameInput.focus(); return; }
    const projects = state.cfg.projects || [];
    projects.push({
      id: crypto.randomUUID(),
      name,
      path: path || undefined,
      color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length],
      collapsed: false,
    });
    state.cfg.projects = projects;
    closeProjectCreator();
    regroupSessions();
    send({ type: 'config.update', config: state.cfg });
  };

  card.querySelector('#pc-create').addEventListener('click', doCreate);
  card.querySelector('#pc-cancel').addEventListener('click', closeProjectCreator);
  card.querySelector('#pc-browse').addEventListener('click', () => {
    openFolderPicker(pathInput.value.trim() || defaultPath, (path) => {
      pathInput.value = path;
      autoFillName();
    });
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreate();
    if (e.key === 'Escape') closeProjectCreator();
  });
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreate();
    if (e.key === 'Escape') closeProjectCreator();
  });
}

document.getElementById('btn-theme-toggle').addEventListener('click', toggleMode);

// --- Plugin system (frontend) ---

const pluginMessageHandlers = new Map();
const loadedPlugins = new Set();

function dispatchPluginMessage(msg) {
  const fn = pluginMessageHandlers.get(msg.type);
  if (fn) {
    try { fn(msg); }
    catch (e) { console.error(`[plugin] client handler error for ${msg.type}:`, e); }
  }
}

function addPluginToolbarButton(pluginId, opts) {
  const toolbar = document.getElementById('plugin-toolbar');
  const btn = document.createElement('button');
  btn.className = 'plugin-btn w-8 h-8 flex items-center justify-center rounded-lg bg-slate-800/80 border border-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors backdrop-blur-sm';
  btn.title = opts.title || '';
  btn.innerHTML = opts.icon || '';
  btn.dataset.pluginId = pluginId;
  if (opts.id) btn.dataset.actionId = opts.id;
  btn.addEventListener('click', () => {
    if (typeof opts.onClick === 'function') opts.onClick();
  });
  toolbar.appendChild(btn);
  return btn;
}

function getPluginExpanded() {
  try { return JSON.parse(localStorage.getItem('clideck.pluginsExpanded') || '{}'); } catch { return {}; }
}
function setPluginExpanded(id, open) {
  const map = getPluginExpanded();
  if (open) map[id] = true; else delete map[id];
  localStorage.setItem('clideck.pluginsExpanded', JSON.stringify(map));
}

function renderPluginsPanel(list) {
  const container = document.getElementById('plugins-list');
  if (!list.length) {
    container.innerHTML = `<div class="flex flex-col items-center justify-center h-full px-6 text-center">
      <p class="text-sm text-slate-400 mb-1">No plugins installed</p>
      <p class="text-xs text-slate-600 leading-relaxed">Plugins live in <code class="px-1 py-0.5 rounded bg-slate-800 text-slate-400 text-[11px]">${esc(state.cfg.pluginsDir || '~/.clideck/plugins')}</code><br>Each one is a folder with a <code class="px-1 py-0.5 rounded bg-slate-800 text-slate-400 text-[11px]">clideck-plugin.json</code> and <code class="px-1 py-0.5 rounded bg-slate-800 text-slate-400 text-[11px]">index.js</code></p>
    </div>`;
    return;
  }
  const expanded = getPluginExpanded();
  const trashSvg = `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>`;
  const defaultIcon = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v2m6.36 1.64l-1.42 1.42M21 12h-2M17.94 17.94l-1.42-1.42M12 19v2M6.06 17.94l1.42-1.42M3 12h2M6.06 6.06l1.42 1.42"/><circle cx="12" cy="12" r="4"/></svg>`;

  container.innerHTML = list.map((p, i) => {
    const open = !!expanded[p.id];
    const icon = p.icon || defaultIcon;
    const deleteBtn = p.bundled ? '' : `<div class="plugin-delete flex items-center justify-center w-6 h-6 rounded text-slate-600 hover:text-red-400 hover:bg-slate-700/50 cursor-pointer transition-colors flex-shrink-0" data-plugin-id="${esc(p.id)}" data-plugin-name="${esc(p.name)}" title="Remove plugin">${trashSvg}</div>`;
    const hasFooter = p.author || !p.bundled;

    if (!p.installed) {
      return `
      <div class="plugin-card ${i > 0 ? 'border-t border-slate-700/50' : ''}">
        <div class="px-4 py-3">
          <div class="flex items-center gap-2">
            <span class="text-slate-500 flex-shrink-0">${icon}</span>
            <span class="flex-1 text-sm font-medium text-slate-400 truncate">${esc(p.name)}</span>
            <span class="text-[10px] text-slate-600 flex-shrink-0">v${esc(p.version)}</span>
            <button class="plugin-install-btn px-2.5 py-1 text-[11px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors flex-shrink-0" data-plugin-id="${esc(p.id)}">Install</button>
          </div>
          ${p.description ? `<p class="text-[11px] text-slate-600 mt-0.5 leading-snug">${esc(p.description)}</p>` : ''}
        </div>
      </div>`;
    }

    return `
    <div class="plugin-card ${i > 0 ? 'border-t border-slate-700/50' : ''}">
      <div class="plugin-toggle px-4 py-3 hover:bg-slate-800/50 transition-colors cursor-pointer" data-plugin-id="${esc(p.id)}">
        <div class="flex items-center gap-2">
          <span class="text-slate-400 flex-shrink-0">${icon}</span>
          <span class="flex-1 text-sm font-medium text-slate-200 truncate">${esc(p.name)}</span>
          <span class="text-[10px] text-slate-500 flex-shrink-0">v${esc(p.version)}</span>
          <svg class="plugin-chevron w-4 h-4 text-slate-500 transition-transform duration-200 flex-shrink-0 ${open ? '' : 'collapsed'}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M19 9l-7 7-7-7"/></svg>
        </div>
        ${p.description ? `<p class="text-[11px] text-slate-500 mt-0.5 leading-snug">${esc(p.description)}</p>` : ''}
        ${hasFooter ? `<div class="flex items-center justify-end gap-2 mt-1">${p.author ? `<span class="text-[10px] text-slate-600">${esc(p.author)}</span>` : ''}${deleteBtn}</div>` : ''}
      </div>
      <div class="plugin-body ${open ? '' : 'hidden'}">
        <div class="px-4 pb-3">
          ${(p.settings || []).map(s => renderSettingField(p.id, s, p.settingValues[s.key] ?? s.default, p.dynamicOptions)).join('')}
        </div>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.plugin-toggle').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.plugin-delete')) return;
      const id = el.dataset.pluginId;
      const card = el.closest('.plugin-card');
      const body = card.querySelector('.plugin-body');
      const chevron = card.querySelector('.plugin-chevron');
      if (!body) return;
      const nowHidden = body.classList.toggle('hidden');
      chevron.classList.toggle('collapsed', nowHidden);
      setPluginExpanded(id, !nowHidden);
    });
  });

  container.querySelectorAll('.plugin-delete').forEach(el => {
    el.addEventListener('click', async () => {
      const pluginId = el.dataset.pluginId;
      const name = el.dataset.pluginName;
      const ok = await confirmClose(`Remove plugin "${name}"? Its folder will be permanently deleted.`, 'Remove');
      if (ok) send({ type: 'plugin.delete', pluginId });
    });
  });

  container.querySelectorAll('.plugin-install-btn').forEach(el => {
    el.addEventListener('click', () => {
      el.disabled = true;
      el.textContent = 'Installing...';
      el.className = el.className.replace('bg-blue-600 hover:bg-blue-500', 'bg-slate-700 cursor-wait');
      send({ type: 'plugin.install', pluginId: el.dataset.pluginId });
    });
  });

  container.querySelectorAll('[data-setting]').forEach(el => {
    const pluginId = el.dataset.plugin;
    const key = el.dataset.setting;
    const onChange = (value) => send({ type: 'plugin.settings.update', pluginId, key, value });
    if (el.type === 'checkbox') el.addEventListener('change', () => onChange(el.checked));
    else if (el.tagName === 'SELECT') el.addEventListener('change', () => onChange(el.value));
    else if (el.type === 'number') el.addEventListener('change', () => onChange(Number(el.value)));
    else el.addEventListener('change', () => onChange(el.value));
  });
}

function renderSettingField(pluginId, setting, value, dynamicOptions) {
  const id = `ps-${pluginId}-${setting.key}`;
  const attrs = `data-plugin="${esc(pluginId)}" data-setting="${esc(setting.key)}"`;
  const label = esc(setting.label || setting.key);
  const desc = setting.description ? `<p class="text-[11px] text-slate-600 mt-0.5">${esc(setting.description)}</p>` : '';

  if (setting.type === 'toggle') {
    return `<label class="flex items-center gap-2 mt-2 cursor-pointer">
      <input type="checkbox" id="${id}" ${attrs} ${value ? 'checked' : ''} class="accent-blue-500">
      <span class="text-xs text-slate-400">${label}</span>
    </label>${desc}`;
  }
  if (setting.type === 'select' || setting.type === 'dynamic-select') {
    const source = setting.type === 'dynamic-select' ? (dynamicOptions?.[setting.key] || []) : (setting.options || []);
    let opts = source.map(o => {
      const optVal = typeof o === 'object' ? o.value : o;
      const optLabel = typeof o === 'object' ? o.label : o;
      return `<option value="${esc(String(optVal))}" ${String(value) === String(optVal) ? 'selected' : ''}>${esc(String(optLabel))}</option>`;
    }).join('');
    // Dynamic-select with no options yet: show the saved value so the control isn't blank
    if (setting.type === 'dynamic-select' && !source.length && value) {
      opts = `<option value="${esc(String(value))}" selected>${esc(String(value))}</option>`;
    }
    return `<div class="mt-2">
      <label class="block text-xs text-slate-400 mb-1">${label}</label>
      <select id="${id}" ${attrs} class="w-full px-2 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded-md text-slate-200 outline-none focus:border-blue-500 transition-colors">${opts}</select>
      ${desc}
    </div>`;
  }
  if (setting.type === 'number') {
    const min = setting.min != null ? `min="${setting.min}"` : '';
    const max = setting.max != null ? `max="${setting.max}"` : '';
    return `<div class="mt-2">
      <label class="block text-xs text-slate-400 mb-1">${label}</label>
      <input type="number" id="${id}" ${attrs} value="${value ?? ''}" ${min} ${max} class="w-full px-2 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded-md text-slate-200 outline-none focus:border-blue-500 transition-colors">
      ${desc}
    </div>`;
  }
  // Default: text
  return `<div class="mt-2">
    <label class="block text-xs text-slate-400 mb-1">${label}</label>
    <input type="text" id="${id}" ${attrs} value="${esc(String(value ?? ''))}" ${setting.placeholder ? `placeholder="${esc(setting.placeholder)}"` : ''} class="w-full px-2 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded-md text-slate-200 placeholder-slate-600 outline-none focus:border-blue-500 transition-colors">
    ${desc}
  </div>`;
}

async function loadPlugins(list) {
  const activeIds = new Set(list.map(p => p.id));

  // Clean up removed plugins: hotkeys, toolbar buttons, message handlers
  for (const id of loadedPlugins) {
    if (!activeIds.has(id)) {
      unregisterAllForPlugin(id);
      for (const [key] of pluginMessageHandlers) {
        if (key.startsWith(`plugin.${id}.`)) pluginMessageHandlers.delete(key);
      }
      loadedPlugins.delete(id);
    }
  }

  renderPluginsPanel(list);

  // Store project-header actions from plugins (used by regroupSessions to render icons)
  state.projectActions = [];
  for (const plugin of list) {
    for (const action of plugin.actions || []) {
      if (action.slot === 'project-header') state.projectActions.push({ ...action, pluginId: plugin.id });
    }
  }
  renderProjectActions();

  // Render server-registered toolbar actions — also clears stale client toolbar buttons
  const toolbar = document.getElementById('plugin-toolbar');
  toolbar.querySelectorAll('.plugin-btn').forEach(b => {
    if (!activeIds.has(b.dataset.pluginId)) b.remove();
  });
  toolbar.querySelectorAll('.plugin-btn[data-server]').forEach(b => b.remove());
  for (const plugin of list) {
    for (const action of plugin.actions || []) {
      if (action.slot !== 'toolbar') continue;
      const btn = document.createElement('button');
      btn.className = 'plugin-btn w-8 h-8 flex items-center justify-center rounded-lg bg-slate-800/80 border border-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors backdrop-blur-sm';
      btn.title = action.title || '';
      btn.innerHTML = action.icon || '';
      btn.dataset.pluginId = plugin.id;
      btn.dataset.server = '1';
      btn.addEventListener('click', () => {
        send({ type: `plugin.${plugin.id}.${action.id}`, action: action.id });
      });
      toolbar.appendChild(btn);
    }
  }

  // Load client-side plugins
  for (const plugin of list) {
    if (!plugin.hasClient || loadedPlugins.has(plugin.id)) continue;
    loadedPlugins.add(plugin.id);
    try {
      const mod = await import(`/plugins/${plugin.id}/client.js`);
      if (typeof mod.init === 'function') {
        mod.init({
          pluginId: plugin.id,
          send(event, data = {}) { send({ ...data, type: `plugin.${plugin.id}.${event}` }); },
          onMessage(event, fn) { pluginMessageHandlers.set(`plugin.${plugin.id}.${event}`, fn); },
          addToolbarButton(opts) { return addPluginToolbarButton(plugin.id, opts); },
          getActiveSessionId() { return state.active; },
          getTerminalSelection() { const e = state.terms.get(state.active); return e ? e.term.getSelection() : ''; },
          writeToSession(id, text) { send({ type: 'input', id, data: text }); },
          toast(message, opts) { return showToast(message, opts); },
          registerHotkey(combo, callback) { return registerHotkey(plugin.id, combo, callback); },
          unregisterHotkey(combo) { unregisterHotkey(plugin.id, combo); },
        });
      }
    } catch (e) { console.error(`[plugin:${plugin.id}] client load failed:`, e); }
  }
}

// Render plugin-registered project header action buttons into all project groups
function renderProjectActions() {
  const actions = state.projectActions || [];
  for (const slot of document.querySelectorAll('.project-plugin-actions')) {
    slot.innerHTML = '';
    const projId = slot.closest('.project-header')?.dataset.projectId;
    if (!projId) continue;
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.className = 'project-plugin-action plugin-project-btn text-slate-600 hover:text-indigo-400 flex-shrink-0 p-0.5';
      btn.title = action.title || '';
      btn.innerHTML = action.icon || '';
      btn.dataset.pluginId = action.pluginId;
      btn.dataset.actionId = action.id;
      btn.dataset.projectId = projId;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        send({ type: `plugin.${action.pluginId}.${action.id}`, action: action.id, projectId: projId });
      });
      slot.appendChild(btn);
    }
  }
}

let saveTimer = null;
function flashSaveIndicator() {
  const el = document.getElementById('save-indicator');
  if (!el) return;
  clearTimeout(saveTimer);
  el.classList.add('saving');
  el.classList.remove('saved');
  saveTimer = setTimeout(() => {
    el.classList.remove('saving');
    el.classList.add('saved');
    saveTimer = setTimeout(() => el.classList.remove('saved'), 4000);
  }, 1500);
}

function initSessionScrollbarVisibility() {
  const el = document.getElementById('session-list');
  if (!el) return;
  let t;
  el.addEventListener('scroll', () => {
    el.classList.add('is-scrolling');
    clearTimeout(t);
    t = setTimeout(() => el.classList.remove('is-scrolling'), 220);
  }, { passive: true });
}

// --- Remote (thin connector to clideck-remote CLI) ---

const remoteModal = document.getElementById('remote-modal');
const remotePanes = {
  intro: document.getElementById('remote-intro'),
  installing: document.getElementById('remote-installing'),
  connecting: document.getElementById('remote-connecting'),
  qr: document.getElementById('remote-qr'),
  active: document.getElementById('remote-active'),
  error: document.getElementById('remote-error'),
};
const btnRemote = document.getElementById('btn-remote');

let remoteInstalled = false;
let remoteState = 'idle'; // idle | connecting | waiting | paired
let remoteModalOpen = false;
let remoteStatusPoll = null;
let remoteConnectedAt = null;
let remoteStatsTimer = null;
let remoteUpdateInfo = null;
let remotePreflight = null;
let remoteLastStatus = null;

function startRemotePoll() {
  stopRemotePoll();
  remoteStatusPoll = setInterval(() => {
    if (remoteState === 'waiting' || remoteState === 'paired') send({ type: 'remote.status' });
    else stopRemotePoll();
  }, 3000);
}

function stopRemotePoll() {
  if (remoteStatusPoll) { clearInterval(remoteStatusPoll); remoteStatusPoll = null; }
}

function setRemotePane(pane) {
  for (const [k, el] of Object.entries(remotePanes)) {
    el.classList.toggle('hidden', k !== pane);
  }
}

function showRemoteIntro(opts = {}) {
  const title = document.getElementById('remote-intro-title');
  const text = document.getElementById('remote-intro-text');
  const foot = document.getElementById('remote-intro-foot');
  const btn = document.getElementById('remote-add');
  title.textContent = opts.title || 'CliDeck Mobile Remote';
  text.textContent = opts.text || 'Control your AI agents from your phone. See live status, send messages, and get notifications — all end-to-end encrypted.';
  foot.innerHTML = opts.foot || 'Installs the <code class="text-slate-500">clideck-remote</code> package via npm';
  btn.textContent = opts.button || 'Add to CliDeck';
  setRemotePane('intro');
}

function showRemoteUpdateRequired() {
  showRemoteIntro({
    title: 'Update Required',
    text: `Version ${remoteUpdateInfo.latest} is available. Update CliDeck Remote to continue with mobile pairing on this machine.`,
    foot: `Installed: <code class="text-slate-500">${esc(remoteUpdateInfo.installed)}</code> · Latest: <code class="text-slate-500">${esc(remoteUpdateInfo.latest)}</code>`,
    button: 'Update to Continue',
  });
}

function finishRemotePreflight() {
  if (!remotePreflight?.pending || !remotePreflight.statusSeen || !remotePreflight.updateSeen) return;
  remotePreflight = null;
  if (!remoteInstalled) {
    showRemoteIntro();
    return;
  }
  if (remoteUpdateInfo?.available) {
    showRemoteUpdateRequired();
    return;
  }
  if (remoteState === 'idle') {
    remoteState = 'connecting';
    setRemotePane('connecting');
    send({ type: 'remote.pair' });
    return;
  }
  if (remoteState === 'paired' && remoteLastStatus?.paired) {
    setRemotePane('active');
    setRemoteLock(true);
    startRemoteStats(remoteLastStatus.pairedAt);
    const deviceEl = document.getElementById('remote-device-info');
    if (deviceEl) {
      const parts = [remoteLastStatus.deviceName, remoteLastStatus.location].filter(Boolean);
      deviceEl.textContent = parts.length ? parts.join(' · ') : '';
    }
    return;
  }
  if (remoteState === 'waiting' && remoteLastStatus?.connected && remoteLastStatus?.url) {
    document.getElementById('remote-url-box').textContent = remoteLastStatus.url;
    const qrImg = document.getElementById('remote-qr-img');
    if (remoteLastStatus.qr && remoteLastStatus.qr.startsWith('data:')) { qrImg.src = remoteLastStatus.qr; qrImg.classList.remove('hidden'); }
    else qrImg.classList.add('hidden');
    setRemotePane('qr');
    return;
  }
  setRemotePane(remoteState === 'paired' ? 'active' : remoteState === 'waiting' ? 'qr' : 'connecting');
}

function openRemoteModal() {
  remoteModalOpen = true;
  remoteModal.classList.remove('hidden');
  remoteModal.style.display = 'flex';
}

function closeRemoteModal() {
  if (remoteState === 'paired') return; // can't dismiss while connected
  remoteModalOpen = false;
  remoteModal.classList.add('hidden');
  remoteModal.style.display = '';
  setRemoteLock(false);
}

let remoteLocked = false;

function remoteLockKeyTrap(e) {
  // Only allow Tab within the modal and the Disconnect button
  const modal = document.getElementById('remote-modal');
  if (modal && modal.contains(e.target)) return;
  e.stopPropagation();
  e.preventDefault();
}

function setRemoteLock(locked) {
  remoteLocked = locked;
  const modal = document.getElementById('remote-modal');
  const closeBtn = document.getElementById('remote-close');
  if (locked) {
    modal.style.backdropFilter = 'blur(24px)';
    modal.style.webkitBackdropFilter = 'blur(24px)';
    modal.style.background = 'rgba(0,0,0,0.75)';
    closeBtn.classList.add('hidden');
    // Blur any focused terminal/element and trap keyboard
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    window.addEventListener('keydown', remoteLockKeyTrap, true);
    window.addEventListener('keypress', remoteLockKeyTrap, true);
    window.addEventListener('keyup', remoteLockKeyTrap, true);
    // Focus the disconnect button so keyboard focus is inside the modal
    const disconnectBtn = document.getElementById('remote-disconnect2');
    if (disconnectBtn) disconnectBtn.focus();
  } else {
    modal.style.backdropFilter = '';
    modal.style.webkitBackdropFilter = '';
    modal.style.background = '';
    closeBtn.classList.remove('hidden');
    window.removeEventListener('keydown', remoteLockKeyTrap, true);
    window.removeEventListener('keypress', remoteLockKeyTrap, true);
    window.removeEventListener('keyup', remoteLockKeyTrap, true);
  }
}

function startRemoteStats(pairedAt) {
  if (remoteStatsTimer) { clearInterval(remoteStatsTimer); remoteStatsTimer = null; }
  remoteConnectedAt = pairedAt || Date.now();
  updateRemoteStats();
  remoteStatsTimer = setInterval(updateRemoteStats, 1000);
}

function stopRemoteStats() {
  if (remoteStatsTimer) { clearInterval(remoteStatsTimer); remoteStatsTimer = null; }
  remoteConnectedAt = null;
}

function updateRemoteStats() {
  if (!remoteConnectedAt) return;
  const elapsed = Math.floor((Date.now() - remoteConnectedAt) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  const h = Math.floor(m / 60);
  const timeStr = h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  const el = document.getElementById('remote-stat-time');
  if (el) el.textContent = timeStr;
  const sessEl = document.getElementById('remote-stat-sessions');
  if (sessEl) sessEl.textContent = document.querySelectorAll('.group[data-id]').length || '0';
}

function updateRemoteButton() {
  btnRemote.classList.toggle('text-blue-400', remoteState === 'waiting');
  btnRemote.classList.toggle('text-emerald-400', remoteState === 'paired');
  if (remoteState === 'idle' || remoteState === 'connecting') {
    btnRemote.classList.remove('text-blue-400', 'text-emerald-400');
  }
}

function handleRemoteStatus(msg) {
  remoteLastStatus = msg;
  remoteInstalled = !!msg.installed;
  state.remoteVersion = msg.version || (msg.installed ? null : 'not installed');
  updateVersionFooter();
  const wasPaired = remoteState === 'paired';
  const preflighting = !!remotePreflight?.pending;
  if (!msg.installed) {
    remoteState = 'idle';
    stopRemotePoll();
    if (wasPaired) { stopRemoteStats(); setRemoteLock(false); }
  } else if (msg.paired) {
    const wasFresh = remoteState !== 'paired';
    remoteState = 'paired';
    if (!remoteStatusPoll) startRemotePoll();
    if (wasFresh && !preflighting) {

      setRemotePane('active');
      setRemoteLock(true);
      startRemoteStats(msg.pairedAt);
      if (!remoteModalOpen) openRemoteModal();
    }
    const deviceEl = document.getElementById('remote-device-info');
    if (deviceEl) {
      const parts = [msg.deviceName, msg.location].filter(Boolean);
      deviceEl.textContent = parts.length ? parts.join(' \u00b7 ') : '';
    }
  } else if (msg.connected && msg.url) {
    remoteState = 'waiting';
    if (wasPaired) { stopRemoteStats(); setRemoteLock(false); }
    document.getElementById('remote-url-box').textContent = msg.url;
    const qrImg = document.getElementById('remote-qr-img');
    if (msg.qr && msg.qr.startsWith('data:')) { qrImg.src = msg.qr; qrImg.classList.remove('hidden'); }
    else qrImg.classList.add('hidden');
    startRemotePoll();
    if (!preflighting && remoteModalOpen) setRemotePane('qr');
  } else {
    remoteState = 'idle';
    stopRemotePoll();
    if (wasPaired) { stopRemoteStats(); setRemoteLock(false); }
  }
  if (remoteUpdateInfo?.available && remoteModalOpen) {
    showRemoteUpdateRequired();
  }
  updateRemoteButton();
  if (remotePreflight?.pending) {
    remotePreflight.statusSeen = true;
    finishRemotePreflight();
  }
}

function handleRemotePaired(msg) {
  remoteInstalled = true;
  remoteState = 'waiting';
  document.getElementById('remote-url-box').textContent = msg.url || '';
  const qrImg = document.getElementById('remote-qr-img');
  if (msg.qr && msg.qr.startsWith('data:')) { qrImg.src = msg.qr; qrImg.classList.remove('hidden'); }
  else qrImg.classList.add('hidden');
  updateRemoteButton();
  startRemotePoll();
  if (remoteUpdateInfo?.available && remoteModalOpen) {
    showRemoteUpdateRequired();
    return;
  }
  if (remotePreflight?.pending) {
    remotePreflight.statusSeen = true;
    finishRemotePreflight();
    return;
  }
  setRemotePane('qr');
}

function handleRemoteUnpaired() {
  remoteState = 'idle';
  stopRemotePoll();
  stopRemoteStats();
  setRemoteLock(false);
  closeRemoteModal();
  updateRemoteButton();
}

function handleRemoteError(error) {
  document.getElementById('remote-error-text').textContent = error || 'Unknown error';
  setRemotePane('error');
  remoteState = 'idle';
  stopRemotePoll();
  updateRemoteButton();
}

function appendInstallLog(text) {
  const log = document.getElementById('remote-install-log');
  log.textContent += text;
  log.scrollTop = log.scrollHeight;
}

function handleInstallDone(success) {
  if (success) {
    remoteInstalled = true;
    remoteUpdateInfo = null;
    // Installed — go straight to pairing
    remoteState = 'connecting';
    setRemotePane('connecting');
    send({ type: 'remote.pair' });
  } else {
    const log = document.getElementById('remote-install-log');
    log.textContent += '\n— Install failed. Check permissions or run manually:\n  npm install -g clideck-remote\n';
    log.scrollTop = log.scrollHeight;
  }
}

// Button click
btnRemote.addEventListener('click', () => {
  if (remoteModalOpen && remoteState !== 'paired') { closeRemoteModal(); return; }
  if (remoteModalOpen) return; // paired — can't dismiss
  if (!remoteInstalled) {
    showRemoteIntro();
    document.getElementById('remote-install-log').textContent = '';
    openRemoteModal();
    return;
  }
  remotePreflight = { pending: true, statusSeen: false, updateSeen: false };
  setRemotePane('connecting');
  openRemoteModal();
  send({ type: 'remote.status' });
});

// Install button
document.getElementById('remote-add').addEventListener('click', () => {
  document.getElementById('remote-install-log').textContent = '';
  setRemotePane('installing');
  send({ type: 'remote.install' });
});

// Close / disconnect
document.getElementById('remote-close').addEventListener('click', closeRemoteModal);
document.getElementById('remote-error-dismiss').addEventListener('click', closeRemoteModal);

document.getElementById('remote-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('remote-url-box').textContent).then(() => {
    const btn = document.getElementById('remote-copy');
    btn.textContent = 'copied!';
    setTimeout(() => { btn.textContent = 'copy the link'; }, 1500);
  });
});
document.getElementById('remote-url-box').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('remote-url-box').textContent);
});

function doRemoteDisconnect() {
  send({ type: 'remote.unpair' });
}
document.getElementById('remote-disconnect').addEventListener('click', doRemoteDisconnect);
document.getElementById('remote-disconnect2').addEventListener('click', doRemoteDisconnect);

async function boot() {
  registerServiceWorker();
  setupPWAInstall();
  syncModifierButtons();
  syncSelectionButton();
  setMobileSelectionMode(false);
  syncMobileKeyboardViewport();
  syncSplitToggleButton();
  initDrag();
  initSessionScrollbarVisibility();

  try {
    const authenticated = await refreshAuthState();
    if (!authenticated) {
      if (location.pathname !== '/login') history.replaceState({}, '', '/login');
      return;
    }
    connect();
  } catch (error) {
    showAuthShell({
      setupRequired: false,
      error: error.message || 'Unable to reach the local server.',
      status: 'CliDeck could not verify the local admin session.',
    });
  }
}

boot();
