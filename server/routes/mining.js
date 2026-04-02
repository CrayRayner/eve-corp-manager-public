'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../auth');
const { db, getSetting } = require('../db');

function currentPeriod() { return new Date().toISOString().slice(0, 7); }

function rolling30Cutoff() {
  return new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
}

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// GET /api/mining — corp mining ledger for a period, grouped by main character
// period: YYYY-MM (calendar month), "rolling30" (last 30 days), or "last3" (aggregate of last 3 months)
router.get('/', requireAuth, (req, res) => {
  const periodParam = req.query.period || currentPeriod();
  const corpId = req.session.corporationId;
  let period = periodParam;
  let dateClause = 'ml.date LIKE ? || \'%\'';
  const dateArgs = [];

  if (periodParam === 'last3') {
    const d = new Date();
    const months = [];
    for (let i = 0; i < 3; i++) {
      months.push(d.toISOString().slice(0, 7));
      d.setMonth(d.getMonth() - 1);
    }
    dateClause = months.map(() => 'ml.date LIKE ? || \'%\'').join(' OR ');
    dateArgs.push(...months);
    period = `${months[2]} to ${months[0]}`;
  } else if (periodParam === 'rolling30') {
    dateClause = 'ml.date >= ?';
    dateArgs.push(rolling30Cutoff());
    period = 'Last 30 days';
  } else {
    dateArgs.push(periodParam);
  }

  const rows = db.prepare(`
    SELECT
      COALESCE(am.main_name, ml.character_name, 'ID:'||ml.character_id) AS main_name,
      ml.type_id,
      COALESCE(nc.name, ml.type_name, 'Type '||ml.type_id) AS type_name,
      SUM(ml.quantity) AS quantity
    FROM mining_ledger ml
    LEFT JOIN alt_mappings am ON am.character_id = ml.character_id AND am.corporation_id = ml.corporation_id
    LEFT JOIN name_cache nc ON nc.id = ml.type_id
    WHERE (${dateClause}) AND ml.corporation_id = ?
    GROUP BY COALESCE(am.main_name, ml.character_name, 'ID:'||ml.character_id), ml.type_id
    ORDER BY COALESCE(am.main_name, ml.character_name, 'ID:'||ml.character_id), quantity DESC
  `).all(...dateArgs, corpId);

  // Group by main
  const byMain = {};
  for (const r of rows) {
    if (!byMain[r.main_name]) {
      byMain[r.main_name] = { mainName: r.main_name, materials: [], totalQty: 0, totalValue: 0 };
    }
    const price     = db.prepare('SELECT jita_buy_max, average_price FROM market_prices WHERE type_id = ?').get(r.type_id);
    const unitPrice = price?.jita_buy_max || price?.average_price || 0;
    const value     = Math.round(r.quantity * unitPrice);
    byMain[r.main_name].materials.push({ typeName: r.type_name, typeId: r.type_id, quantity: r.quantity, unitPrice, value });
    byMain[r.main_name].totalQty   += r.quantity;
    byMain[r.main_name].totalValue += value;
  }

  const miners  = Object.values(byMain).sort((a, b) => b.totalValue - a.totalValue);

  // By type aggregate (for "Mining by ore type" section)
  const byType = {};
  for (const r of rows) {
    const key = r.type_id;
    if (!byType[key]) {
      const price = db.prepare('SELECT jita_buy_max, average_price FROM market_prices WHERE type_id = ?').get(r.type_id);
      const unitPrice = price?.jita_buy_max || price?.average_price || 0;
      byType[key] = { typeId: r.type_id, typeName: r.type_name, quantity: 0, unitPrice, value: 0 };
    }
    byType[key].quantity += r.quantity;
    byType[key].value += Math.round(r.quantity * byType[key].unitPrice);
  }
  const byTypeList = Object.values(byType).sort((a, b) => b.quantity - a.quantity);

  const periods = db.prepare(
    `SELECT DISTINCT substr(date, 1, 7) AS p FROM mining_ledger WHERE corporation_id = ? ORDER BY p DESC LIMIT 12`
  ).all(corpId).map(r => r.p);
  if (!periods.includes('last3')) periods.unshift('last3');
  if (!periods.includes('rolling30')) periods.unshift('rolling30');

  res.json({ miners, period, periods, totalMiners: miners.length, byType: byTypeList });
});

// GET /api/mining/top — top 10 miners this period by total quantity (for overview)
router.get('/top', requireAuth, (req, res) => {
  const period = req.query.period || currentPeriod();
  const corpId = req.session.corporationId;
  const rows = db.prepare(`
    SELECT
      COALESCE(am.main_name, ml.character_name, 'ID:'||ml.character_id) AS main_name,
      SUM(ml.quantity) AS total_quantity
    FROM mining_ledger ml
    LEFT JOIN alt_mappings am ON am.character_id = ml.character_id AND am.corporation_id = ml.corporation_id
    WHERE ml.date LIKE ? || '%' AND ml.corporation_id = ?
    GROUP BY COALESCE(am.main_name, ml.character_name, 'ID:'||ml.character_id)
    ORDER BY total_quantity DESC
    LIMIT 10
  `).all(period, corpId);
  res.json(rows);
});

/**
 * GET /api/mining/export?period=YYYY-MM
 * Returns CSV of mining ledger for the period (all characters, one row per character/type/date or aggregated by period).
 * We export per-period aggregated by main, type: Main Name, Character Name, Type Name, Quantity, Period.
 */
router.get('/export', requireAuth, (req, res) => {
  const period = req.query.period || currentPeriod();
  const exportPeriod = period === 'last3' || period === 'rolling30' ? currentPeriod() : period;
  const corpId = req.session.corporationId;

  const dateClause = period === 'rolling30' ? 'ml.date >= ?' : 'ml.date LIKE ? || \'%\'';
  const dateArg = period === 'rolling30' ? rolling30Cutoff() : exportPeriod;

  const rows = db.prepare(`
    SELECT
      COALESCE(am.main_name, ml.character_name, 'ID:'||ml.character_id) AS main_name,
      ml.character_name,
      ml.type_id,
      COALESCE(nc.name, ml.type_name, 'Type '||ml.type_id) AS type_name,
      SUM(ml.quantity) AS quantity
    FROM mining_ledger ml
    LEFT JOIN alt_mappings am ON am.character_id = ml.character_id AND am.corporation_id = ml.corporation_id
    LEFT JOIN name_cache nc ON nc.id = ml.type_id
    WHERE ${dateClause} AND ml.corporation_id = ?
    GROUP BY COALESCE(am.main_name, ml.character_name, 'ID:'||ml.character_id), ml.character_name, ml.type_id
    ORDER BY main_name, type_name, quantity DESC
  `).all(dateArg, corpId);

  const header = 'Main Name,Character Name,Type ID,Type Name,Quantity';
  const lines = [header, ...rows.map(r =>
    [r.main_name, r.character_name, r.type_id, r.type_name, r.quantity].map(csvEscape).join(',')
  )];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  const filename = period === 'rolling30' ? 'mining-ledger-rolling30.csv' : `mining-ledger-${exportPeriod}.csv`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\r\n'));
});

/** GET /api/mining/expected-tax?period=... — expected tax from mining = tax rate % of mined VOLUME (value in ISK for comparison) */
const TAX_REF_TYPES = [
  'bounty_prizes', 'ess_escrow_transfer', 'agent_mission_reward',
  'industry_job_tax', 'daily_goal_payouts',
];
router.get('/expected-tax', requireAuth, (req, res) => {
  const period = req.query.period || currentPeriod();
  const corpId = req.session.corporationId;
  const taxRate = getSetting('corp_mining_tax_rate');
  const taxPercent = taxRate != null && taxRate !== '' ? parseFloat(taxRate) : null;

  let dateClause, dateArgs;
  if (period === 'last3') {
    const d = new Date();
    const months = [];
    for (let i = 0; i < 3; i++) {
      months.push(d.toISOString().slice(0, 7));
      d.setMonth(d.getMonth() - 1);
    }
    dateClause = months.map(() => 'ml.date LIKE ? || \'%\'').join(' OR ');
    dateArgs = months;
  } else if (period === 'rolling30') {
    dateClause = 'ml.date >= ?';
    dateArgs = [rolling30Cutoff()];
  } else {
    dateClause = 'ml.date LIKE ? || \'%\'';
    dateArgs = [period];
  }

  const miningRow = db.prepare(`
    SELECT
      COALESCE(SUM(ml.quantity), 0) AS total_volume,
      COALESCE(SUM(ml.quantity * COALESCE(mp.jita_buy_max, mp.average_price, 0)), 0) AS total_value
    FROM mining_ledger ml
    LEFT JOIN market_prices mp ON mp.type_id = ml.type_id
    WHERE (${dateClause}) AND ml.corporation_id = ?
  `).get(...dateArgs, corpId);
  const totalMiningVolume = miningRow?.total_volume || 0;
  const totalMiningValue = miningRow?.total_value || 0;

  let actualTaxReceived = 0;
  if (period === 'rolling30') {
    const cutoff = rolling30Cutoff();
    const row = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_journal
      WHERE division = 1 AND date >= ?
        AND ref_type IN (${TAX_REF_TYPES.map(() => '?').join(',')})
        AND amount > 0
        AND corporation_id = ?
    `).get(cutoff, ...TAX_REF_TYPES, corpId);
    actualTaxReceived = row?.total || 0;
  } else if (period === 'last3') {
    const d = new Date();
    const months = [];
    for (let i = 0; i < 3; i++) {
      months.push(d.toISOString().slice(0, 7));
      d.setMonth(d.getMonth() - 1);
    }
    const row = db.prepare('SELECT COALESCE(SUM(total_amount), 0) AS total FROM tax_summary WHERE period IN (?, ?, ?) AND corporation_id = ?').get(...months, corpId);
    actualTaxReceived = row?.total || 0;
  } else {
    const actualTaxRow = db.prepare('SELECT COALESCE(SUM(total_amount), 0) AS total FROM tax_summary WHERE period = ? AND corporation_id = ?').get(period, corpId);
    actualTaxReceived = actualTaxRow?.total || 0;
  }

  // Tax is X% of mined VOLUME. Expected tax volume = total_volume * (rate/100).
  // Value of that volume at Jita (for comparison with actual tax received in ISK):
  const expectedTaxVolume = taxPercent != null ? totalMiningVolume * taxPercent / 100 : null;
  const expectedTaxFromMiningISK = taxPercent != null ? totalMiningValue * taxPercent / 100 : null;

  res.json({
    period: period === 'rolling30' ? 'Last 30 days' : period,
    totalMiningVolume,
    totalMiningValue,
    taxRatePercent: taxPercent,
    expectedTaxVolume,
    expectedTaxFromMining: expectedTaxFromMiningISK,
    actualTaxReceived,
  });
});

module.exports = router;
