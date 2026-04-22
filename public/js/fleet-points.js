// ── Fleet Points Tab ──────────────────────────────────────────────────────────

let _fpDeleteArmed = false;
let _fpDeleteTimer = null;
let _fpCurrentMonth = null;

async function loadFleetPointsTab() {
  try {
    const months = await api.get('/api/fleet-points/months');
    const sel = document.getElementById('fp-month-select');
    sel.innerHTML = '<option value="">— none —</option>' +
      months.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');

    if (months.length > 0) {
      sel.value = months[0];
      await loadFleetPointsMonth(months[0]);
    } else {
      document.getElementById('fp-current-month').textContent = '—';
      document.getElementById('fp-char-count').textContent    = '0';
      document.getElementById('fp-total-points').textContent  = '0';
      document.getElementById('fp-tbody').innerHTML =
        '<tr><td colspan="4" class="empty">No data imported yet. Use "+ Import CSV" to get started.</td></tr>';
    }
  } catch (err) {
    document.getElementById('fp-tbody').innerHTML =
      `<tr><td colspan="4" class="alert alert-error">Error: ${esc(err.message)}</td></tr>`;
  }
}

async function loadFleetPointsMonth(month) {
  if (!month) return;
  _fpCurrentMonth = month;
  _fpDeleteArmed  = false;

  const deleteBtn = document.getElementById('fp-delete-btn');
  if (deleteBtn) {
    deleteBtn.style.display = 'inline-block';
    deleteBtn.textContent   = 'Delete Month';
    deleteBtn.style.color   = '';
  }

  try {
    const rows = await api.get('/api/fleet-points', { month });
    const totalPts = rows.reduce((s, r) => s + (r.fat_count || 0) + (r.pap_count || 0), 0);

    document.getElementById('fp-current-month').textContent = month;
    document.getElementById('fp-char-count').textContent    = rows.length;
    document.getElementById('fp-total-points').textContent  = totalPts.toLocaleString();

    const tbody = document.getElementById('fp-tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No entries for this month.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const pts = (r.fat_count || 0) + (r.pap_count || 0);
      return `<tr>
        <td>${esc(r.character_name)}</td>
        <td style="text-align:center">${r.fat_count}</td>
        <td style="text-align:center">${r.pap_count}</td>
        <td style="text-align:center;font-weight:700;color:var(--accent)">${pts}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    document.getElementById('fp-tbody').innerHTML =
      `<tr><td colspan="4" class="alert alert-error">Error: ${esc(err.message)}</td></tr>`;
  }
}

function armDeleteFleetMonth() {
  const btn = document.getElementById('fp-delete-btn');
  if (!btn || !_fpCurrentMonth) return;

  if (_fpDeleteArmed) {
    clearTimeout(_fpDeleteTimer);
    _fpDeleteTimer = null;
    _fpDeleteArmed = false;
    api.del(`/api/fleet-points/${_fpCurrentMonth}`)
      .then(() => loadFleetPointsTab())
      .catch(err => toast('Delete failed: ' + err.message, 'error'));
    return;
  }

  _fpDeleteArmed  = true;
  btn.textContent = 'Sure?';
  btn.style.color = 'var(--red)';
  _fpDeleteTimer  = setTimeout(() => {
    _fpDeleteArmed  = false;
    if (btn.isConnected) { btn.textContent = 'Delete Month'; btn.style.color = ''; }
    _fpDeleteTimer = null;
  }, 3000);
}

// ── CSV Import Modal ──────────────────────────────────────────────────────────

function openFleetPointsImport() {
  // Pre-fill month with current YYYY-MM
  const now = new Date();
  const m   = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  document.getElementById('fp-import-month').value  = m;
  document.getElementById('fp-import-text').value   = '';
  document.getElementById('fp-import-status').textContent = '';
  document.getElementById('fp-import-modal').style.display = 'flex';
}

function closeFleetPointsImport() {
  document.getElementById('fp-import-modal').style.display = 'none';
}

function loadFleetCsvFile(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('fp-import-text').value = e.target.result;
    document.getElementById('fp-import-status').textContent = `Loaded: ${file.name}`;
  };
  reader.readAsText(file);
}

async function doFleetPointsImport() {
  const month   = document.getElementById('fp-import-month').value.trim();
  const csvText = document.getElementById('fp-import-text').value.trim();
  const statusEl = document.getElementById('fp-import-status');

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    statusEl.textContent = 'Enter a valid month (YYYY-MM).';
    return;
  }
  if (!csvText) {
    statusEl.textContent = 'Paste or load a CSV first.';
    return;
  }

  statusEl.textContent = 'Importing...';
  try {
    const result = await api.post('/api/fleet-points/csv', { month, csvText });
    closeFleetPointsImport();
    toast(`Imported ${result.imported} entries for ${result.month}.`, 'success');
    // Refresh the tab and select the newly imported month
    await loadFleetPointsTab();
    const sel = document.getElementById('fp-month-select');
    if (sel) { sel.value = month; await loadFleetPointsMonth(month); }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
}

