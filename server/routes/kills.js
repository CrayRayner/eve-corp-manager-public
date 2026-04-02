'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../auth');
const { db } = require('../db');

function currentPeriod() { return new Date().toISOString().slice(0, 7); }

function nextMonthStart(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return next + '-01T00:00:00Z';
}

// GET /api/kills — top killers + recent kills for a period
// Default (no period or period=rolling30) → rolling last 30 days, consistent
// with the wallet/taxpayer tab. Pass a YYYY-MM period for a specific month.
router.get('/', requireAuth, (req, res) => {
  const reqPeriod = req.query.period;
  const isRolling = !reqPeriod || reqPeriod === 'rolling30';

  let startDate, endDate, periodLabel;
  if (isRolling) {
    const now  = new Date();
    const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    startDate   = past.toISOString();
    endDate     = now.toISOString();
    periodLabel = 'Last 30 days';
  } else {
    startDate   = reqPeriod + '-01T00:00:00Z';
    endDate     = nextMonthStart(reqPeriod);
    periodLabel = reqPeriod;
  }

  // Get our corp ID so we only count OUR members, not allied pilots on the kill
  const corpId = req.session.corporationId;

  const kills = db.prepare(`
    SELECT * FROM corp_kills
    WHERE kill_time >= ? AND kill_time < ? AND corporation_id = ?
    ORDER BY kill_time DESC
  `).all(startDate, endDate, corpId);

  // Tally kills per main character — count each kill only ONCE per main
  // Only count attackers who belong to our corporation
  const byMain = {};
  for (const k of kills) {
    let attackers;
    try { attackers = JSON.parse(k.attackers_json || '[]'); } catch { attackers = []; }

    // Collect unique mains from OUR corp only on this kill; track the ship each used
    const mainsThisKill = new Set();
    const mainShipThisKill = {}; // mainName -> ship_type_id on this kill
    for (const a of attackers) {
      if (!a.character_id) continue;
      // Skip pilots not in our corp (allied fleetmates, etc.)
      if (corpId && a.corporation_id !== corpId) continue;

      const mapping  = db.prepare('SELECT main_name FROM alt_mappings WHERE character_id = ? AND corporation_id = ?').get(a.character_id, corpId);
      const cached   = db.prepare('SELECT name FROM name_cache WHERE id = ?').get(a.character_id);
      const mainName = mapping?.main_name || cached?.name || `ID:${a.character_id}`;
      mainsThisKill.add(mainName);
      if (a.ship_type_id) mainShipThisKill[mainName] = a.ship_type_id;
    }

    // Credit each unique main once for this kill
    for (const mainName of mainsThisKill) {
      if (!byMain[mainName]) byMain[mainName] = { mainName, kills: 0, totalValue: 0, shipCounts: {} };
      byMain[mainName].kills++;
      byMain[mainName].totalValue += k.total_value || 0;
      const sid = mainShipThisKill[mainName];
      if (sid) byMain[mainName].shipCounts[sid] = (byMain[mainName].shipCounts[sid] || 0) + 1;
    }
  }

  const top10 = Object.values(byMain).sort((a, b) => b.kills - a.kills).slice(0, 10).map(m => {
    // Find most-used ship type
    let favShipTypeId = null, maxCount = 0;
    for (const [tid, cnt] of Object.entries(m.shipCounts || {})) {
      if (cnt > maxCount) { maxCount = cnt; favShipTypeId = parseInt(tid, 10); }
    }
    let favShipName = null;
    if (favShipTypeId) {
      const nc = db.prepare('SELECT name FROM name_cache WHERE id = ?').get(favShipTypeId);
      favShipName = nc?.name || null;
    }
    return { mainName: m.mainName, kills: m.kills, totalValue: m.totalValue, favShipTypeId, favShipName };
  });

  const recent = kills.slice(0, 50).map(k => ({
    killId:     k.kill_id,
    killTime:   k.kill_time,
    victimShip: k.victim_ship_name,
    systemName: k.solar_system_name,
    totalValue: k.total_value,
  }));

  const periods = [
    'rolling30',
    ...db.prepare(
      `SELECT DISTINCT substr(kill_time, 1, 7) AS p FROM corp_kills WHERE corporation_id = ? ORDER BY p DESC LIMIT 12`
    ).all(corpId).map(r => r.p),
  ];

  const totalIskDestroyed = kills.reduce((s, k) => s + (k.total_value || 0), 0);
  res.json({ top10, recentKills: recent, totalKills: kills.length, totalIskDestroyed, period: reqPeriod || 'rolling30', periodLabel, periods });
});

// GET /api/kills/history — per-period totals (kills count + ISK destroyed) for history chart
// Returns calendar months that have at least one kill in corp_kills.
router.get('/history', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  const rows = db.prepare(`
    SELECT
      substr(kill_time, 1, 7) AS period,
      COUNT(*) AS kills,
      COALESCE(SUM(total_value), 0) AS iskDestroyed
    FROM corp_kills
    WHERE corporation_id = ?
    GROUP BY substr(kill_time, 1, 7)
    ORDER BY period ASC
  `).all(corpId);
  res.json({ history: rows });
});

// Capsule type IDs — never count these as "favourite lost ship"
const CAPSULE_TYPE_IDS = new Set([670, 33328]);

// GET /api/kills/losses — top losers + recent losses for a period
router.get('/losses', requireAuth, (req, res) => {
  const reqPeriod = req.query.period;
  const isRolling = !reqPeriod || reqPeriod === 'rolling30';

  let startDate, endDate;
  if (isRolling) {
    const now  = new Date();
    const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    startDate = past.toISOString();
    endDate   = now.toISOString();
  } else {
    startDate = reqPeriod + '-01T00:00:00Z';
    endDate   = nextMonthStart(reqPeriod);
  }

  const corpId = req.session.corporationId;
  const losses = db.prepare(`
    SELECT * FROM corp_losses
    WHERE kill_time >= ? AND kill_time < ? AND corporation_id = ?
    ORDER BY kill_time DESC
  `).all(startDate, endDate, corpId);

  // Tally losses per main character
  const byMain = {};
  for (const l of losses) {
    if (!l.victim_char_id) continue;
    const mapping  = db.prepare('SELECT main_name FROM alt_mappings WHERE character_id = ? AND corporation_id = ?').get(l.victim_char_id, corpId);
    const cached   = db.prepare('SELECT name FROM name_cache WHERE id = ?').get(l.victim_char_id);
    const mainName = mapping?.main_name || cached?.name || l.victim_char_name || `ID:${l.victim_char_id}`;

    if (!byMain[mainName]) byMain[mainName] = { mainName, losses: 0, totalValue: 0, shipCounts: {} };
    byMain[mainName].losses++;
    byMain[mainName].totalValue += l.total_value || 0;
    // Exclude capsules — they're not meaningful as "favourite lost ship"
    if (l.victim_ship_id && !CAPSULE_TYPE_IDS.has(l.victim_ship_id)) {
      byMain[mainName].shipCounts[l.victim_ship_id] = (byMain[mainName].shipCounts[l.victim_ship_id] || 0) + 1;
    }
  }

  const top10 = Object.values(byMain).sort((a, b) => b.losses - a.losses).slice(0, 10).map(m => {
    let favShipTypeId = null, maxCount = 0;
    for (const [tid, cnt] of Object.entries(m.shipCounts || {})) {
      if (cnt > maxCount) { maxCount = cnt; favShipTypeId = parseInt(tid, 10); }
    }
    let favShipName = null;
    if (favShipTypeId) {
      const nc = db.prepare('SELECT name FROM name_cache WHERE id = ?').get(favShipTypeId);
      favShipName = nc?.name || null;
    }
    return { mainName: m.mainName, losses: m.losses, totalValue: m.totalValue, favShipTypeId, favShipName };
  });

  const recentLosses = losses.slice(0, 50).map(l => {
    const cached = l.victim_char_id ? db.prepare('SELECT name FROM name_cache WHERE id = ?').get(l.victim_char_id) : null;
    return {
      killId:     l.kill_id,
      killTime:   l.kill_time,
      victimName: cached?.name || l.victim_char_name || null,
      shipName:   l.victim_ship_name,
      systemName: l.solar_system_name,
      totalValue: l.total_value,
    };
  });

  res.json({ top10, recentLosses, totalLosses: losses.length });
});

// POST /api/kills/sync — manually trigger zKillboard sync
router.post('/sync', requireAuth, async (req, res) => {
  const corpId = req.session.corporationId;
  if (!corpId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { syncKills } = require('../scheduler');
    syncKills(corpId).catch(e => console.error('[Kills] Manual sync error:', e.message));
    res.json({ ok: true, message: 'Kill sync started in background' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
