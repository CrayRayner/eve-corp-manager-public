'use strict';
const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { requireAuth }  = require('../auth');
const { db, getSetting, setSetting, getSyncStatus, DB_PATH } = require('../db');
const { encryptValue, decryptValue } = require('../secure-storage');

// ── Alt → Main Mappings ────────────────────────────────────────────────────────

// GET /api/settings/mappings
router.get('/mappings', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  const rows = db.prepare('SELECT * FROM alt_mappings WHERE corporation_id = ? ORDER BY main_name, character_name').all(corpId);
  res.json(rows);
});

// POST /api/settings/mappings
router.post('/mappings', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  const { characterId, characterName, mainName } = req.body;
  if (!characterName || !mainName) return res.status(400).json({ error: 'characterName and mainName required' });

  // If no characterId given, try to resolve from cache
  let charId = characterId;
  if (!charId) {
    const cached = db.prepare('SELECT id FROM name_cache WHERE LOWER(name) = LOWER(?)').get(characterName);
    charId = cached?.id || Math.floor(Math.random() * -1e9); // temp negative ID if unknown
  }

  db.prepare(`
    INSERT INTO alt_mappings (character_id, character_name, main_name, corporation_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET character_name = excluded.character_name, main_name = excluded.main_name, corporation_id = excluded.corporation_id
  `).run(charId, characterName, mainName, corpId);

  res.json({ ok: true });
});

// DELETE /api/settings/mappings/:id
router.delete('/mappings/:id', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  db.prepare('DELETE FROM alt_mappings WHERE character_id = ? AND corporation_id = ?').run(parseInt(req.params.id, 10), corpId);
  res.json({ ok: true });
});

// ── Notification Settings ──────────────────────────────────────────────────────

// GET /api/settings/notifications
router.get('/notifications', requireAuth, (req, res) => {
  res.json({
    smtpHost:         getSetting('smtp_host', ''),
    smtpPort:         getSetting('smtp_port', '587'),
    smtpUser:         getSetting('smtp_user', ''),
    smtpPassSet:      !!getSetting('smtp_pass', ''),  // never send password to browser
    smtpFrom:         getSetting('smtp_from', ''),
    smtpTls:          getSetting('smtp_tls', 'true'),
    recipients:       getSetting('recipients', ''),
    fuelThresholdDays: getSetting('fuel_threshold_days', '14'),
    gasThresholdDays:  getSetting('gas_threshold_days', '7'),
    enabled:                       getSetting('notifications_enabled', 'true'),
    contractNotificationsEnabled:  getSetting('contract_notifications_enabled', 'true'),
    discordWebhookUrl:             getSetting('discord_webhook_url', ''),
  });
});

// PUT /api/settings/notifications
router.put('/notifications', requireAuth, (req, res) => {
  const fields = {
    'smtp_host':            req.body.smtpHost,
    'smtp_port':            req.body.smtpPort,
    'smtp_user':            req.body.smtpUser,
    'smtp_from':            req.body.smtpFrom,
    'smtp_tls':             req.body.smtpTls,
    'recipients':           req.body.recipients,
    'fuel_threshold_days':  req.body.fuelThresholdDays,
    'gas_threshold_days':   req.body.gasThresholdDays,
    'notifications_enabled':            req.body.enabled,
    'contract_notifications_enabled':   req.body.contractNotificationsEnabled,
    'discord_webhook_url':              req.body.discordWebhookUrl,
  };
  if (req.body.smtpPass) fields['smtp_pass'] = encryptValue(req.body.smtpPass);

  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) setSetting(k, v);
  }
  res.json({ ok: true });
});

// POST /api/settings/notifications/test — send a test email
router.post('/notifications/test', requireAuth, async (req, res) => {
  try {
    const { sendTestEmail } = require('../notifications');
    await sendTestEmail();
    res.json({ ok: true, message: 'Test email sent successfully.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/settings/notifications/test-discord — send a test message to Discord webhook
router.post('/notifications/test-discord', requireAuth, async (req, res) => {
  try {
    const { sendTestDiscord } = require('../notifications');
    await sendTestDiscord();
    res.json({ ok: true, message: 'Test message sent to Discord.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/settings/notifications/log — last 10 sent notifications
router.get('/notifications/log', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  const rows = db.prepare(`
    SELECT nl.*, s.name AS structure_name
    FROM notification_log nl
    LEFT JOIN structures s ON s.structure_id = nl.structure_id AND s.corporation_id = nl.corporation_id
    WHERE nl.corporation_id = ?
    ORDER BY nl.sent_at DESC LIMIT 10
  `).all(corpId);
  res.json(rows);
});

// ── Sync Status ───────────────────────────────────────────────────────────────

// GET /api/settings/sync-status
router.get('/sync-status', requireAuth, (req, res) => {
  const keys = ['structures', 'wallet', 'assets', 'mining', 'observers', 'market_prices', 'members', 'kills'];
  const status = {};
  for (const k of keys) {
    const row = getSyncStatus(k);
    status[k] = row
      ? { lastSync: row.last_sync, lastError: row.last_error }
      : { lastSync: null, lastError: null };
  }
  res.json(status);
});

// GET /api/settings/sync-errors — list of { key, message, at } for display in "Last Sync Errors"
router.get('/sync-errors', requireAuth, (req, res) => {
  const keys = ['structures', 'wallet', 'assets', 'mining', 'observers', 'market_prices', 'members', 'kills'];
  const errors = [];
  for (const k of keys) {
    const row = getSyncStatus(k);
    if (row?.last_error) {
      errors.push({
        key: k,
        message: row.last_error,
        at: row.last_sync ? new Date(row.last_sync * 1000).toISOString() : null,
      });
    }
  }
  res.json(errors);
});

// GET /api/settings/backup — stream the database file for download
router.get('/backup', requireAuth, (req, res) => {
  if (!fs.existsSync(DB_PATH)) return res.status(404).json({ error: 'Database not found' });
  const name = path.basename(DB_PATH);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  const stream = fs.createReadStream(DB_PATH);
  stream.pipe(res);
});

const uploadDir = path.join(path.dirname(DB_PATH), 'upload');
const upload = multer({ dest: uploadDir, limits: { fileSize: 200 * 1024 * 1024 } });

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'utf8');

router.post('/restore', requireAuth, (req, res, next) => {
  fs.mkdirSync(uploadDir, { recursive: true });
  upload.single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const restorePath = DB_PATH + '.restore';
    try {
      const buf = fs.readFileSync(req.file.path, { start: 0, end: SQLITE_MAGIC.length });
      if (!buf.equals(SQLITE_MAGIC)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Uploaded file is not a valid SQLite database' });
      }
      fs.copyFileSync(req.file.path, restorePath);
      fs.unlinkSync(req.file.path);
    } catch (e) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(500).json({ error: e.message });
    }
    res.json({ ok: true, message: 'Backup saved. Restart the application to complete restore.' });
  });
});

// GET /api/settings/corp-rates — ISK tax % (for wallet display)
router.get('/corp-rates', requireAuth, (req, res) => {
  res.json({
    taxRatePercent: getSetting('corp_tax_rate') != null && getSetting('corp_tax_rate') !== ''
      ? parseFloat(getSetting('corp_tax_rate')) : null,
  });
});

// PUT /api/settings/corp-rates
router.put('/corp-rates', requireAuth, (req, res) => {
  const { taxRatePercent } = req.body;
  if (taxRatePercent !== undefined) {
    setSetting('corp_tax_rate', (taxRatePercent === null || taxRatePercent === '') ? '' : String(Math.max(0, Math.min(100, parseFloat(taxRatePercent) || 0))));
  }
  res.json({ ok: true });
});

// POST /api/settings/sync-now — trigger a manual full sync
router.post('/sync-now', requireAuth, async (req, res) => {
  try {
    const { runFullSync } = require('../scheduler');
    const characterId = req.session.characterId;
    res.json({ ok: true, message: 'Sync started in background' });
    runFullSync(characterId).catch(e => console.error('Manual sync error:', e));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Tutorial ───────────────────────────────────────────────────────────────────

// GET /api/settings/tutorial-seen
router.get('/tutorial-seen', requireAuth, (req, res) => {
  res.json({ seen: getSetting('tutorial_seen', 'false') === 'true' });
});

// POST /api/settings/tutorial-seen
router.post('/tutorial-seen', requireAuth, (req, res) => {
  setSetting('tutorial_seen', 'true');
  res.json({ ok: true });
});

// ── Tab Visibility ──────────────────────────────────────────────────────────────

const CONFIGURABLE_TABS = ['structures', 'metenox', 'wallet', 'kills', 'contracts', 'health'];

// GET /api/settings/tabs
router.get('/tabs', requireAuth, (req, res) => {
  const vis = {};
  for (const t of CONFIGURABLE_TABS) {
    vis[t] = getSetting(`tab_visible_${t}`, 'true') !== 'false';
  }
  res.json(vis);
});

// PUT /api/settings/tabs
router.put('/tabs', requireAuth, (req, res) => {
  for (const t of CONFIGURABLE_TABS) {
    if (req.body[t] !== undefined) {
      setSetting(`tab_visible_${t}`, req.body[t] ? 'true' : 'false');
    }
  }
  res.json({ ok: true });
});

// ── CEO Scratchpad ─────────────────────────────────────────────────────────────

// GET /api/settings/scratchpad
router.get('/scratchpad', requireAuth, (req, res) => {
  res.json({ text: getSetting('scratchpad_text', '') });
});

// PUT /api/settings/scratchpad
router.put('/scratchpad', requireAuth, (req, res) => {
  setSetting('scratchpad_text', String(req.body.text ?? ''));
  res.json({ ok: true });
});

// ── Fuel Hangar ────────────────────────────────────────────────────────────────

// GET /api/settings/fuel-hangar
router.get('/fuel-hangar', requireAuth, (req, res) => {
  res.json({
    fuelHangar: getSetting('fuel_hangar', 'CorpSAG3'),
    gasConsumptionPerMonth: getSetting('gas_consumption_per_month', '144000'),
  });
});

// PUT /api/settings/fuel-hangar
router.put('/fuel-hangar', requireAuth, (req, res) => {
  const { fuelHangar, gasConsumptionPerMonth } = req.body;
  const valid = ['CorpSAG1','CorpSAG2','CorpSAG3','CorpSAG4','CorpSAG5','CorpSAG6','CorpSAG7'];
  if (fuelHangar !== undefined) {
    if (!valid.includes(fuelHangar)) return res.status(400).json({ error: 'Invalid hangar' });
    setSetting('fuel_hangar', fuelHangar);
  }
  if (gasConsumptionPerMonth !== undefined) {
    const n = parseInt(String(gasConsumptionPerMonth), 10);
    if (isNaN(n) || n < 1) return res.status(400).json({ error: 'Gas consumption per month must be a positive number' });
    setSetting('gas_consumption_per_month', String(n));
  }
  res.json({ ok: true });
});

// ── Display (e.g. color blind mode) ────────────────────────────────────────────

// GET /api/settings/display
router.get('/display', requireAuth, (req, res) => {
  res.json({
    colorBlindMode: getSetting('color_blind_mode', 'false') === 'true',
    dateFormat: getSetting('date_format', 'eu') === 'us' ? 'us' : 'eu',
    structureFuelMonthHours: getSetting('structure_fuel_month_hours', '720'),
  });
});

// PUT /api/settings/display
router.put('/display', requireAuth, (req, res) => {
  if (req.body.colorBlindMode !== undefined) {
    setSetting('color_blind_mode', req.body.colorBlindMode ? 'true' : 'false');
  }
  if (req.body.dateFormat !== undefined) {
    setSetting('date_format', req.body.dateFormat === 'us' ? 'us' : 'eu');
  }
  if (req.body.structureFuelMonthHours !== undefined) {
    const n = parseInt(String(req.body.structureFuelMonthHours), 10);
    setSetting('structure_fuel_month_hours', (n >= 1 && n <= 744) ? String(n) : '720');
  }
  res.json({ ok: true });
});

// ── CSV Alt→Main Import ────────────────────────────────────────────────────────

// POST /api/settings/mappings/csv — import alt→main from CSV text
// Body: { csvText: "AltName,MainName\n..." }
router.post('/mappings/csv', requireAuth, (req, res) => {
  const { csvText } = req.body;
  if (!csvText) return res.status(400).json({ error: 'csvText required' });

  const lines = csvText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  let imported = 0;
  const errors = [];

  // Parse all lines first so we don't wipe the DB if the CSV is malformed
  const rows = [];
  for (const line of lines) {
    const commaIdx = line.indexOf(',');
    if (commaIdx < 1) { errors.push(`Bad format: "${line}"`); continue; }
    const altName  = line.slice(0, commaIdx).trim();
    const mainName = line.slice(commaIdx + 1).trim();
    if (!altName || !mainName) { errors.push(`Empty field: "${line}"`); continue; }
    rows.push({ altName, mainName });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'No valid rows found in CSV', errors });
  }

  const corpId = req.session.corporationId;

  // Overwrite: delete all existing mappings for this corp then insert the new set atomically
  const doImport = db.transaction(() => {
    db.prepare('DELETE FROM alt_mappings WHERE corporation_id = ?').run(corpId);
    const stmt = db.prepare(`
      INSERT INTO alt_mappings (character_id, character_name, main_name, corporation_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        character_name   = excluded.character_name,
        main_name        = excluded.main_name,
        corporation_id   = excluded.corporation_id
    `);
    for (const { altName, mainName } of rows) {
      const cached = db.prepare('SELECT id FROM name_cache WHERE LOWER(name) = LOWER(?)').get(altName);
      const charId = cached?.id || -(Math.abs(hashStr(altName)) % 999_999_998 + 1);
      stmt.run(charId, altName, mainName, corpId);
      imported++;
    }
  });
  doImport();

  res.json({ ok: true, imported, errors: errors.slice(0, 20) });
});

// GET /api/settings/discord
router.get('/discord', requireAuth, (req, res) => {
  res.json({ webhookUrl: getSetting('discord_webhook_url', '') });
});

// POST /api/settings/discord
router.post('/discord', requireAuth, (req, res) => {
  const { webhookUrl } = req.body;
  if (webhookUrl === undefined) return res.status(400).json({ error: 'webhookUrl required' });
  setSetting('discord_webhook_url', String(webhookUrl || ''));
  res.json({ ok: true });
});

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return Math.abs(h);
}

module.exports = router;
