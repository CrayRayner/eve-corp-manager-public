'use strict';
/**
 * Cloud Sync — shared helper module
 *
 * Reads/writes sync-config.json in the same folder as the database.
 * Called from:
 *   • electron/main.js   — startup download + close upload
 *   • server/routes/settings.js — manual push/pull/test via UI
 *   • server/scheduler.js       — background upload after ESI sync
 */
const fs   = require('fs');
const path = require('path');

// ── Config I/O ────────────────────────────────────────────────────────────────

function getConfigPath() {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) return null;
  return path.join(path.dirname(dbPath), 'sync-config.json');
}

const DEFAULTS = {
  enabled:     false,
  url:         '',
  secretEnc:   '',        // encrypted with safeStorage (enc:… prefix)
  displayName: 'Director',
  baseVersion: 0,         // remote version we last downloaded or uploaded
  lockWarning: null,      // { lockedBy, lockedAt } if someone else had the lock at startup
};

function loadConfig() {
  const p = getConfigPath();
  if (!p) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  const p = getConfigPath();
  if (!p) return;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
}

// Decrypt secret — falls back to raw string if DPAPI unavailable (dev mode)
function getSecret(cfg) {
  if (!cfg.secretEnc) return '';
  try {
    const { decryptValue } = require('./secure-storage');
    return decryptValue(cfg.secretEnc);
  } catch {
    return cfg.secretEnc; // plaintext fallback
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function getStatus(cfg) {
  const res = await fetch(`${cfg.url}?action=status`, {
    headers: { 'X-Sync-Secret': getSecret(cfg) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`status: HTTP ${res.status}`);
  return res.json();
}

async function download(cfg, destPath) {
  const res = await fetch(`${cfg.url}?action=download`, {
    headers: { 'X-Sync-Secret': getSecret(cfg) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

/**
 * Upload local DB to remote.
 * Returns { ok, version } on success, { conflict, uploadedBy, uploadedAt, serverVersion } on 409.
 * Throws on network / server errors.
 */
async function upload(cfg, dbPath, force = false) {
  const buf  = fs.readFileSync(dbPath);
  const by   = encodeURIComponent(cfg.displayName || 'Director');
  const base = cfg.baseVersion || 0;
  const url  = `${cfg.url}?action=upload&by=${by}&baseVersion=${base}${force ? '&force=1' : ''}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'X-Sync-Secret': getSecret(cfg), 'Content-Type': 'application/octet-stream' },
    body:    buf,
    signal:  AbortSignal.timeout(60_000),
  });

  const data = await res.json().catch(() => ({}));
  return { httpStatus: res.status, ...data };
}

async function acquireLock(cfg) {
  const by  = encodeURIComponent(cfg.displayName || 'Director');
  const res = await fetch(`${cfg.url}?action=lock&by=${by}`, {
    headers: { 'X-Sync-Secret': getSecret(cfg) },
    signal:  AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`lock: HTTP ${res.status}`);
  return res.json();
}

async function releaseLock(cfg) {
  try {
    await fetch(`${cfg.url}?action=unlock`, {
      headers: { 'X-Sync-Secret': getSecret(cfg) },
      signal:  AbortSignal.timeout(10_000),
    });
  } catch {} // best-effort on close
}

// ── Background upload (called by scheduler after ESI sync) ────────────────────
// Silent: never throws, never blocks.
async function backgroundUpload() {
  try {
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.url || !cfg.secretEnc) return;
    const dbPath = process.env.DB_PATH;
    if (!dbPath || !fs.existsSync(dbPath)) return;

    const result = await upload(cfg, dbPath, false);

    if (result.conflict) {
      // Background conflict: force-upload (local ESI data wins)
      const forced = await upload(cfg, dbPath, true);
      if (forced.version) { cfg.baseVersion = forced.version; saveConfig(cfg); }
      console.log('[CloudSync] Background upload: conflict force-resolved');
    } else if (result.version) {
      cfg.baseVersion = result.version;
      saveConfig(cfg);
    }
  } catch (err) {
    console.error('[CloudSync] Background upload error:', err.message);
  }
}

module.exports = {
  loadConfig, saveConfig, getSecret,
  getStatus, download, upload, acquireLock, releaseLock,
  backgroundUpload,
};
