'use strict';
require('dotenv').config();
const express        = require('express');
const session        = require('express-session');
const path           = require('path');
const { startScheduler, updateSchedulerCharacter, runFullSync } = require('./scheduler');
const { db }         = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'change-me-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie:            {
    maxAge:  7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure:  process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
}));

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Prevents runaway frontend loops from hammering the local server.
// 300 requests/minute per route prefix — generous for normal use.
const _rlWindows = new Map();
function apiRateLimit(req, res, next) {
  const key  = req.path.split('/').slice(0, 3).join('/');
  const now  = Date.now();
  const entry = _rlWindows.get(key) || { count: 0, start: now };
  if (now - entry.start > 60000) { entry.count = 1; entry.start = now; }
  else entry.count++;
  _rlWindows.set(key, entry);
  if (entry.count > 300) return res.status(429).json({ error: 'Too many requests' });
  next();
}
app.use('/api', apiRateLimit);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth',           require('./routes/auth'));
app.use('/api/structures', require('./routes/structures'));
app.use('/api/wallet',     require('./routes/wallet'));
app.use('/api/metenox',    require('./routes/metenox'));
app.use('/api/inventory',  require('./routes/inventory'));
app.use('/api/settings',   require('./routes/settings'));
app.use('/api/kills',      require('./routes/kills'));
app.use('/api/contracts',  require('./routes/contracts'));
app.use('/api/fleet-points', require('./routes/fleet-points'));
app.use('/api/health',       require('./routes/health'));
app.use('/api',            require('./routes/dashboard'));  // /api/summary, /api/snapshots

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

// Resolves when the HTTP server is listening — Electron waits for this
// before opening the BrowserWindow so the page is always ready on load.
let _resolveReady, _rejectReady;
const ready = new Promise((resolve, reject) => { _resolveReady = resolve; _rejectReady = reject; });

const server = app.listen(PORT, () => {
  _resolveReady(); // signal Electron (or any caller) that we are up

  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │  EVE Corp Dashboard running on port ${PORT}     │`);
  console.log(`  │  Open: http://localhost:${PORT}                │`);
  console.log(`  └─────────────────────────────────────────────┘\n`);

  // Resume scheduler for the last logged-in user (if any)
  const lastToken = db.prepare('SELECT character_id, corporation_id FROM tokens LIMIT 1').get();
  if (lastToken) {
    console.log(`[Auth] Resuming session for character ${lastToken.character_id}`);
    startScheduler(lastToken.character_id);
    runFullSync(lastToken.character_id).catch(() => {});
  } else {
    console.log('[Auth] No session found — please login at http://localhost:' + PORT);
    startScheduler(null);
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    _rejectReady(new Error(`Port ${PORT} is already in use. Another instance of EVE Corp Manager may already be running.`));
  } else {
    _rejectReady(err);
  }
});

// Export so routes can call updateSchedulerCharacter after new login,
// and so Electron can await `ready` before opening the window.
module.exports = { updateSchedulerCharacter, ready };
