'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../auth');
const { db, getSetting, setSetting } = require('../db');

const TAX_REF_TYPES = [
  'bounty_prizes', 'ess_escrow_transfer', 'agent_mission_reward',
  'industry_job_tax', 'daily_goal_payouts',
];

// Log normalization: compresses outliers while preserving relative ordering.
// score = log1p(value) / log1p(max) * 100. Returns 0 if max === 0.
function logNorm(value, max) {
  if (!max) return 0;
  return Math.min(100, (Math.log1p(value) / Math.log1p(max)) * 100);
}

// Read fleet points from local DB — returns Map<characterName, totalPoints>
// Uses the most recently imported month for the given corp, or empty Map.
function readFleetPoints(corpId) {
  const map = new Map();
  try {
    const latest = db.prepare(
      'SELECT period_month FROM fleet_points WHERE corporation_id = ? ORDER BY period_month DESC LIMIT 1'
    ).get(corpId);
    if (!latest) return map;
    const rows = db.prepare(
      'SELECT character_name, fat_count, pap_count FROM fleet_points WHERE corporation_id = ? AND period_month = ?'
    ).all(corpId, latest.period_month);
    for (const r of rows) map.set(r.character_name, (r.fat_count || 0) + (r.pap_count || 0));
  } catch (err) {
    console.warn('[Health] Fleet points read failed:', err.message);
  }
  return map;
}

// ── Settings ──────────────────────────────────────────────────────────────────

router.get('/weights', requireAuth, (req, res) => {
  res.json({
    weightTax:          parseInt(getSetting('health_weight_tax',           '30'), 10),
    weightKills:        parseInt(getSetting('health_weight_kills',         '20'), 10),
    weightActivity:     parseInt(getSetting('health_weight_activity',      '20'), 10),
    weightFatPap:       parseInt(getSetting('health_weight_fatpap',         '0'), 10),
    inactiveDays:       parseInt(getSetting('health_inactive_days',        '60'), 10),
    thresholdHardcore:  parseInt(getSetting('health_threshold_hardcore',   '85'), 10),
    thresholdActive:    parseInt(getSetting('health_threshold_active',     '60'), 10),
    thresholdAtRisk:    parseInt(getSetting('health_threshold_atrisk',     '30'), 10),
  });
});

router.put('/weights', requireAuth, (req, res) => {
  const fields = {
    'health_weight_tax':          req.body.weightTax,
    'health_weight_kills':        req.body.weightKills,
    'health_weight_activity':     req.body.weightActivity,
    'health_weight_fatpap':       req.body.weightFatPap,
    'health_inactive_days':       req.body.inactiveDays,
    'health_threshold_hardcore':  req.body.thresholdHardcore,
    'health_threshold_active':    req.body.thresholdActive,
    'health_threshold_atrisk':    req.body.thresholdAtRisk,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) setSetting(k, String(parseInt(v, 10)));
  }
  res.json({ ok: true });
});

// ── FAT/PAP Manual Overrides ──────────────────────────────────────────────────

// GET /api/health/fat-pap-overrides — returns { mainName: points, ... }
router.get('/fat-pap-overrides', requireAuth, (req, res) => {
  try { res.json(JSON.parse(getSetting('health_fat_pap_overrides', '{}'))); }
  catch { res.json({}); }
});

// PUT /api/health/fat-pap-overrides — merge { mainName: points } (null = remove override)
router.put('/fat-pap-overrides', requireAuth, (req, res) => {
  let current = {};
  try { current = JSON.parse(getSetting('health_fat_pap_overrides', '{}')); } catch {}
  for (const [name, pts] of Object.entries(req.body)) {
    if (pts === null || pts === '' || pts === undefined) {
      delete current[name];
    } else {
      current[name] = Math.max(0, parseInt(pts, 10) || 0);
    }
  }
  setSetting('health_fat_pap_overrides', JSON.stringify(current));
  res.json({ ok: true });
});

// ── Member Health ─────────────────────────────────────────────────────────────

router.get('/members', requireAuth, (req, res) => {
  const wTax         = parseInt(getSetting('health_weight_tax',          '30'), 10);
  const wKills       = parseInt(getSetting('health_weight_kills',        '20'), 10);
  const wActivity    = parseInt(getSetting('health_weight_activity',     '20'), 10);
  const wFatPap      = parseInt(getSetting('health_weight_fatpap',        '0'), 10);
  const inactiveD    = parseInt(getSetting('health_inactive_days',       '60'), 10);
  const tHardcore    = parseInt(getSetting('health_threshold_hardcore',  '85'), 10);
  const tActive      = parseInt(getSetting('health_threshold_active',    '60'), 10);
  const tAtRisk      = parseInt(getSetting('health_threshold_atrisk',    '30'), 10);

  const corpId = req.session.corporationId;
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  // ── 1. Build main→alts map ──────────────────────────────────────────────
  const members = db.prepare(
    'SELECT character_id, character_name, logon_date FROM member_tracking WHERE corporation_id = ?'
  ).all(corpId);

  const altMaps   = db.prepare('SELECT character_id, main_name FROM alt_mappings WHERE corporation_id = ?').all(corpId);
  const altToMain = new Map(altMaps.map(a => [a.character_id, a.main_name]));

  const mains = new Map(); // mainName → { mainName, charIds, charNames, maxLogon, altCount }
  for (const m of members) {
    const mainName = altToMain.get(m.character_id) || m.character_name;
    if (!mains.has(mainName)) {
      mains.set(mainName, { mainName, charIds: new Set(), charNames: new Set(), maxLogon: null, altCount: 0 });
    }
    const entry = mains.get(mainName);
    entry.charIds.add(m.character_id);
    entry.charNames.add(m.character_name);
    if (m.character_name !== mainName) entry.altCount++;
    if (!entry.maxLogon || m.logon_date > entry.maxLogon) entry.maxLogon = m.logon_date;
  }

  if (mains.size === 0) {
    return res.json({
      members: [],
      weights: { tax: wTax, kills: wKills, activity: wActivity, fatPap: wFatPap },
      inactiveDays: inactiveD,
      thresholds: { hardcore: tHardcore, active: tActive, atRisk: tAtRisk },
      summary: { hardcore: 0, active: 0, atRisk: 0, inactive: 0, total: 0 },
      fatPapAvailable: false,
    });
  }

  // ── 2. Tax ─────────────────────────────────────────────────────────────
  const taxRows = db.prepare(`
    SELECT second_party_id AS cid, SUM(amount) AS total
    FROM wallet_journal
    WHERE date >= ? AND division = 1
      AND ref_type IN (${TAX_REF_TYPES.map(() => '?').join(',')})
      AND amount > 0 AND second_party_id IS NOT NULL
      AND corporation_id = ?
    GROUP BY second_party_id
  `).all(cutoff, ...TAX_REF_TYPES, corpId);
  const taxByChar = new Map(taxRows.map(r => [r.cid, r.total]));

  // ── 3. Kills ───────────────────────────────────────────────────────────
  const killRows = db.prepare(
    'SELECT attackers_json FROM corp_kills WHERE kill_time >= ? AND corporation_id = ?'
  ).all(cutoff, corpId);

  const killsByChar = new Map();
  for (const k of killRows) {
    let attackers;
    try { attackers = JSON.parse(k.attackers_json || '[]'); } catch { attackers = []; }
    const seenThisKill = new Set();
    for (const a of attackers) {
      if (!a.character_id) continue;
      if (corpId && a.corporation_id !== corpId) continue;
      seenThisKill.add(a.character_id);
    }
    for (const cid of seenThisKill) killsByChar.set(cid, (killsByChar.get(cid) || 0) + 1);
  }

  // ── 5. Fleet Points — from local fleet_points table + manual overrides ──
  const fatPapAuto = readFleetPoints(corpId);   // characterName → points
  const fatPapOverrides = (() => {
    try { return JSON.parse(getSetting('health_fat_pap_overrides', '{}')); } catch { return {}; }
  })();
  const fatPapAvailable = fatPapAuto.size > 0 || Object.keys(fatPapOverrides).length > 0;

  // ── 6. Roll up to per-main ─────────────────────────────────────────────
  const now = Date.now();
  const results = [];

  for (const [, entry] of mains) {
    const ids   = [...entry.charIds];
    const names = [...entry.charNames];

    const taxAmount   = ids.reduce((s, id) => s + (taxByChar.get(id)   || 0), 0);
    const killCount   = ids.reduce((s, id) => s + (killsByChar.get(id) || 0), 0);
    const daysSinceLogin = entry.maxLogon
      ? (now - new Date(entry.maxLogon).getTime()) / 86400000
      : inactiveD;

    // FAT/PAP: manual override (by mainName) > auto from DB (by mainName or any alt name)
    let fatPapPoints = 0;
    if (fatPapOverrides[entry.mainName] !== undefined) {
      fatPapPoints = fatPapOverrides[entry.mainName];
    } else {
      // Try mainName first, then each character name in the group
      for (const nm of [entry.mainName, ...names]) {
        if (fatPapAuto.has(nm)) { fatPapPoints = fatPapAuto.get(nm); break; }
      }
    }

    results.push({
      mainName: entry.mainName,
      altCount: entry.altCount,
      taxAmount,
      killCount,
      fatPapPoints,
      hasManualFatPap: fatPapOverrides[entry.mainName] !== undefined,
      daysSinceLogin: parseFloat(daysSinceLogin.toFixed(1)),
      taxScore: 0, killScore: 0, activityScore: 0, fatPapScore: 0,
      healthScore: 0, status: 'inactive',
    });
  }

  // ── 7. Log-normalize each metric (compresses outliers) ─────────────────
  const maxTax    = Math.max(...results.map(r => r.taxAmount),    0);
  const maxKills  = Math.max(...results.map(r => r.killCount),    0);
  const maxFatPap = Math.max(...results.map(r => r.fatPapPoints), 0);

  for (const r of results) {
    r.taxScore    = parseFloat(logNorm(r.taxAmount,    maxTax).toFixed(1));
    r.killScore   = parseFloat(logNorm(r.killCount,    maxKills).toFixed(1));
    r.fatPapScore = parseFloat(logNorm(r.fatPapPoints, maxFatPap).toFixed(1));
    r.activityScore = parseFloat(
      Math.max(0, 100 - r.daysSinceLogin * (100 / inactiveD)).toFixed(1)
    );

    // Total weight for weighting (handles weightFatPap = 0 gracefully)
    const composite = (
      r.taxScore      * wTax      +
      r.killScore     * wKills    +
      r.activityScore * wActivity +
      r.fatPapScore   * wFatPap
    ) / 100;

    r.healthScore = parseFloat(composite.toFixed(1));

    if (r.daysSinceLogin > inactiveD) {
      r.status = 'inactive';
    } else if (r.healthScore >= tHardcore) {
      r.status = 'hardcore';
    } else if (r.healthScore >= tActive) {
      r.status = 'active';
    } else if (r.healthScore >= tAtRisk) {
      r.status = 'atrisk';
    } else {
      r.status = 'inactive';
    }
  }

  results.sort((a, b) => b.healthScore - a.healthScore);

  const summary = {
    hardcore: results.filter(r => r.status === 'hardcore').length,
    active:   results.filter(r => r.status === 'active').length,
    atRisk:   results.filter(r => r.status === 'atrisk').length,
    inactive: results.filter(r => r.status === 'inactive').length,
    total:    results.length,
  };

  res.json({
    members: results,
    weights: { tax: wTax, kills: wKills, activity: wActivity, fatPap: wFatPap },
    inactiveDays: inactiveD,
    thresholds: { hardcore: tHardcore, active: tActive, atRisk: tAtRisk },
    summary,
    fatPapAvailable,
  });
});

module.exports = router;
