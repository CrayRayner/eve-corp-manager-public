'use strict';
const nodemailer = require('nodemailer');
const { db, getSetting } = require('./db');
const { decryptValue } = require('./secure-storage');

function buildTransport() {
  const host = getSetting('smtp_host', process.env.SMTP_HOST || '');
  const port = parseInt(getSetting('smtp_port', process.env.SMTP_PORT || '587'), 10);
  const user = getSetting('smtp_user', process.env.SMTP_USER || '');
  const pass = decryptValue(getSetting('smtp_pass', process.env.SMTP_PASS || ''));
  const tls  = getSetting('smtp_tls', 'true') === 'true';

  if (!host || !user) throw new Error('SMTP not configured. Go to Settings → Notifications.');

  return nodemailer.createTransport({ host, port, secure: port === 465,
    auth: { user, pass }, tls: tls ? undefined : { rejectUnauthorized: false } });
}

function getRecipients() {
  const raw = getSetting('recipients', '');
  return raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
}

function getDiscordWebhookUrl() {
  const url = getSetting('discord_webhook_url', '').trim();
  return url && url.startsWith('https://discord.com/api/webhooks/') ? url : null;
}

async function sendTestDiscord() {
  const url = getDiscordWebhookUrl();
  if (!url) throw new Error('Discord webhook URL not set. Enter it in Settings → Email & Discord Notifications.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '@here ✅ **EVE Corp Dashboard** — Test message. Fuel and gas alerts will ping @here when structures fall below your thresholds.' }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function sendDiscordAlert(alerts) {
  const url = getDiscordWebhookUrl();
  if (!url || !alerts.length) return;
  const lines = alerts.map(a =>
    `• **${a.structureName}** (${a.systemName}) — ${a.alertType === 'fuel' ? '⛽ Fuel' : '💨 Gas'} — ${a.daysLeft.toFixed(1)} days left (expires ${a.expires || '—'})`
  ).join('\n');
  const content = `@here ⚠️ **EVE Corp Structure Alert** — ${alerts.length} structure${alerts.length > 1 ? 's' : ''} need attention:\n\n${lines}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function sendTestEmail() {
  const transport = buildTransport();
  const from = getSetting('smtp_from', 'EVE Corp Dashboard <noreply@example.com>');
  await transport.sendMail({
    from, to: getRecipients().join(', '),
    subject: '✅ EVE Corp Dashboard — Test Email',
    html: `<p>Your SMTP configuration is working correctly.</p>
           <p>You will receive fuel and gas alerts here when structures fall below your configured thresholds.</p>`,
  });
}

async function sendAlertDigest(alerts) {
  if (!alerts.length) return;
  const enabled = getSetting('notifications_enabled', 'true');
  if (enabled !== 'true') return;

  const recipients = getRecipients();
  const discordUrl = getDiscordWebhookUrl();
  if (!recipients.length && !discordUrl) return;

  if (recipients.length) {
    const transport = buildTransport();
    const from = getSetting('smtp_from', 'EVE Corp Dashboard <noreply@example.com>');

    const rows = alerts.map(a => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #1e304f">${a.structureName}</td>
      <td style="padding:8px;border-bottom:1px solid #1e304f">${a.systemName}</td>
      <td style="padding:8px;border-bottom:1px solid #1e304f">${a.alertType === 'fuel' ? '⛽ Fuel Blocks' : '💨 Magmatic Gas'}</td>
      <td style="padding:8px;border-bottom:1px solid #1e304f;color:${a.daysLeft < 7 ? '#ff5555' : '#ff9933'};font-weight:bold">
        ${a.daysLeft.toFixed(1)} days
      </td>
      <td style="padding:8px;border-bottom:1px solid #1e304f">${a.expires || '—'}</td>
    </tr>`).join('');

  const html = `
    <div style="background:#07090f;color:#c5d5e8;font-family:sans-serif;padding:24px;max-width:700px">
      <h2 style="color:#4a9eff;margin-bottom:4px">⚠️ EVE Corp Structure Alert</h2>
      <p style="color:#7a95b5;margin-bottom:20px">The following structures require attention:</p>
      <table style="width:100%;border-collapse:collapse;background:#0d1526;border:1px solid #1e304f">
        <thead>
          <tr style="background:#111d35">
            <th style="padding:10px;text-align:left;color:#7a95b5;font-size:11px;text-transform:uppercase">Structure</th>
            <th style="padding:10px;text-align:left;color:#7a95b5;font-size:11px;text-transform:uppercase">System</th>
            <th style="padding:10px;text-align:left;color:#7a95b5;font-size:11px;text-transform:uppercase">Type</th>
            <th style="padding:10px;text-align:left;color:#7a95b5;font-size:11px;text-transform:uppercase">Days Left</th>
            <th style="padding:10px;text-align:left;color:#7a95b5;font-size:11px;text-transform:uppercase">Expires</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#7a95b5;font-size:12px;margin-top:20px">
        Sent by EVE Corp Dashboard at ${new Date().toUTCString()}
      </p>
    </div>`;

  await transport.sendMail({
    from, to: recipients.join(', '),
    subject: `⚠️ EVE Corp Alert — ${alerts.length} structure${alerts.length > 1 ? 's' : ''} need attention`,
    html,
  });
  }

  if (discordUrl) {
    try {
      await sendDiscordAlert(alerts);
    } catch (discordErr) {
      console.error('[Notifications] Discord webhook error:', discordErr.message);
    }
  }

  // Log sent alerts (deduplicate: don't re-send same structure+type within 24h)
  const now = Math.floor(Date.now() / 1000);
  for (const a of alerts) {
    db.prepare(`
      INSERT INTO notification_log (structure_id, alert_type, days_remaining, sent_at)
      VALUES (?, ?, ?, ?)
    `).run(a.structureId, a.alertType, a.daysLeft, now);
  }
}

function fmtISK(v) {
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Send notification for new corp contracts assigned to the corp */
async function sendContractAlerts(contracts) {
  if (!contracts.length) return;
  const enabled = getSetting('contract_notifications_enabled', 'true');
  if (enabled !== 'true') return;

  const recipients = getRecipients();
  const discordUrl = getDiscordWebhookUrl();
  if (!recipients.length && !discordUrl) return;

  if (recipients.length) {
    const transport = buildTransport();
    const from = getSetting('smtp_from', 'EVE Corp Dashboard <noreply@example.com>');

    const typeLabel = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const valueLabel = c => c.price > 0
      ? `${fmtISK(c.price)} ISK`
      : c.reward > 0
        ? `${fmtISK(c.reward)} ISK reward`
        : '—';

    const rows = contracts.map(c => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #1e304f">${esc(typeLabel(c.type))}</td>
      <td style="padding:8px;border-bottom:1px solid #1e304f">${esc(c.title)}</td>
      <td style="padding:8px;border-bottom:1px solid #1e304f">${esc(c.issuerName)}</td>
      <td style="padding:8px;border-bottom:1px solid #1e304f;color:#f0c040;font-weight:bold">${valueLabel(c)}</td>
      <td style="padding:8px;border-bottom:1px solid #1e304f">${c.dateExpired ? new Date(c.dateExpired).toDateString() : '—'}</td>
    </tr>`).join('');

    const html = `
    <div style="background:#07090f;color:#c5d5e8;font-family:sans-serif;padding:24px;max-width:700px">
      <h2 style="color:#4a9eff;margin-bottom:4px">📋 New Corp Contract${contracts.length > 1 ? 's' : ''}</h2>
      <p style="color:#7a95b5;margin-bottom:20px">${contracts.length} contract${contracts.length > 1 ? 's' : ''} assigned to your corporation:</p>
      <table style="width:100%;border-collapse:collapse;background:#0d1526;border:1px solid #1e304f">
        <thead>
          <tr style="background:#111d35">
            <th style="padding:10px;text-align:left;color:#7a95b5;font-size:11px;text-transform:uppercase">Type</th>
            <th style="padding:10px;text-align:left;color:#7a95b5;font-size:11px;text-transform:uppercase">Title</th>
            <th style="padding:10px;text-align:left;color:#7a95b5;font-size:11px;text-transform:uppercase">From</th>
            <th style="padding:10px;text-align:left;color:#7a95b5;font-size:11px;text-transform:uppercase">Value</th>
            <th style="padding:10px;text-align:left;color:#7a95b5;font-size:11px;text-transform:uppercase">Expires</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#7a95b5;font-size:12px;margin-top:20px">
        Sent by EVE Corp Dashboard at ${new Date().toUTCString()}
      </p>
    </div>`;

    await transport.sendMail({
      from,
      to: recipients.join(', '),
      subject: `📋 EVE Corp — ${contracts.length} new contract${contracts.length > 1 ? 's' : ''} assigned to corp`,
      html,
    });
  }

  if (discordUrl) {
    try {
      const typeLabel = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const valueLabel = c => c.price > 0
        ? `${fmtISK(c.price)} ISK`
        : c.reward > 0 ? `${fmtISK(c.reward)} ISK reward` : '—';
      const lines = contracts.map(c =>
        `• **${typeLabel(c.type)}** — "${c.title}" from **${c.issuerName}** — ${valueLabel(c)}`
      ).join('\n');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        await fetch(discordUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `@here 📋 **EVE Corp — New Contract${contracts.length > 1 ? 's' : ''}** assigned to corp:\n\n${lines}` }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (discordErr) {
      console.error('[Notifications] Contract Discord error:', discordErr.message);
    }
  }
}

/** Check all structures and send alerts if below thresholds */
async function checkAndNotify() {
  const fuelThreshold = parseFloat(getSetting('fuel_threshold_days', '14'));
  const gasThreshold  = parseFloat(getSetting('gas_threshold_days',  '7'));
  const now           = Math.floor(Date.now() / 1000);
  const daySeconds    = 86400;
  const METENOX_TYPE  = 81826;

  const structures = db.prepare('SELECT * FROM structures').all();
  const alerts = [];

  for (const s of structures) {
    // Fuel block check
    if (s.fuel_expires) {
      const fuelDays = (new Date(s.fuel_expires) - Date.now()) / 86400000;
      if (fuelDays <= fuelThreshold) {
        // Check if we already sent this alert today
        const recent = db.prepare(`
          SELECT id FROM notification_log
          WHERE structure_id = ? AND alert_type = 'fuel'
            AND sent_at > ? LIMIT 1
        `).get(s.structure_id, now - daySeconds);

        if (!recent) {
          alerts.push({ structureId: s.structure_id, structureName: s.name,
            systemName: s.system_name, alertType: 'fuel',
            daysLeft: parseFloat(fuelDays.toFixed(1)),
            expires: new Date(s.fuel_expires).toDateString() });
        }
      }
    }

    // Magmatic gas check (Metenox only)
    if (s.type_id === METENOX_TYPE) {
      const g = db.prepare('SELECT * FROM structure_gas WHERE structure_id = ?').get(s.structure_id);
      if (g && g.last_refill_date && g.quantity_refilled > 0) {
        const msElapsed = Date.now() - new Date(g.last_refill_date).getTime();
        const remaining = g.quantity_refilled - (msElapsed / 86400000) * g.daily_consumption;
        const gasDays   = remaining > 0 ? remaining / g.daily_consumption : 0;

        if (gasDays <= gasThreshold) {
          const recent = db.prepare(`
            SELECT id FROM notification_log
            WHERE structure_id = ? AND alert_type = 'gas'
              AND sent_at > ? LIMIT 1
          `).get(s.structure_id, now - daySeconds);

          if (!recent) {
            const expires = new Date(new Date(g.last_refill_date).getTime() +
              (g.quantity_refilled / g.daily_consumption) * 86400000);
            alerts.push({ structureId: s.structure_id, structureName: s.name,
              systemName: s.system_name, alertType: 'gas',
              daysLeft: parseFloat(gasDays.toFixed(1)),
              expires: expires.toDateString() });
          }
        }
      }
    }
  }

  if (alerts.length > 0) {
    try {
      await sendAlertDigest(alerts);
      console.log(`[Notifications] Sent alert for ${alerts.length} structures`);
    } catch (err) {
      console.error('[Notifications] Failed to send:', err.message);
    }
  }
}

module.exports = { sendTestEmail, sendTestDiscord, sendAlertDigest, checkAndNotify, sendContractAlerts };
