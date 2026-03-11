export const state = {
  ws: null,
  authRefreshTimer: null,
  terms: new Map(),
  active: null,
  cfg: { commands: [], defaultPath: '', defaultTheme: 'catppuccin-mocha' },
  themes: [],
  presets: [],
  resumable: [],
  filter: { query: '', tab: 'all' },
  transcriptCache: {},
  auth: {
    ready: false,
    authenticated: false,
    setupRequired: false,
    user: null,
    loggingOut: false,
  },
};

export function send(msg) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(msg));
  return true;
}
