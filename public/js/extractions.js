// ── Moon Timers / Extractions ────────────────────────────────────────────────

function fmtExtractionTime(iso) {
  if (!iso) return '—';
  // Local time
  const d   = new Date(iso);
  const loc = (typeof window !== 'undefined' && window.__dateFormat === 'us') ? 'en-US' : 'en-GB';
  const local = d.toLocaleDateString(loc, { day: '2-digit', month: 'short', year: 'numeric' })
    + ' ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false });
  // EVE time = UTC
  const utcDate = d.toISOString().replace('T', ' ').slice(0, 16) + ' EVE';
  return `${local}<br><span style="font-size:0.7rem;color:var(--text-dim)">${utcDate}</span>`;
}

function timeUntilLabel(iso) {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return '<span style="color:var(--green)">ready</span>';
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

function extractionStatusBadge(status) {
  switch (status) {
    case 'ready':      return '<span class="badge" style="background:var(--green);color:#000;padding:2px 8px;border-radius:4px;font-size:0.7rem">Ready</span>';
    case 'extracting': return '<span class="badge" style="background:var(--gold);color:#000;padding:2px 8px;border-radius:4px;font-size:0.7rem">Extracting</span>';
    case 'expired':    return '<span class="badge" style="background:var(--red);color:#fff;padding:2px 8px;border-radius:4px;font-size:0.7rem">Expired</span>';
    default:           return '<span class="badge" style="background:var(--border);color:var(--text);padding:2px 8px;border-radius:4px;font-size:0.7rem">Unknown</span>';
  }
}

async function loadExtractions() {
  const el = document.getElementById('extractions-content');
  if (!el) return;

  // Load saved webhook URL into the input
  try {
    const disc = await api.get('/api/settings/discord');
    const inp  = document.getElementById('moon-discord-webhook');
    if (inp && disc.webhookUrl) inp.value = disc.webhookUrl;
  } catch (_) {}

  try {
    const data = await api.get('/api/extractions');

    if (!data.length) {
      el.innerHTML = '<p class="dim" style="padding:12px;font-size:0.82rem">No active moon extractions found. Trigger a sync to load data. (Requires <code>esi-industry.read_corporation_mining.v1</code>)</p>';
      return;
    }

    el.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Structure</th>
            <th>Moon</th>
            <th class="text-right">Chunk Arrival</th>
            <th class="text-right">Natural Decay</th>
            <th class="text-center">Status</th>
            <th class="text-right">Time Until</th>
          </tr></thead>
          <tbody>
            ${data.map(r => `
              <tr>
                <td><strong>${esc(r.structure_name)}</strong></td>
                <td style="color:var(--text-dim)">${esc(r.moon_name)}</td>
                <td class="text-right" style="font-size:0.8rem">${fmtExtractionTime(r.chunk_arrival_time)}</td>
                <td class="text-right" style="font-size:0.8rem">${fmtExtractionTime(r.natural_decay_time)}</td>
                <td class="text-center">${extractionStatusBadge(r.status)}</td>
                <td class="text-right" style="font-size:0.82rem">${r.status === 'extracting' ? timeUntilLabel(r.chunk_arrival_time) : (r.status === 'ready' ? '<span style="color:var(--green)">Fracture now</span>' : '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    el.innerHTML = `<p class="alert alert-error" style="padding:8px;font-size:0.8rem">${esc(err.message)}</p>`;
  }
}

// Post-to-Discord button
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-post-discord');
  if (btn) {
    btn.addEventListener('click', async () => {
      const statusEl = document.getElementById('discord-post-status');
      btn.disabled = true;
      if (statusEl) statusEl.textContent = 'Posting…';
      try {
        const r = await api.post('/api/extractions/post-discord');
        if (statusEl) {
          statusEl.style.color = 'var(--green)';
          statusEl.textContent = r.message || 'Posted to Discord!';
          setTimeout(() => { statusEl.textContent = ''; }, 4000);
        }
      } catch (err) {
        if (statusEl) {
          statusEl.style.color = 'var(--red)';
          statusEl.textContent = err.message;
        }
      } finally {
        btn.disabled = false;
      }
    });
  }

  const saveBtn = document.getElementById('btn-save-discord-webhook');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const inp       = document.getElementById('moon-discord-webhook');
      const statusEl  = document.getElementById('discord-webhook-save-status');
      const webhookUrl = inp ? inp.value.trim() : '';
      try {
        await api.post('/api/settings/discord', { webhookUrl });
        if (statusEl) {
          statusEl.style.color = 'var(--green)';
          statusEl.textContent = 'Saved!';
          setTimeout(() => { statusEl.textContent = ''; }, 3000);
        }
      } catch (err) {
        if (statusEl) {
          statusEl.style.color = 'var(--red)';
          statusEl.textContent = err.message;
        }
      }
    });
  }
});
