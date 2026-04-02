'use strict';
const express = require('express');
const https   = require('https');
const router  = express.Router();
const { requireAuth } = require('../auth');
const { db, getSetting } = require('../db');

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractionStatus(chunkArrival, naturalDecay) {
  const now = Date.now();
  const arrival = chunkArrival ? new Date(chunkArrival).getTime() : null;
  const decay   = naturalDecay ? new Date(naturalDecay).getTime() : null;
  if (!arrival) return 'unknown';
  if (now < arrival) return 'extracting';
  if (!decay || now < decay) return 'ready';
  return 'expired';
}

function fmtEveUtc(iso) {
  if (!iso) return '—';
  // Format as "YYYY-MM-DD HH:mm EVE"
  const d = new Date(iso);
  const y  = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h  = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi} EVE`;
}

function timeUntil(iso) {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const totalMins = Math.floor(diff / 60000);
  const d = Math.floor(totalMins / 1440);
  const h = Math.floor((totalMins % 1440) / 60);
  const m = totalMins % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return 'in ' + parts.join(' ');
}

function postDiscordWebhook(webhookUrl, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url     = new URL(webhookUrl);
    const options = {
      hostname: url.hostname,
      port:     443,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':     'EVE-Corp-Dashboard/1.0',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`Discord returned ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/extractions
router.get('/', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;

  const rows = db.prepare(`
    SELECT
      e.structure_id,
      e.moon_id,
      e.extraction_start_time,
      e.chunk_arrival_time,
      e.natural_decay_time,
      COALESCE(s.name, nc_s.name, 'Structure ' || e.structure_id) AS structure_name,
      COALESCE(nc_m.name, 'Moon ' || e.moon_id) AS moon_name
    FROM moon_extractions e
    LEFT JOIN structures s        ON s.structure_id = e.structure_id AND s.corporation_id = e.corporation_id
    LEFT JOIN name_cache nc_s     ON nc_s.id = e.structure_id
    LEFT JOIN name_cache nc_m     ON nc_m.id = e.moon_id
    WHERE e.corporation_id = ?
    ORDER BY e.chunk_arrival_time ASC
  `).all(corpId);

  const result = rows.map(r => ({
    structure_id:           r.structure_id,
    structure_name:         r.structure_name,
    moon_id:                r.moon_id,
    moon_name:              r.moon_name,
    extraction_start_time:  r.extraction_start_time,
    chunk_arrival_time:     r.chunk_arrival_time,
    natural_decay_time:     r.natural_decay_time,
    status:                 extractionStatus(r.chunk_arrival_time, r.natural_decay_time),
  }));

  res.json(result);
});

// POST /api/extractions/post-discord
router.post('/post-discord', requireAuth, async (req, res) => {
  const corpId = req.session.corporationId;

  const webhookUrl = getSetting('discord_webhook_url', '');
  if (!webhookUrl) {
    return res.status(400).json({ error: 'No Discord webhook URL configured. Set it in Settings → Notifications.' });
  }

  // Get corp name from token
  const token = db.prepare('SELECT corporation_name FROM tokens WHERE corporation_id = ?').get(corpId);
  const corpName = token?.corporation_name || `Corp ${corpId}`;

  const rows = db.prepare(`
    SELECT
      e.structure_id,
      e.moon_id,
      e.chunk_arrival_time,
      e.natural_decay_time,
      COALESCE(s.name, nc_s.name, 'Structure ' || e.structure_id) AS structure_name,
      COALESCE(nc_m.name, 'Moon ' || e.moon_id) AS moon_name
    FROM moon_extractions e
    LEFT JOIN structures s    ON s.structure_id = e.structure_id AND s.corporation_id = e.corporation_id
    LEFT JOIN name_cache nc_s ON nc_s.id = e.structure_id
    LEFT JOIN name_cache nc_m ON nc_m.id = e.moon_id
    WHERE e.corporation_id = ?
    ORDER BY e.chunk_arrival_time ASC
  `).all(corpId);

  if (!rows.length) {
    return res.json({ ok: true, message: 'No extractions to post.' });
  }

  const statusLabel = { extracting: 'Extracting', ready: 'Ready to fracture', expired: 'Expired', unknown: 'Unknown' };
  const lines = rows.map(r => {
    const status = extractionStatus(r.chunk_arrival_time, r.natural_decay_time);
    const until  = status === 'extracting' ? ` (${timeUntil(r.chunk_arrival_time)})` : '';
    return [
      `📍 **${r.structure_name}** | ${r.moon_name}`,
      `⏰ Chunk: ${fmtEveUtc(r.chunk_arrival_time)}${until}`,
      `⌛ Decay: ${fmtEveUtc(r.natural_decay_time)}`,
      `📊 ${statusLabel[status] || status}`,
    ].join('\n');
  }).join('\n\n');

  const content = `🌙 **Moon Extraction Status** — ${corpName}\n\n${lines}`;

  try {
    await postDiscordWebhook(webhookUrl, { content });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
