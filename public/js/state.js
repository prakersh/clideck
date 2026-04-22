export const state = {
  ws: null,
  authRefreshTimer: null,
  terms: new Map(),
  active: null,
  layout: {
    mode: 'single',
    panes: [null, null],
    focusedPane: 0,
  },
  cfg: { commands: [], defaultPath: '', defaultTheme: 'catppuccin-mocha' },
  themes: [],
  presets: [],
  resumable: [],
  filter: { query: '', tab: 'all' },
  pills: new Map(),
  activePill: null,
  transcriptCache: {},
  auth: {
    ready: false,
    authenticated: false,
    setupRequired: false,
    user: null,
    loggingOut: false,
  },
  remoteVersion: null,
  mobileKeybar: {
    open: false,
    selectionMode: false,
    modifiers: {
      ctrl: false,
      alt: false,
      shift: false,
    },
  },
};

export function send(msg) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(msg));
  return true;
}
