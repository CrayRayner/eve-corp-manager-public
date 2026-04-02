'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../auth');
const { db, getToken, getSetting } = require('../db');

const METENOX_TYPE_ID   = 81826;
const MONTHLY_FUEL_COST = 285_772_000;

// GET /api/summary — all KPIs for the overview tab
router.get('/summary', requireAuth, (req, res) => {
  const token  = getToken(req.session.characterId);
  const corpId = token?.corporation_id || req.session.corporationId;

  // Active members (from sync'd member tracking)
  const memberStatRow = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN days_since < 30 THEN 1 ELSE 0 END) AS active
    FROM (
      SELECT (julianday('now') - julianday(logon_date)) AS days_since
      FROM member_tracking
      WHERE corporation_id = ?
    )
  `).get(corpId);
  const memberStats = { total: memberStatRow?.total || 0, active: memberStatRow?.active || 0 };

  // Metenox total monthly profit estimate
  const metenoxCount = db.prepare('SELECT COUNT(*) AS c FROM structures WHERE type_id = ? AND corporation_id = ?').get(METENOX_TYPE_ID, corpId)?.c || 0;
  const priceRows    = db.prepare('SELECT COUNT(*) AS c FROM market_prices').get();
  const metenoxProfit = metenoxCount * MONTHLY_FUEL_COST; // placeholder; real calc in /api/metenox

  // Top tax payer this month
  const period = currentPeriod();
  const topTax = db.prepare(`
    SELECT main_name, SUM(total_amount) AS total
    FROM tax_summary WHERE period = ? AND corporation_id = ?
    GROUP BY main_name ORDER BY total DESC LIMIT 1
  `).get(period, corpId);

  // Wallet balances — read from values stored by syncWallet via /corporations/{id}/wallets/
  // This endpoint returns accurate live balances, avoiding journal running-balance quirks.
  const walletDivisions = [];
  for (let div = 1; div <= 7; div++) {
    const stored = getSetting(`wallet_balance_${corpId}_${div}`);
    if (stored !== null) {
      const balance = parseFloat(stored);
      if (!isNaN(balance)) walletDivisions.push({ division: div, balance: Math.round(balance) });
    }
  }
  const walletTotal = walletDivisions.reduce((s, r) => s + r.balance, 0);

  // Structure count
  const structCount = db.prepare('SELECT COUNT(*) AS c FROM structures WHERE corporation_id = ?').get(corpId)?.c || 0;

  // Corp equity change = current month wallet total minus previous month total
  // Computed live from wallet_division_history so it doesn't depend on snapshots.
  const recentTotals = db.prepare(`
    SELECT month, SUM(balance) AS total
    FROM wallet_division_history WHERE corporation_id = ?
    GROUP BY month ORDER BY month DESC LIMIT 2
  `).all(corpId);
  let corpEquity = 0;
  if (recentTotals.length >= 2) {
    corpEquity = (recentTotals[0].total || 0) - (recentTotals[1].total || 0);
  }

  // Mining this month (for overview at-a-glance)
  const miningThisMonth = db.prepare(`
    SELECT COUNT(DISTINCT main_name) AS pilots, COALESCE(SUM(quantity), 0) AS units
    FROM mining_ledger WHERE substr(date, 1, 7) = ? AND corporation_id = ?
  `).get(period, corpId);

  // Kills this month (for overview at-a-glance)
  const monthStart = period + '-01T00:00:00Z';
  const monthEnd   = period === currentPeriod() ? new Date().toISOString() : nextMonthStart(period);
  const killsThisMonthRow = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(total_value), 0) AS isk
    FROM corp_kills WHERE kill_time >= ? AND kill_time < ? AND corporation_id = ?
  `).get(monthStart, monthEnd, corpId);

  res.json({
    corporationName:  token?.corporation_name || 'Your Corporation',
    walletBalance:    Math.round(walletTotal),
    walletDivisions:  walletDivisions,
    corpEquity,
    activeMembers:   memberStats.active || 0,
    totalMembers:    memberStats.total  || 0,
    structureCount:  structCount,
    metenoxCount,
    topTaxPayer:     topTax?.main_name || null,
    period,
    miningPilotsThisMonth:  miningThisMonth?.pilots || 0,
    miningUnitsThisMonth:   miningThisMonth?.units || 0,
    killsThisMonth:        killsThisMonthRow?.n ?? 0,
    iskDestroyedThisMonth:  killsThisMonthRow?.isk ?? 0,
  });
});

// GET /api/snapshots — last 6 monthly snapshots for trend charts
router.get('/snapshots', requireAuth, (req, res) => {
  const token  = getToken(req.session.characterId);
  const corpId = token?.corporation_id || req.session.corporationId;
  const rows = db.prepare('SELECT * FROM monthly_snapshots WHERE corporation_id = ? ORDER BY month DESC LIMIT 6').all(corpId)
    .reverse();
  res.json(rows);
});

// POST /api/snapshots/create — manual snapshot trigger
router.post('/snapshots/create', requireAuth, async (req, res) => {
  try {
    const { createMonthlySnapshot } = require('../scheduler');
    const characterId = req.session.characterId;
    await createMonthlySnapshot(characterId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function currentPeriod() { return new Date().toISOString().slice(0, 7); }
function nextMonthStart(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return next + 'T00:00:00Z';
}

module.exports = router;
