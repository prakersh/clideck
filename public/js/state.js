export const state = {
  ws: null,
  terms: new Map(),
  active: null,
  cfg: { commands: [], defaultPath: '', profiles: [], defaultProfile: 'default' },
  themes: [],
  presets: [],
  resumable: [],
  filter: { query: '', tab: 'all' },
};

export function send(msg) {
  state.ws.send(JSON.stringify(msg));
}
