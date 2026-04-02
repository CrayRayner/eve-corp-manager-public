'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../auth');
const { db, getSetting } = require('../db');

// Ref types we count as "tax-generating" income from members.
// Deliberately excludes: transaction_tax (corp's own broker fees — expense),
// market_transaction (corp's own market activity), contract_price_payment_corp
// (corp-level income, not member tax), bounty_prize (singular — player bounty
// claims, not NPC ratting tax).
const TAX_REF_TYPES = [
  'bounty_prizes',        // NPC bounty tax + ESS regular payouts
  'ess_escrow_transfer',  // ESS reserve bank payouts
  'agent_mission_reward', // mission runner tax
  'industry_job_tax',     // manufacturing / research job tax
  'daily_goal_payouts',   // AIR Daily Goals (500k ISK reward × corp tax rate)
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve a character ID to { charName, mainName } using the DB cache */
function resolveChar(charId, corpId) {
  const nameRow = db.prepare('SELECT name FROM name_cache WHERE id = ?').get(charId);
  const mapping = db.prepare('SELECT main_name FROM alt_mappings WHERE character_id = ? AND corporation_id = ?').get(charId, corpId);
  const charName = nameRow?.name || `ID:${charId}`;
  return { charName, mainName: mapping?.main_name || charName };
}

/** Escape a value for CSV (wrap in quotes if contains comma, quote, or newline) */
function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Compute rolling 30-day taxpayer list directly from wallet_journal (division 1 only).
 * Groups alts into their main character and returns sorted array.
 */
function computeRollingTaxpayers(corpId) {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const rawRows = db.prepare(`
    SELECT second_party_id, SUM(amount) AS total
    FROM wallet_journal
    WHERE date >= ?
      AND division = 1
      AND second_party_id IS NOT NULL
      AND ref_type IN (${TAX_REF_TYPES.map(() => '?').join(',')})
      AND amount > 0
      AND corporation_id = ?
    GROUP BY second_party_id
  `).all(cutoff, ...TAX_REF_TYPES, corpId);

  // Aggregate individual alts into their main character
  const byMain = {};
  for (const r of rawRows) {
    const { charName, mainName } = resolveChar(r.second_party_id, corpId);
    if (!byMain[mainName]) {
      byMain[mainName] = { character_name: charName, main_name: mainName, total_amount: 0 };
    }
    byMain[mainName].total_amount += r.total;
  }

  return Object.values(byMain).sort((a, b) => b.total_amount - a.total_amount);
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/wallet/taxpayers?limit=5&period=2026-03
 * Default (no period or period=rolling): rolling 30-day window from wallet_journal (live).
 * With period=YYYY-MM: historical month from pre-computed tax_summary.
 */
router.get('/taxpayers', requireAuth, (req, res) => {
  const period = req.query.period;
  const limit  = parseInt(req.query.limit || '5', 10);
  const corpId = req.session.corporationId;

  if (period && period !== 'rolling') {
    // Historical month from pre-computed tax_summary
    const summary = db.prepare(`
      SELECT main_name AS character_name, main_name, SUM(total_amount) AS total_amount
      FROM tax_summary WHERE period = ? AND corporation_id = ?
      GROUP BY main_name
      ORDER BY total_amount DESC LIMIT ?
    `).all(period, corpId, limit);
    return res.json({ period, data: summary });
  }

  // Rolling 30 days (default) — computed live, aggregated by main
  const data = computeRollingTaxpayers(corpId).slice(0, limit);
  res.json({ period: 'rolling', data });
});

/** GET /api/wallet/rates — corp ISK tax % (from settings, for display) */
router.get('/rates', requireAuth, (req, res) => {
  const taxRate = getSetting('corp_tax_rate');
  res.json({
    taxRatePercent: taxRate != null && taxRate !== '' ? parseFloat(taxRate) : null,
  });
});

/**
 * GET /api/wallet/monthly-flow?months=12
 * Income vs expenses vs net per calendar month for the last N months.
 * Covers all wallet divisions (matches multi-pnl consolidated view).
 * Excludes same-corp corporation_account_withdrawal (inter-division transfers).
 */
router.get('/monthly-flow', requireAuth, (req, res) => {
  const rawMonths = parseInt(req.query.months || '12', 10);
  const corpId = req.session.corporationId;

  // months=0 means "all available data"
  let cutoff;
  if (rawMonths === 0) {
    cutoff = '2000-01';
  } else {
    const months = Math.min(60, Math.max(1, rawMonths));
    const d = new Date();
    d.setMonth(d.getMonth() - months + 1);
    cutoff = d.toISOString().slice(0, 7);
  }

  const rows = db.prepare(`
    SELECT
      substr(date, 1, 7) AS month,
      SUM(CASE WHEN amount > 0 THEN amount      ELSE 0 END) AS income,
      SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS expenses
    FROM wallet_journal
    WHERE substr(date, 1, 7) >= ?
      AND corporation_id = ?
      AND NOT (
        ref_type = 'corporation_account_withdrawal'
        AND (second_party_id = ? OR second_party_id IS NULL)
      )
    GROUP BY month
    ORDER BY month ASC
  `).all(cutoff, corpId, corpId);

  res.json(rows.map(r => ({
    month:    r.month,
    income:   Math.round(r.income   || 0),
    expenses: Math.round(r.expenses || 0),
    net:      Math.round((r.income  || 0) - (r.expenses || 0)),
  })));
});

/**
 * GET /api/wallet/journal?page=1&type=all&period=2026-03&search=Name
 * Always returns Master Wallet (division 1) entries only.
 * search: optional; filter by first_party or second_party name/ID (via name_cache or ID match).
 */
router.get('/journal', requireAuth, (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit  = 50;
  const offset = (page - 1) * limit;
  const period = req.query.period || null;
  const type   = req.query.type   || 'all';
  const search = (req.query.search || '').trim();
  const corpId = req.session.corporationId;

  // Always division 1 (Master Wallet) — other divisions are inter-division transfers etc.
  let where = 'division = 1 AND corporation_id = ?';
  const args = [corpId];

  if (period) { where += ' AND date LIKE ?'; args.push(period + '%'); }
  if (type !== 'all') { where += ' AND ref_type = ?'; args.push(type); }

  if (search) {
    // Resolve search to character/corp IDs from name_cache (LIKE)
    const escaped = search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const like = '%' + escaped + '%';
    const ids = db.prepare("SELECT id FROM name_cache WHERE name LIKE ? ESCAPE '\\'").all(like);
    const idList = ids.map(r => r.id);
    if (idList.length) {
      const placeholders = idList.map(() => '?').join(',');
      where += ` AND (first_party_id IN (${placeholders}) OR second_party_id IN (${placeholders}))`;
      args.push(...idList, ...idList);
    } else {
      // Try numeric ID
      const num = parseInt(search, 10);
      if (!isNaN(num)) {
        where += ' AND (first_party_id = ? OR second_party_id = ?)';
        args.push(num, num);
      } else {
        // No match — return empty
        where += ' AND 0';
      }
    }
  }

  const total = db.prepare(`SELECT COUNT(*) AS c FROM wallet_journal WHERE ${where}`).get(...args).c;
  const rows  = db.prepare(`
    SELECT * FROM wallet_journal WHERE ${where}
    ORDER BY date DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);

  res.json({ total, page, pages: Math.ceil(total / limit), rows });
});

/**
 * GET /api/wallet/history?days=30
 * Returns the end-of-day running balance for division 1 (Master Wallet) per day.
 * Uses the most recent journal entry per day (MAX journal_id per day, div=1).
 */
router.get('/history', requireAuth, (req, res) => {
  const days   = parseInt(req.query.days || '30', 10);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const corpId = req.session.corporationId;

  // Inner join to get only the LAST entry per day for division 1
  const rows = db.prepare(`
    SELECT date(w.date) AS day, w.balance
    FROM wallet_journal w
    INNER JOIN (
      SELECT date(date) AS d, MAX(journal_id) AS max_id
      FROM wallet_journal
      WHERE division = 1 AND date >= ? AND balance IS NOT NULL AND corporation_id = ?
      GROUP BY d
    ) latest ON date(w.date) = latest.d AND w.journal_id = latest.max_id
    WHERE w.corporation_id = ?
    ORDER BY day ASC
  `).all(cutoff, corpId, corpId);

  res.json(rows);
});

/**
 * GET /api/wallet/groups?period=
 * Tax totals grouped by main character for the donut chart.
 * Default: rolling 30 days. With period=YYYY-MM: historical from tax_summary.
 */
router.get('/groups', requireAuth, (req, res) => {
  const period = req.query.period;
  const corpId = req.session.corporationId;

  if (period && period !== 'rolling') {
    const rows = db.prepare(`
      SELECT main_name, SUM(total_amount) AS total
      FROM tax_summary WHERE period = ? AND corporation_id = ?
      GROUP BY main_name ORDER BY total DESC
    `).all(period, corpId);
    return res.json({ period, data: rows });
  }

  // Rolling 30 days
  const all  = computeRollingTaxpayers(corpId);
  const data = all.map(r => ({ main_name: r.main_name, total: r.total_amount }));
  res.json({ period: 'rolling', data });
});

/** GET /api/wallet/periods — available historical months in tax_summary */
router.get('/periods', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  const rows = db.prepare('SELECT DISTINCT period FROM tax_summary WHERE corporation_id = ? ORDER BY period DESC').all(corpId);
  res.json(rows.map(r => r.period));
});

/**
 * GET /api/wallet/journal/export?period=YYYY-MM&type=all&division=1
 * Returns CSV of wallet journal (division 1 by default). Limited to 10000 rows.
 */
router.get('/journal/export', requireAuth, (req, res) => {
  const period = req.query.period || null;
  const type   = req.query.type   || 'all';
  const division = parseInt(req.query.division || '1', 10);
  const corpId = req.session.corporationId;
  const limit  = 10000;

  let where = 'division = ? AND corporation_id = ?';
  const args = [division, corpId];
  if (period) { where += ' AND date LIKE ?'; args.push(period + '%'); }
  if (type !== 'all') { where += ' AND ref_type = ?'; args.push(type); }

  const rows = db.prepare(`
    SELECT date, division, ref_type, first_party_id, second_party_id, amount, balance, description
    FROM wallet_journal WHERE ${where}
    ORDER BY date DESC LIMIT ?
  `).all(...args, limit);

  const header = 'Date,Division,Ref Type,First Party ID,Second Party ID,Amount,Balance,Description';
  const lines = [header, ...rows.map(r =>
    [r.date, r.division, r.ref_type, r.first_party_id, r.second_party_id, r.amount, r.balance, r.description || ''].map(csvEscape).join(',')
  )];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="wallet-journal${period ? '-' + period : ''}.csv"`);
  res.send(lines.join('\r\n'));
});

/**
 * GET /api/wallet/tax-summary/export?period=YYYY-MM
 * Returns CSV of tax summary for the given month. If no period, exports all periods.
 */
router.get('/tax-summary/export', requireAuth, (req, res) => {
  const period = req.query.period || null;
  const corpId = req.session.corporationId;

  let rows;
  if (period) {
    rows = db.prepare(`
      SELECT period, character_id, character_name, main_name, total_amount
      FROM tax_summary WHERE period = ? AND corporation_id = ?
      ORDER BY total_amount DESC
    `).all(period, corpId);
  } else {
    rows = db.prepare(`
      SELECT period, character_id, character_name, main_name, total_amount
      FROM tax_summary WHERE corporation_id = ? ORDER BY period DESC, total_amount DESC
    `).all(corpId);
  }

  const header = 'Period,Character ID,Character Name,Main Name,Total Amount';
  const lines = [header, ...rows.map(r =>
    [r.period, r.character_id, r.character_name, r.main_name, r.total_amount].map(csvEscape).join(',')
  )];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tax-summary${period ? '-' + period : ''}.csv"`);
  res.send(lines.join('\r\n'));
});

/**
 * GET /api/wallet/pnl?period=YYYY-MM
 * Income vs expense breakdown for a given month (default: current month).
 * Income = positive amounts grouped by ref_type.
 * Expenses = negative amounts grouped by ref_type (returned as absolute values).
 */
router.get('/pnl', requireAuth, (req, res) => {
  const period = req.query.period || new Date().toISOString().slice(0, 7);
  const corpId = req.session.corporationId;

  const income = db.prepare(`
    SELECT ref_type, SUM(amount) AS total, COUNT(*) AS cnt
    FROM wallet_journal
    WHERE division = 1
      AND date LIKE ?
      AND amount > 0
      AND corporation_id = ?
    GROUP BY ref_type
    ORDER BY total DESC
  `).all(period + '%', corpId);

  const expenses = db.prepare(`
    SELECT ref_type, SUM(ABS(amount)) AS total, COUNT(*) AS cnt
    FROM wallet_journal
    WHERE division = 1
      AND date LIKE ?
      AND amount < 0
      AND corporation_id = ?
    GROUP BY ref_type
    ORDER BY total DESC
  `).all(period + '%', corpId);

  const totalIncome   = income.reduce((s, r) => s + r.total, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.total, 0);

  res.json({
    period,
    totalIncome,
    totalExpenses,
    netFlow: totalIncome - totalExpenses,
    income:   income.map(r => ({ refType: r.ref_type, total: r.total, count: r.cnt })),
    expenses: expenses.map(r => ({ refType: r.ref_type, total: r.total, count: r.cnt })),
  });
});

/**
 * GET /api/wallet/multi-pnl?period=YYYY-MM
 * T-account style P&L for wallet divisions 1, 2, 3.
 *
 * corporation_account_withdrawal comes in two flavours:
 *   • second_party_id = own corpId  → inter-division transfer (not a real P&L event)
 *   • second_party_id = another corp → ISK leaving the corporation (e.g. alliance tax) → REAL EXPENSE
 *
 * Each withdrawal is examined individually so the two cases are separated correctly
 * and individual transfers are shown as separate rows rather than lumped together.
 */
router.get('/multi-pnl', requireAuth, (req, res) => {
  const period = req.query.period || new Date().toISOString().slice(0, 7);
  const corpId = req.session.corporationId;

  const divisions = {};
  let realIncomeTotal  = 0;
  let realExpenseTotal = 0;

  for (let div = 1; div <= 7; div++) {
    // ── 1. All non-withdrawal ref_types — aggregate by ref_type as before ──
    const regularRows = db.prepare(`
      SELECT ref_type,
             SUM(CASE WHEN amount > 0 THEN amount      ELSE 0 END) AS credits,
             SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS debits,
             COUNT(*) AS cnt
      FROM wallet_journal
      WHERE division = ? AND date LIKE ? AND corporation_id = ?
        AND ref_type != 'corporation_account_withdrawal'
      GROUP BY ref_type
      HAVING credits > 0 OR debits > 0
      ORDER BY (credits + debits) DESC
    `).all(div, period + '%', corpId);

    // ── 2. corporation_account_withdrawal — one row per individual entry ──
    // This lets us classify each transfer as internal (same corp) or external
    // (different corp = real ISK leaving the corporation, e.g. alliance tax).
    const withdrawals = db.prepare(`
      SELECT second_party_id, amount
      FROM wallet_journal
      WHERE division = ? AND date LIKE ? AND corporation_id = ?
        AND ref_type = 'corporation_account_withdrawal'
      ORDER BY ABS(amount) DESC
    `).all(div, period + '%', corpId);

    const externalCredits = regularRows
      .filter(r => r.credits > 0)
      .map(r => ({ refType: r.ref_type, total: r.credits, count: r.cnt }));

    const externalDebits = regularRows
      .filter(r => r.debits > 0)
      .map(r => ({ refType: r.ref_type, total: r.debits, count: r.cnt }));

    const internalCredits = [];
    const internalDebits  = [];

    for (const w of withdrawals) {
      const isInternal = corpId
        ? (w.second_party_id === corpId || w.second_party_id === null)
        : w.second_party_id === null;

      if (isInternal) {
        // ISK moving between our own divisions — not a real P&L event
        const entry = { refType: 'inter_division_transfer', total: Math.abs(w.amount), count: 1 };
        if (w.amount >= 0) internalCredits.push(entry);
        else               internalDebits.push(entry);
      } else {
        // ISK leaving the corporation — real expense / income
        const nameRow = db.prepare('SELECT name FROM name_cache WHERE id = ?').get(w.second_party_id);
        const who     = nameRow?.name ?? `Corp ${w.second_party_id}`;
        const label   = w.amount < 0 ? `transfer_out_to_${who}` : `transfer_in_from_${who}`;
        const entry   = { refType: label, total: Math.abs(w.amount), count: 1 };
        if (w.amount >= 0) externalCredits.push(entry);
        else               externalDebits.push(entry);
      }
    }

    // Sort external lists largest first
    externalCredits.sort((a, b) => b.total - a.total);
    externalDebits.sort((a, b)  => b.total - a.total);

    const extIn  = externalCredits.reduce((s, r) => s + r.total, 0);
    const extOut = externalDebits.reduce((s, r)  => s + r.total, 0);
    const intIn  = internalCredits.reduce((s, r) => s + r.total, 0);
    const intOut = internalDebits.reduce((s, r)  => s + r.total, 0);

    realIncomeTotal  += extIn;
    realExpenseTotal += extOut;

    const balanceSetting = getSetting(`wallet_balance_${corpId}_${div}`);
    const currentBalance = balanceSetting !== null ? parseFloat(balanceSetting) : null;

    // Skip divisions with no activity this period and a zero (or unknown) balance
    const hasActivity = externalCredits.length || externalDebits.length ||
                        internalCredits.length || internalDebits.length;
    if (!hasActivity && !currentBalance) continue;

    divisions[div] = {
      name: `Division ${div}`,
      currentBalance,
      externalCredits,
      externalDebits,
      internalCredits,
      internalDebits,
      extIn, extOut, intIn, intOut,
      net: extIn - extOut + intIn - intOut,
    };
  }

  res.json({
    period,
    divisions,
    consolidated: {
      realIncome:   realIncomeTotal,
      realExpenses: realExpenseTotal,
      realNet:      realIncomeTotal - realExpenseTotal,
    },
  });
});

/**
 * GET /api/wallet/division-history
 * Returns last 12 months of per-division balances for trend chart.
 * Response: { months: ['2025-04', ...], divisions: { 1: [bal, ...], 2: [...], ... } }
 */
router.get('/division-history', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;

  const rows = db.prepare(`
    SELECT month, division, balance
    FROM wallet_division_history
    WHERE corporation_id = ?
    ORDER BY month ASC
  `).all(corpId);

  if (!rows.length) {
    return res.json({ months: [], divisions: {} });
  }

  // Collect all unique months (last 12)
  const allMonths = [...new Set(rows.map(r => r.month))].sort().slice(-12);

  // Build per-division arrays aligned to allMonths
  const divMap = {};
  for (const r of rows) {
    if (!divMap[r.division]) divMap[r.division] = {};
    divMap[r.division][r.month] = r.balance;
  }

  const divisions = {};
  for (const [div, monthData] of Object.entries(divMap)) {
    divisions[div] = allMonths.map(m => monthData[m] ?? null);
  }

  res.json({ months: allMonths, divisions });
});

module.exports = router;
