// ── Member Health Tab ─────────────────────────────────────────────────────────

let _healthData = null;
let _healthSort = { col: 'healthScore', dir: -1 }; // -1 = desc
let _fatPapEditing = false;

async function loadHealth() {
  try {
    const data = await api.get('/api/health/members');
    _healthData = data;
    renderHealthKpis(data.summary, data.thresholds);
    renderHealthTable(data);

    // Update column header with FAT/PAP availability
    const hdr = document.getElementById('health-fatpap-header');
    if (hdr) {
      hdr.textContent = data.fatPapAvailable ? 'FAT/PAP ✓' : 'FAT/PAP';
      hdr.title = data.fatPapAvailable
        ? 'FAT/PAP points — from FAT PAP DB (click ✏ to override)'
        : 'FAT/PAP points — no DB data (click ✏ to enter manually)';
    }

    // Show active weights in card-title
    const lbl = document.getElementById('health-weights-label');
    if (lbl) {
      const w = data.weights;
      lbl.textContent = `Tax ${w.tax}% · Kills ${w.kills}% · Activity ${w.activity}%` +
        (w.fatPap > 0 ? ` · FAT/PAP ${w.fatPap}%` : '');
    }
  } catch (err) {
    const tbody = document.getElementById('health-tbody');
    if (tbody) tbody.innerHTML =
      `<tr><td colspan="9" class="alert alert-error">Error: ${esc(err.message)}</td></tr>`;
  }
}

function renderHealthKpis(s, thresholds) {
  document.getElementById('hkpi-hardcore').textContent = s.hardcore;
  document.getElementById('hkpi-active').textContent   = s.active;
  document.getElementById('hkpi-atrisk').textContent   = s.atRisk;
  document.getElementById('hkpi-inactive').textContent = s.inactive;
  document.getElementById('hkpi-total').textContent    = s.total;

  // Update sub text with current threshold values
  if (thresholds) {
    const hcSub = document.getElementById('hkpi-hardcore-sub');
    const acSub = document.getElementById('hkpi-active-sub');
    const arSub = document.getElementById('hkpi-atrisk-sub');
    if (hcSub) hcSub.textContent = `score ≥ ${thresholds.hardcore}`;
    if (acSub) acSub.textContent = `score ≥ ${thresholds.active}`;
    if (arSub) arSub.textContent = `score ≥ ${thresholds.atRisk}`;
  }
}

function renderHealthTable(data) {
  const tbody   = document.getElementById('health-tbody');
  let members   = [...(data.members || [])];

  const search = (document.getElementById('health-search')?.value || '').trim().toLowerCase();
  if (search) members = members.filter(m => (m.mainName || '').toLowerCase().includes(search));

  // Sort
  const { col, dir } = _healthSort;
  members.sort((a, b) => {
    const av = typeof a[col] === 'string' ? a[col].toLowerCase() : (a[col] ?? 0);
    const bv = typeof b[col] === 'string' ? b[col].toLowerCase() : (b[col] ?? 0);
    return av < bv ? -dir : av > bv ? dir : 0;
  });

  if (members.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">No member data yet — run a full sync.</td></tr>';
    return;
  }

  const thr = data.thresholds || { hardcore: 85, active: 60, atRisk: 30 };

  tbody.innerHTML = members.map((m, i) => {
    // Status badge
    let statusBadge;
    if (m.status === 'hardcore') {
      statusBadge = '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:700;background:rgba(155,127,212,.2);color:var(--purple);border:1px solid rgba(155,127,212,.4)">⚡ Hardcore</span>';
    } else if (m.status === 'active') {
      statusBadge = '<span class="badge badge-green">Active</span>';
    } else if (m.status === 'atrisk') {
      statusBadge = '<span class="badge badge-gold">At Risk</span>';
    } else {
      statusBadge = '<span class="badge badge-red">Inactive</span>';
    }

    // Health bar color by status
    const barColor = m.status === 'hardcore' ? 'var(--purple)'
                   : m.status === 'active'   ? 'var(--green)'
                   : m.status === 'atrisk'   ? 'var(--orange)'
                   : 'var(--red)';

    const loginAge = m.daysSinceLogin != null
      ? (m.daysSinceLogin < 1 ? 'Today' : m.daysSinceLogin < 2 ? 'Yesterday' : `${Math.round(m.daysSinceLogin)}d ago`)
      : '—';
    const loginColor = m.daysSinceLogin > data.inactiveDays ? 'var(--red)'
                     : m.daysSinceLogin > data.inactiveDays * 0.5 ? 'var(--orange)'
                     : 'var(--text)';

    // FAT/PAP cell — mini-bar + inline edit button
    const fpOverrideIcon = m.hasManualFatPap ? '✏✓' : '✏';
    const fpTitle = m.hasManualFatPap
      ? `Manual override: ${m.fatPapPoints} pts — click to edit`
      : `Auto: ${m.fatPapPoints} pts — click to set manual override`;

    const fatPapCell = `
      <div style="display:flex;align-items:center;gap:4px">
        ${miniBar(m.fatPapScore, 'var(--purple)')}
        <button class="btn btn-ghost"
                style="padding:1px 5px;font-size:0.65rem;min-width:auto;opacity:0.6;line-height:1.4;border-radius:3px"
                data-mainname="${esc(m.mainName)}"
                data-points="${m.fatPapPoints}"
                data-has-override="${m.hasManualFatPap ? '1' : '0'}"
                onclick="editFatPap(this)"
                title="${esc(fpTitle)}">${fpOverrideIcon}</button>
      </div>`;

    return `<tr>
      <td class="dim" style="font-size:0.72rem">${i + 1}</td>
      <td><strong>${esc(m.mainName)}</strong>${m.altCount > 0 ? `<span class="dim" style="font-size:0.7rem;margin-left:5px">(+${m.altCount} alt${m.altCount > 1 ? 's' : ''})</span>` : ''}</td>
      <td style="min-width:130px">
        <div style="display:flex;align-items:center;gap:6px">
          <div class="bar-outer" style="flex:1;min-width:60px">
            <div class="bar-fill" style="width:${m.healthScore.toFixed(1)}%;background:${barColor}"></div>
          </div>
          <span style="font-weight:700;color:${barColor};min-width:34px;text-align:right;font-size:0.82rem">${m.healthScore.toFixed(0)}</span>
        </div>
      </td>
      <td style="min-width:80px">${miniBar(m.taxScore, 'var(--green)')}</td>
      <td style="min-width:80px">${miniBar(m.killScore, 'var(--red)')}</td>
      <td style="min-width:80px">${miniBar(m.activityScore, 'var(--purple)')}</td>
      <td style="min-width:90px">${fatPapCell}</td>
      <td style="color:${loginColor};font-size:0.78rem">${loginAge}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('');
}

function miniBar(score, color) {
  return `<div style="display:flex;align-items:center;gap:4px">
    <div class="bar-outer" style="flex:1;height:5px;min-width:50px">
      <div style="height:100%;border-radius:4px;background:${color};width:${score.toFixed(1)}%;transition:width 0.3s"></div>
    </div>
    <span style="font-size:0.7rem;color:var(--text-dim);min-width:26px;text-align:right">${score.toFixed(0)}</span>
  </div>`;
}

// ── FAT/PAP Inline Edit ───────────────────────────────────────────────────────

async function editFatPap(btn) {
  if (_fatPapEditing) return;
  _fatPapEditing = true;

  const mainName     = btn.dataset.mainname;    // HTML-decoded by browser
  const currentPoints = parseInt(btn.dataset.points, 10) || 0;
  const cell         = btn.closest('td');
  const origHTML     = cell.innerHTML;

  cell.innerHTML = `
    <div style="display:flex;align-items:center;gap:4px">
      <input type="number" id="fp-edit-input" value="${currentPoints}" min="0"
             style="width:62px;padding:2px 5px;font-size:0.8rem;background:var(--card);color:var(--text);border:1px solid var(--accent);border-radius:4px">
      <button class="btn btn-primary" id="fp-save-btn"   style="padding:2px 7px;font-size:0.7rem">✓</button>
      <button class="btn btn-ghost"   id="fp-cancel-btn" style="padding:2px 5px;font-size:0.7rem">✕</button>
    </div>`;

  const input     = document.getElementById('fp-edit-input');
  const saveBtn   = document.getElementById('fp-save-btn');
  const cancelBtn = document.getElementById('fp-cancel-btn');

  input.focus();
  input.select();

  const save = async () => {
    const raw = input.value.trim();
    const val = raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0);
    try {
      await api.put('/api/health/fat-pap-overrides', { [mainName]: val });
      await loadHealth();
    } catch {
      cell.innerHTML = origHTML;
    } finally {
      _fatPapEditing = false;
    }
  };

  const cancel = () => {
    cell.innerHTML = origHTML;
    _fatPapEditing = false;
  };

  saveBtn.addEventListener('click',  save);
  cancelBtn.addEventListener('click', cancel);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  save();
    if (e.key === 'Escape') cancel();
  });
}

// ── Sortable column headers ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const table = document.getElementById('health-table');
  if (!table) return;
  table.querySelectorAll('th.sortable').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (_healthSort.col === col) {
        _healthSort.dir *= -1;
      } else {
        _healthSort.col = col;
        _healthSort.dir = col === 'mainName' ? 1 : -1;
      }
      if (_healthData) renderHealthTable(_healthData);
    });
  });
  document.getElementById('health-search')?.addEventListener('input', () => {
    if (_healthData) renderHealthTable(_healthData);
  });
});
