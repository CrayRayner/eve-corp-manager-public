'use strict';
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const IS_DEV = !app.isPackaged;
const PORT   = 3000;

// ── Single instance lock ───────────────────────────────────────────────────────
// Prevent the user from accidentally opening two copies at once.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── Environment setup (MUST run before requiring server) ───────────────────────
// Sets DB_PATH and loads .env so all server modules pick up the right config.
function setupEnvironment() {
  const userData = app.getPath('userData');

  // Always point the database to the user's data folder so it:
  //  • survives app updates (install dir may be wiped)
  //  • is writable (C:\Program Files is not)
  //  • is per-user on multi-user machines
  process.env.DB_PATH       = path.join(userData, 'corp.db');
  process.env.USER_DATA_PATH = userData;

  // If a restore file was left by Settings → Restore, apply it before the server opens the DB
  const dbPath = process.env.DB_PATH;
  const restorePath = dbPath + '.restore';
  if (fs.existsSync(restorePath)) {
    try {
      if (fs.existsSync(dbPath)) fs.renameSync(dbPath, dbPath + '.bak');
      fs.renameSync(restorePath, dbPath);
      console.log('[Electron] Restored database from backup; previous DB saved as corp.db.bak');
    } catch (e) {
      console.error('[Electron] Restore failed:', e.message);
    }
  }

  if (IS_DEV) {
    // Development: load .env from the project root as normal
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    return;
  }

  // ── Production first-launch setup ─────────────────────────────────────────
  // The bundled .env (in resources/) contains EVE_CLIENT_ID baked in at
  // build time. On first launch we copy it to userData and add a freshly
  // generated SESSION_SECRET. Each installation gets its own secret.
  const userEnvPath = path.join(userData, '.env');

  if (!fs.existsSync(userEnvPath)) {
    fs.mkdirSync(userData, { recursive: true });

    let clientId    = '';
    let callbackUrl = `http://localhost:${PORT}/auth/callback`;
    const bundledEnv = path.join(process.resourcesPath, '.env');

    if (fs.existsSync(bundledEnv)) {
      const src = fs.readFileSync(bundledEnv, 'utf8');
      const idM = src.match(/^EVE_CLIENT_ID=(.+)$/m);
      const cbM = src.match(/^EVE_CALLBACK_URL=(.+)$/m);
      if (idM) clientId    = idM[1].trim();
      if (cbM) callbackUrl = cbM[1].trim();
    }

    fs.writeFileSync(userEnvPath, [
      `EVE_CLIENT_ID=${clientId}`,
      `EVE_CALLBACK_URL=${callbackUrl}`,
      `SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`,
    ].join('\n'), 'utf8');

    console.log('[Electron] First launch — created config in:', userEnvPath);
  }

  require('dotenv').config({ path: userEnvPath });
}

setupEnvironment();

// ── Cloud sync helpers (run before server opens the DB) ────────────────────────

async function syncOnStartup() {
  try {
    const cloudSync = require('../server/cloud-sync');
    const cfg = cloudSync.loadConfig();
    if (!cfg.enabled || !cfg.url || !cfg.secretEnc) return;

    const dbPath = process.env.DB_PATH;
    console.log('[CloudSync] Checking remote status…');
    const status = await cloudSync.getStatus(cfg).catch(e => { console.error('[CloudSync] Status check failed:', e.message); return null; });
    if (!status) return;

    const remoteVersion = status.version || 0;
    const baseVersion   = cfg.baseVersion || 0;

    if (status.exists && remoteVersion > baseVersion) {
      console.log(`[CloudSync] Remote is newer (${remoteVersion} > ${baseVersion}), downloading…`);
      await cloudSync.download(cfg, dbPath);
      cfg.baseVersion = remoteVersion;
      cloudSync.saveConfig(cfg);
      console.log('[CloudSync] Downloaded remote DB');
    } else {
      console.log('[CloudSync] Local is up to date');
    }

    const lockResult = await cloudSync.acquireLock(cfg).catch(e => { console.error('[CloudSync] Lock failed:', e.message); return null; });
    cfg.lockWarning = (lockResult && !lockResult.ok) ? lockResult : null;
    cloudSync.saveConfig(cfg);
    if (cfg.lockWarning) console.warn(`[CloudSync] Lock held by: ${cfg.lockWarning.lockedBy}`);
  } catch (err) {
    console.error('[CloudSync] Startup sync error (non-fatal):', err.message);
  }
}

async function syncOnClose() {
  try {
    const cloudSync = require('../server/cloud-sync');
    const cfg = cloudSync.loadConfig();
    if (!cfg.enabled || !cfg.url || !cfg.secretEnc) return;
    const dbPath = process.env.DB_PATH;
    if (!dbPath || !fs.existsSync(dbPath)) return;

    console.log('[CloudSync] Uploading on close…');
    const result = await cloudSync.upload(cfg, dbPath, false);

    if (result.conflict) {
      console.warn('[CloudSync] Conflict on close — force-uploading local version');
      const forced = await cloudSync.upload(cfg, dbPath, true);
      if (forced.version) cfg.baseVersion = forced.version;
    } else if (result.version) {
      cfg.baseVersion = result.version;
    }

    await cloudSync.releaseLock(cfg);
    cloudSync.saveConfig(cfg);
    console.log('[CloudSync] Close upload complete');
  } catch (err) {
    console.error('[CloudSync] Close sync error (non-fatal):', err.message);
  }
}

// ── Window & Tray ──────────────────────────────────────────────────────────────
let mainWindow = null;
let tray       = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1280,
    height:          820,
    minWidth:        900,
    minHeight:       600,
    title:           'EVE Corp Manager',
    backgroundColor: '#040810',   // EVE dark — hides white flash before page loads
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
    show: false, // reveal only after ready-to-show (no white flash)
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Reveal cleanly once the renderer has painted its first frame
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // ── Navigation security ──────────────────────────────────────────────────
  // Allow: our local app + EVE SSO (needed for the OAuth login flow)
  // Everything else (e.g. footer GitHub link via target=_blank) → system browser
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed =
      url.startsWith(`http://localhost:${PORT}`) ||
      url.startsWith('https://login.eveonline.com');
    if (!allowed) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // target="_blank" links (like the footer GitHub link) → system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // X button → quit the whole app (server + cron shut down via will-quit → process.exit)
  // Tray remains available while the window is open; closing the window ends the session.


}

function createTray() {
  try {
    const icon = require('./icon'); // generated EVE-teal PNG icon
    tray = new Tray(icon);
  } catch (err) {
    console.warn('[Electron] Could not create tray icon:', err.message);
    return;
  }

  tray.setToolTip('EVE Corp Manager');

  const menu = Menu.buildFromTemplate([
    {
      label: '🚀 Open EVE Corp Manager',
      click: () => { mainWindow?.show(); mainWindow?.focus(); },
    },
    { type: 'separator' },
    {
      label: '⟳ Sync Now',
      click: () => {
        // Trigger a sync via the running Express server
        const http = require('http');
        const req  = http.request({ host: 'localhost', port: PORT, path: '/api/settings/sync-now', method: 'POST' });
        req.on('error', () => {}); // fire-and-forget
        req.end();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.quitting = true; app.quit(); },
    },
  ]);

  tray.setContextMenu(menu);

  // Double-click the tray icon → show window
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ── App lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // 1. Cloud sync: pull remote DB if it's newer (must run BEFORE the server opens the DB)
  await syncOnStartup();

  // 2. Start Express server (opens SQLite, loads all routes)
  const { ready } = require('../server/index.js');

  // 3. Wait for server to be listening
  try {
    await ready;
  } catch (err) {
    dialog.showErrorBox('EVE Corp Manager — Startup Error', err.message + '\n\nClose any other running instances and try again.');
    app.quit();
    return;
  }
  console.log('[Electron] Server ready — opening window');

  createWindow();
  createTray();
});

// If the user tries to open a second instance, focus the existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized() || !mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

// Quit when the last window is closed (X button, or window.close() from renderer)
app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  app.quitting = true;
});

// Force-exit the Node.js process once Electron has finished shutting down.
// Without this, the Express HTTP server and node-cron jobs keep the event
// loop alive and the terminal hangs even after the window is gone.
let _quitSyncDone = false;
app.on('will-quit', (e) => {
  if (_quitSyncDone) { process.exit(0); return; }
  _quitSyncDone = true;
  e.preventDefault();
  syncOnClose()
    .catch(err => console.error('[CloudSync] will-quit error:', err.message))
    .finally(() => process.exit(0));
});

// macOS: re-create window when dock icon is clicked and no window is open
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
