// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async function init() {
  try {
    const me = await api.get('/auth/me');
    if (!me.loggedIn) {
      // Personalise the login page if we know the corp from a previous session
      if (me.lastCorpName) {
        document.getElementById('login-title').textContent = `${me.lastCorpName} — Corp Manager`;
        setCorpLogo('login-logo-img', 'login-logo-text', me.lastCorpId, me.lastCorpName);
      }

      // Show auth error if redirected back from a failed login
      const params = new URLSearchParams(window.location.search);
      const authError = params.get('auth_error');
      if (authError) {
        const errBox    = document.getElementById('login-error');
        const errMsg    = document.getElementById('login-error-msg');
        const errDetail = document.getElementById('login-error-detail');
        if (authError === 'missing_scopes') {
          const char    = params.get('char') || 'That character';
          const missing = (params.get('missing') || '').split(',').map(s => s.trim()).filter(Boolean);
          errMsg.textContent = `${char} is missing required ESI permissions.`;
          const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
          errDetail.innerHTML = `Please log in with a CEO or Director character and approve all scopes.<br>
            Missing: ${missing.map(m => '<code style="color:#ffb347">' + esc(m) + '</code>').join(', ')}`;
        } else if (authError === 'oauth_state') {
          errMsg.textContent = 'Login session expired.';
          errDetail.textContent = 'This can happen if the app restarted mid-login. Click Login below to try again.';
        } else {
          errMsg.textContent = 'Authentication failed.';
          errDetail.textContent = params.get('message') || 'Please try again.';
        }
        errBox.style.display = 'block';
        // Clean the URL so refreshing doesn't re-show the error
        window.history.replaceState({}, '', '/');
      }

      document.getElementById('login-page').style.display = 'flex';
      return;
    }

    // Show app
    document.getElementById('login-page').style.display = 'none';
    const appEl = document.getElementById('app');
    appEl.classList.add('visible');

    // Apply saved display settings (e.g. color blind mode)
    try {
      const display = await api.get('/api/settings/display');
      appEl.classList.toggle('color-blind-mode', !!display.colorBlindMode);
      if (typeof window !== 'undefined') window.__dateFormat = display.dateFormat || 'eu';
    } catch (_) {}

    // Apply tab visibility
    try {
      const tabVis = await api.get('/api/settings/tabs');
      applyTabVisibility(tabVis);
    } catch (_) {}

    // Show tutorial on first launch
    try {
      const tut = await api.get('/api/settings/tutorial-seen');
      if (!tut.seen) showTutorialModal();
    } catch (_) {}

    // Header — use real EVE corp logo image, fall back to initials if it fails
    document.getElementById('hdr-corp').textContent = me.corporationName || 'Your Corporation';
    document.getElementById('hdr-char').textContent = `Logged in as ${me.characterName}`;
    document.title = `${me.corporationName || 'EVE'} Dashboard`;
    setCorpLogo('hdr-logo', 'hdr-logo-text', me.corporationId, me.corporationName);

    // Load initial tab
    loadTabContent('overview');

    // Start auto-refresh every 60 seconds
    setInterval(() => {
      const active = document.querySelector('.tab-panel.active')?.id?.replace('tab-', '');
      if (active) refreshTab(active);
    }, 60_000);

    // Update sync indicator every 30s
    updateSyncDot();
    setInterval(updateSyncDot, 30_000);

    // Load wallet periods once
    loadWalletPeriods();

  } catch (err) {
    console.error('Init error:', err);
    document.getElementById('login-page').style.display = 'flex';
  }
})();

// ── Tab Visibility ─────────────────────────────────────────────────────────────
const CONFIGURABLE_TABS = ['structures', 'metenox', 'wallet', 'kills', 'contracts', 'health'];

function applyTabVisibility(vis) {
  CONFIGURABLE_TABS.forEach(t => {
    const btn   = document.querySelector(`.nav-tab[data-tab="${t}"]`);
    const panel = document.getElementById(`tab-${t}`);
    const hide  = vis[t] === false;
    if (btn)   btn.style.display   = hide ? 'none' : '';
    // If the currently active tab is being hidden, redirect to overview
    if (hide && panel && panel.classList.contains('active')) {
      document.querySelector('.nav-tab[data-tab="overview"]').click();
    }
  });
}

// ── Tutorial Modal ─────────────────────────────────────────────────────────────
function showTutorialModal() {
  const modal = document.getElementById('tutorial-modal');
  if (modal) modal.style.display = 'flex';
}

document.getElementById('btn-tutorial-close').addEventListener('click', async () => {
  document.getElementById('tutorial-modal').style.display = 'none';
  try { await api.post('/api/settings/tutorial-seen'); } catch (_) {}
});

// ── Tab Navigation ────────────────────────────────────────────────────────────
let loadedTabs = new Set();

document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    document.getElementById('tab-' + name).classList.add('active');
    loadTabContent(name);
  });
});

// Arrow key tab switching (when app visible and focus not in an input)
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('app')?.classList.contains('visible')) return;
  const active = document.activeElement;
  const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
  if (isInput) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = [...document.querySelectorAll('.nav-tab')].filter(t => t.style.display !== 'none');
  if (!tabs.length) return;
  const idx = tabs.findIndex(t => t.classList.contains('active'));
  let next = e.key === 'ArrowLeft' ? (idx <= 0 ? tabs.length - 1 : idx - 1) : (idx >= tabs.length - 1 ? 0 : idx + 1);
  tabs[next].click();
});

function loadTabContent(name) {
  loadedTabs.add(name);
  switch (name) {
    case 'overview':   loadDashboard();   break;
    case 'structures': loadStructures();  break;
    case 'metenox':    loadMetenox();     break;
    case 'wallet':     loadWallet();      break;
    case 'mining':     loadMining();      break;
    case 'kills':        loadKills();             break;
    case 'contracts':    loadContracts();          break;
    case 'moon-timers':  loadExtractions();        break;
    case 'health':       loadHealth();             break;
    case 'settings':     loadSettings();           break;
  }
}

function refreshTab(name) {
  if (!loadedTabs.has(name)) return;
  switch (name) {
    case 'overview':     loadDashboard();          break;
    case 'structures':   loadStructures();         break;
    case 'metenox':      loadMetenox();            break;
    case 'wallet':       loadTaxCharts(); loadWalletHistory(); break;
    case 'mining':       loadMining();             break;
    case 'kills':        loadKills();              break;
    case 'contracts':    loadContracts();          break;
    case 'moon-timers':  loadExtractions();        break;
    case 'health':       loadHealth();             break;
    case 'settings':     loadSyncStatus();         break;
  }
}

// ── Logout Modal ──────────────────────────────────────────────────────────────
document.getElementById('btn-logout').addEventListener('click', () => {
  const modal = document.getElementById('logout-modal');
  modal.style.display = 'flex';
});

document.getElementById('btn-logoff-cancel').addEventListener('click', () => {
  document.getElementById('logout-modal').style.display = 'none';
});

// Close modal on backdrop click
document.getElementById('logout-modal').addEventListener('mousedown', e => {
  if (e.target === e.currentTarget)
    document.getElementById('logout-modal').style.display = 'none';
});

// Log Off Only — destroy session, stay on login screen, app keeps running
document.getElementById('btn-logoff-only').addEventListener('click', () => {
  document.getElementById('logout-modal').style.display = 'none';
  window.location.href = '/auth/logout';
});

// Shut Down App — logout then close the Electron window (triggers app quit)
document.getElementById('btn-logoff-shutdown').addEventListener('click', async () => {
  document.getElementById('logout-modal').style.display = 'none';
  try { await api.post('/auth/logout'); } catch { /* best-effort */ }
  window.close(); // Electron: close event → window-all-closed → app.quit()
});

// ── Header Actions ────────────────────────────────────────────────────────────
document.getElementById('btn-sync-now').addEventListener('click', async () => {
  const btn = document.getElementById('btn-sync-now');
  btn.disabled = true; btn.textContent = '⟳ Syncing…';
  setSyncDot('grey', 'Syncing…');
  try {
    await api.post('/api/settings/sync-now');
    // Wait a moment then refresh current tab
    setTimeout(() => {
      const active = document.querySelector('.tab-panel.active')?.id?.replace('tab-', '');
      if (active) loadTabContent(active);
      btn.disabled = false; btn.textContent = '⟳ Sync Now';
      setSyncDot('green', 'Synced');
    }, 4000);
  } catch (err) {
    btn.disabled = false; btn.textContent = '⟳ Sync Now';
    setSyncDot('red', 'Sync failed');
    toast('Sync error: ' + err.message, 'error');
  }
});

document.getElementById('btn-snapshot').addEventListener('click', async () => {
  try {
    await api.post('/api/snapshots/create');
    toast('Monthly snapshot created!', 'success');
  } catch (err) { toast('Snapshot error: ' + err.message, 'error'); }
});

// ── Sync Indicator ────────────────────────────────────────────────────────────
async function updateSyncDot() {
  try {
    const status = await api.get('/api/settings/sync-status');
    const hasError = Object.values(status).some(v => v.lastError);
    const hasSynced = Object.values(status).some(v => v.lastSync);
    if (hasError) setSyncDot('red', 'Sync error');
    else if (hasSynced) {
      const ages = Object.values(status).map(v => v.lastSync || 0);
      const newest = Math.max(...ages);
      const minAgo = Math.round((Date.now() / 1000 - newest) / 60);
      setSyncDot('green', `Updated ${minAgo < 1 ? 'just now' : minAgo + 'm ago'}`);
    } else setSyncDot('grey', 'Not synced');
  } catch { setSyncDot('grey', 'Offline'); }
}

function setSyncDot(color, label) {
  const dot = document.getElementById('sync-dot');
  dot.className = `dot dot-${color}`;
  document.getElementById('sync-label').textContent = label;
}

// ── Corp Logo ─────────────────────────────────────────────────────────────────
// Sets a corporation logo using EVE's public image server.
// imgId   = id of the <img> element to show
// textId  = id of the fallback <span> showing initials
// corpId  = EVE corporation ID
// corpName = corporation name (used to generate initials fallback)
function setCorpLogo(imgId, textId, corpId, corpName) {
  const imgEl  = document.getElementById(imgId);
  const textEl = document.getElementById(textId);
  if (!imgEl || !corpId) return;

  const initials = (corpName || 'CORP').substring(0, 2).toUpperCase();
  if (textEl) textEl.textContent = initials;

  imgEl.alt = initials;
  imgEl.src = `https://images.evetech.net/corporations/${corpId}/logo?size=64`;
  imgEl.style.display = 'block';
  if (textEl) textEl.style.display = 'none';

  imgEl.onerror = () => {
    // Image failed (offline / unknown corp) — fall back to initials
    imgEl.style.display = 'none';
    if (textEl) textEl.style.display = '';
  };
}
