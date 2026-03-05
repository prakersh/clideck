// OpenCode bridge — receives events from the Termix OpenCode plugin
// via HTTP POST to /opencode-events.
// Routes events to the correct Termix session by OpenCode session ID.

// termixId → { opencodeSessionId, cwd }
const watchers = new Map();

let broadcastFn = null;
let sessionsFn = null;

function init(broadcast, getSessions) {
  broadcastFn = broadcast;
  sessionsFn = getSessions;
}

function watchSession(termixId, cwd) {
  if (watchers.has(termixId)) return;
  watchers.set(termixId, { opencodeSessionId: null, cwd });
}

function findByOcId(ocSid) {
  for (const [termixId, w] of watchers) {
    if (w.opencodeSessionId === ocSid) return termixId;
  }
  return null;
}

function findUnclaimed(directory) {
  let fallback = null;
  for (const [termixId, w] of watchers) {
    if (w.opencodeSessionId) continue;
    if (directory && w.cwd && directory.startsWith(w.cwd)) return termixId;
    if (!fallback) fallback = termixId;
  }
  return fallback;
}

// Extract OpenCode session ID from any event shape
function extractOcSid(p) {
  return p.sessionID || p.info?.id || p.part?.sessionID;
}

function handleEvent(payload) {
  if (!payload || !payload.event) return;

  const ocSid = extractOcSid(payload);
  if (!ocSid) { console.log(`[oc-bridge] no sessionId in ${payload.event}`); return; }

  let termixId = findByOcId(ocSid);
  console.log(`[oc-bridge] ${payload.event} ocSid=${ocSid.slice(0,12)} termixId=${termixId?.slice(0,8) || 'NONE'} watchers=${watchers.size}`);

  // Claim unclaimed watcher on session.created or session.updated
  if (!termixId && (payload.event === 'session.created' || payload.event === 'session.updated')) {
    termixId = findUnclaimed(payload.info?.directory);
    if (termixId) {
      const w = watchers.get(termixId);
      w.opencodeSessionId = ocSid;
      const sess = sessionsFn?.()?.get(termixId);
      if (sess && !sess.sessionToken) sess.sessionToken = ocSid;
      console.log(`[opencode-bridge] linked ${ocSid} → ${termixId.slice(0, 8)}`);
    }
  }

  if (!termixId) return;

  // session.status → busy/idle
  if (payload.event === 'session.status') {
    const t = payload.status?.type;
    console.log(`[oc-bridge] STATUS ${t} → ${termixId.slice(0,8)}`);
    if (t === 'busy') broadcastFn?.({ type: 'session.status', id: termixId, working: true });
    else if (t === 'idle') broadcastFn?.({ type: 'session.status', id: termixId, working: false });
  }

  // session.idle
  if (payload.event === 'session.idle') {
    console.log(`[oc-bridge] IDLE → ${termixId.slice(0,8)}`);
    broadcastFn?.({ type: 'session.status', id: termixId, working: false });
  }

  // message.part.updated with type=text → preview
  if (payload.event === 'message.part.updated' && payload.part?.type === 'text' && payload.part.text) {
    console.log(`[oc-bridge] PREVIEW → ${termixId.slice(0,8)}: "${payload.part.text.slice(0,60)}"`);
    broadcastFn?.({ type: 'session.preview', id: termixId, text: payload.part.text.slice(0, 200) });
  }

  // session.updated → capture title, ensure token
  if (payload.event === 'session.updated') {
    const sess = sessionsFn?.()?.get(termixId);
    if (sess) {
      if (!sess.sessionToken) sess.sessionToken = ocSid;
      if (payload.info?.title) sess.title = payload.info.title;
    }
  }
}

function clear(termixId) {
  watchers.delete(termixId);
}

module.exports = { init, watchSession, handleEvent, clear };
