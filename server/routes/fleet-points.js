'use strict';
const express       = require('express');
const router        = express.Router();
const { requireAuth } = require('../auth');
const { db }        = require('../db');

// GET /api/fleet-points/months — list months that have data for this corp
router.get('/months', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  const rows = db.prepare(
    'SELECT DISTINCT period_month FROM fleet_points WHERE corporation_id = ? ORDER BY period_month DESC'
  ).all(corpId);
  res.json(rows.map(r => r.period_month));
});

// GET /api/fleet-points?month=YYYY-MM — entries for a specific month
router.get('/', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });
  const rows = db.prepare(
    'SELECT character_name, fat_count, pap_count FROM fleet_points WHERE corporation_id = ? AND period_month = ? ORDER BY character_name'
  ).all(corpId, month);
  res.json(rows);
});

// POST /api/fleet-points/csv — import CSV for a month (replaces existing data for that month)
// Body: { month: 'YYYY-MM', csvText: 'CharacterName,FAT,PAP\n...' }
router.post('/csv', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  const { month, csvText } = req.body;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month required in YYYY-MM format' });
  if (!csvText) return res.status(400).json({ error: 'csvText required' });

  const lines  = csvText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const rows   = [];
  const errors = [];

  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 2) { errors.push(`Skipped: "${line}"`); continue; }
    const name = parts[0].trim();
    const fat  = parseInt(parts[1], 10) || 0;
    const pap  = parts.length >= 3 ? (parseInt(parts[2], 10) || 0) : 0;
    if (!name) { errors.push(`Skipped: "${line}"`); continue; }
    rows.push({ name, fat, pap });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM fleet_points WHERE corporation_id = ? AND period_month = ?').run(corpId, month);
    const ins = db.prepare(
      'INSERT INTO fleet_points (corporation_id, period_month, character_name, fat_count, pap_count) VALUES (?, ?, ?, ?, ?)'
    );
    for (const { name, fat, pap } of rows) ins.run(corpId, month, name, fat, pap);
  })();

  res.json({ ok: true, month, imported: rows.length, errors: errors.slice(0, 20) });
});

// DELETE /api/fleet-points/:month — remove all entries for a month
router.delete('/:month', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  db.prepare('DELETE FROM fleet_points WHERE corporation_id = ? AND period_month = ?').run(corpId, req.params.month);
  res.json({ ok: true });
});

module.exports = router;
