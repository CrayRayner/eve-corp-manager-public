'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../auth');
const { db } = require('../db');

function buildScopeWhere(scope, corpId) {
  if (scope === 'for_corp' && corpId) return ['assignee_id = ?', [corpId]];
  if (scope === 'by_corp'  && corpId) return ['issuer_corp_id = ? AND for_corporation = 1', [corpId]];
  if (scope === 'alliance' && corpId) return ['assignee_id != ?', [corpId]];
  return ['', []]; // all
}

// GET /api/contracts?scope=for_corp|by_corp|alliance|all&status=all|outstanding|...&page=1
router.get('/', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;

  const scope  = req.query.scope  || 'for_corp';
  const status = req.query.status || 'all';
  const page   = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit  = 50;
  const offset = (page - 1) * limit;

  const [scopeSql, scopeArgs] = buildScopeWhere(scope, corpId);

  // Base: always filter to this corp's data
  const baseSql  = 'cc.corporation_id = ?';
  const baseArgs = [corpId];

  // Full WHERE (corp base + scope + status)
  const fullConds = [baseSql];
  const fullArgs  = [...baseArgs];
  if (scopeSql) { fullConds.push(scopeSql); fullArgs.push(...scopeArgs); }
  if (status !== 'all') { fullConds.push('status = ?'); fullArgs.push(status); }
  const fullWhere = 'WHERE ' + fullConds.join(' AND ');

  // Scope-only WHERE (for status sub-counts, still filtered by corp)
  const scopeConds = [baseSql, ...(scopeSql ? [scopeSql] : [])];
  const scopeAllArgs = [...baseArgs, ...scopeArgs];
  const scopeWhere = 'WHERE ' + scopeConds.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS c FROM corp_contracts cc ${fullWhere}`).get(...fullArgs)?.c || 0;
  const rows  = db.prepare(`
    SELECT cc.*,
      COALESCE(
        NULLIF(ns.value,   ''),
        NULLIF(st.name,    ''),
        NULLIF(nc.name,    ''),
        NULLIF(al.ln,      '')
      ) AS location_name
    FROM corp_contracts cc
    LEFT JOIN notification_settings ns
           ON ns.key = 'loc_name_' || cc.start_location_id
    LEFT JOIN structures st
           ON st.structure_id = cc.start_location_id AND st.corporation_id = ?
    LEFT JOIN name_cache nc
           ON nc.id = cc.start_location_id AND nc.name != ''
    LEFT JOIN (
      SELECT location_id,
             MAX(CASE WHEN location_name NOT LIKE 'Loc %' THEN location_name END) AS ln
      FROM assets WHERE corporation_id = ? GROUP BY location_id
    ) al ON al.location_id = cc.start_location_id
    ${fullWhere}
    ORDER BY date_issued DESC
    LIMIT ? OFFSET ?
  `).all(corpId, corpId, ...fullArgs, limit, offset);

  // Scope tab badge counts (all statuses within each scope, filtered by corp)
  const scopeCounts = {
    all: db.prepare('SELECT COUNT(*) AS c FROM corp_contracts WHERE corporation_id = ?').get(corpId)?.c || 0,
  };
  if (corpId) {
    scopeCounts.for_corp = db.prepare('SELECT COUNT(*) AS c FROM corp_contracts WHERE corporation_id = ? AND assignee_id = ?').get(corpId, corpId)?.c || 0;
    scopeCounts.by_corp  = db.prepare('SELECT COUNT(*) AS c FROM corp_contracts WHERE corporation_id = ? AND issuer_corp_id = ? AND for_corporation = 1').get(corpId, corpId)?.c || 0;
    scopeCounts.alliance = db.prepare('SELECT COUNT(*) AS c FROM corp_contracts WHERE corporation_id = ? AND assignee_id != ?').get(corpId, corpId)?.c || 0;
  }

  // Status sub-counts within current scope
  const statusRows  = db.prepare(`SELECT status, COUNT(*) AS c FROM corp_contracts cc ${scopeWhere} GROUP BY status`).all(...scopeAllArgs);
  const statusCounts = { all: scopeCounts[scope] ?? total };
  for (const r of statusRows) statusCounts[r.status] = r.c;

  // Unnotified contracts assigned to corp
  const newCount = db.prepare('SELECT COUNT(*) AS c FROM corp_contracts WHERE corporation_id = ? AND notified = 0 AND assignee_id = ?').get(corpId, corpId)?.c || 0;

  res.json({ contracts: rows, total, page, scopeCounts, statusCounts, newCount });
});

// POST /api/contracts/mark-seen — clear the "new" badge
router.post('/mark-seen', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  if (corpId) {
    db.prepare('UPDATE corp_contracts SET notified = 1 WHERE corporation_id = ? AND assignee_id = ? AND notified = 0').run(corpId, corpId);
  }
  res.json({ ok: true });
});

module.exports = router;
