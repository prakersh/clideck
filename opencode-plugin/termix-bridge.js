// Termix bridge plugin for OpenCode
// Forwards session events to Termix server via HTTP POST.
// Install: copy to ~/.config/opencode/plugins/termix-bridge.js

const TERMIX_URL = "http://localhost:4000/opencode-events";

function post(payload) {
  fetch(TERMIX_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

export const TermixBridge = async () => {
  return {
    event: async ({ event }) => {
      const t = event.type;
      if (t.startsWith("session.") || t.startsWith("message.")) {
        post({ event: t, ...event.properties });
      }
    },
  };
};
