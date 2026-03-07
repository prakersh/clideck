let settings = { enabled: true, trimLeading: false };
let btnEl = null;

function showToast(message, success) {
  document.querySelectorAll('.trimclip-toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className = 'trimclip-toast';
  const bg = success ? 'rgba(16,185,129,0.9)' : 'rgba(100,116,139,0.9)';
  Object.assign(toast.style, {
    position: 'fixed', bottom: '20px', right: '20px', zIndex: '9999',
    padding: '8px 14px', borderRadius: '8px', fontSize: '12px',
    color: '#fff', background: bg, backdropFilter: 'blur(8px)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    opacity: '0', transform: 'translateY(8px)',
    transition: 'opacity 0.2s ease, transform 0.2s ease',
    fontFamily: 'system-ui, sans-serif',
  });
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 200);
  }, 2000);
}

export function init(api) {
  api.onMessage('settings', (msg) => {
    settings.enabled = msg.enabled !== false;
    settings.trimLeading = !!msg.trimLeading;
    if (btnEl) btnEl.style.display = settings.enabled ? '' : 'none';
  });
  api.send('getSettings');

  btnEl = api.addToolbarButton({
    title: 'Trim Clipboard',
    icon: '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>',
    async onClick() {
      try {
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) { showToast('Clipboard is empty'); return; }
        const trimmed = text
          .split('\n')
          .map(l => settings.trimLeading ? l.trim() : l.trimEnd())
          .join('\n')
          .replace(/^\n+/, '').replace(/\n+$/, '');
        if (trimmed === text) { showToast('Already clean'); return; }
        await navigator.clipboard.writeText(trimmed);
        const saved = text.length - trimmed.length;
        showToast(`Trimmed ${saved} char${saved !== 1 ? 's' : ''}`, true);
      } catch {
        showToast('Cannot access clipboard');
      }
    }
  });
}
