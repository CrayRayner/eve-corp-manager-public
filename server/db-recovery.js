'use strict';
/**
 * Shared database backup / restore logic.
 *
 * Used by BOTH:
 *   • routes/settings.js — the normal, logged-in Backup & Restore card
 *   • routes/auth.js     — the login-screen recovery panel, which must work
 *                          WITHOUT a session (a corrupt DB breaks login itself,
 *                          so gating recovery behind login is a dead end)
 *
 * Keep the logic here only — two copies would drift, and a restore path that
 * silently behaves differently depending on where it was triggered is exactly
 * the kind of bug you never notice until you need it.
 */
const fs     = require('fs');
const path   = require('path');
const multer = require('multer');
const { db, DB_PATH, integrityVerdict } = require('./db');

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'utf8');

// Uploaded restore files land here first, then get staged next to the DB.
const uploadDir = path.join(path.dirname(DB_PATH), 'upload');
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(uploadDir, { recursive: true }); cb(null, uploadDir); },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

/** Current database health, as determined once at startup by db.js. */
function getStatus() {
  return {
    healthy: integrityVerdict === 'ok',
    verdict: integrityVerdict,
    dbPath:  DB_PATH,
    exists:  fs.existsSync(DB_PATH),
  };
}

/**
 * Write a consistent snapshot of the live DB to `${DB_PATH}.backup-tmp`.
 * Uses SQLite's online backup API — safe with WAL, unlike copying the raw file.
 * Caller is responsible for deleting the file when done streaming it.
 */
async function createSnapshot() {
  if (!fs.existsSync(DB_PATH)) throw new Error('Database not found');
  const tmpPath = DB_PATH + '.backup-tmp';
  await db.backup(tmpPath);
  return tmpPath;
}

/** True if the file starts with the SQLite magic header. */
function isSqliteFile(filePath) {
  // NOTE: fs.readFileSync ignores {start,end} — must use a file descriptor.
  const fd  = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(SQLITE_MAGIC.length);
  try {
    fs.readSync(fd, buf, 0, SQLITE_MAGIC.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buf.equals(SQLITE_MAGIC);
}

/**
 * Validate an uploaded file and stage it as `${DB_PATH}.restore`.
 * Electron's main.js swaps it in on the next launch, before the DB is opened —
 * replacing a database that is currently open would corrupt it.
 * Always consumes (deletes) the uploaded temp file.
 * Throws on invalid input; the message is safe to show the user.
 */
function stageRestore(uploadedPath) {
  try {
    if (!isSqliteFile(uploadedPath)) {
      throw new Error('Uploaded file is not a valid SQLite database');
    }
    fs.copyFileSync(uploadedPath, DB_PATH + '.restore');
  } finally {
    try { fs.unlinkSync(uploadedPath); } catch {}
  }
  return { ok: true, message: 'Backup staged. Restart the application to complete the restore.' };
}

/**
 * Reject requests that did not originate from the app's own page.
 * The logged-in routes are CSRF-safe via the sameSite:'strict' session cookie;
 * the unauthenticated recovery routes have no cookie to rely on, so a malicious
 * page could otherwise POST a database at localhost while the app is running.
 */
function sameOriginOnly(req, res, next) {
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'Cross-origin request refused' });
  }
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try {
      const host = new URL(origin).hostname;
      ok = host === 'localhost' || host === '127.0.0.1';
    } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: 'Cross-origin request refused' });
  }
  next();
}

module.exports = { upload, getStatus, createSnapshot, stageRestore, isSqliteFile, sameOriginOnly, DB_PATH };
