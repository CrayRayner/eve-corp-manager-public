// ── Mappings ──────────────────────────────────────────────────────────────────
async function loadMappings() {
  try {
    const data = await api.get('/api/settings/mappings');
    const tbody = document.getElementById('mappings-tbody');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty">No mappings yet. Add alt → main assignments above.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(m => `
      <tr>
        <td>${m.character_name}</td>
        <td><strong>${m.main_name}</strong></td>
        <td><button class="btn btn-ghost btn-small" onclick="armDelete(this, ${m.character_id})">✕</button></td>
      </tr>`).join('');
  } catch (err) {
    document.getElementById('mappings-tbody').innerHTML =
      `<tr><td colspan="3" class="alert alert-error">${esc(err.message)}</td></tr>`;
  }
}

async function deleteMapping(id) {
  await api.del(`/api/settings/mappings/${id}`);
  loadMappings();
}

// Two-stage armed delete — avoids native confirm() which causes Electron focus loss
let _deleteTimer = null;
function armDelete(btn, id) {
  if (btn.dataset.armed) {
    clearTimeout(_deleteTimer);
    _deleteTimer = null;
    deleteMapping(id);
    return;
  }
  btn.dataset.armed = '1';
  btn.textContent = 'Sure?';
  btn.classList.replace('btn-ghost', 'btn-danger');
  _deleteTimer = setTimeout(() => {
    if (btn.isConnected) {
      btn.dataset.armed = '';
      btn.textContent = '✕';
      btn.classList.replace('btn-danger', 'btn-ghost');
    }
    _deleteTimer = null;
  }, 3000);
}

document.getElementById('btn-add-mapping').addEventListener('click', async () => {
  const alt  = document.getElementById('map-alt').value.trim();
  const main = document.getElementById('map-main').value.trim();
  if (!alt || !main) { toast('Both fields are required.', 'error'); return; }
  try {
    await api.post('/api/settings/mappings', { characterName: alt, mainName: main });
    document.getElementById('map-alt').value = '';
    document.getElementById('map-main').value = '';
    loadMappings();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
});

// ── Sync Status ───────────────────────────────────────────────────────────────
async function loadSyncStatus() {
  try {
    const [status, errors] = await Promise.all([
      api.get('/api/settings/sync-status'),
      api.get('/api/settings/sync-errors'),
    ]);
    const el = document.getElementById('sync-status-list');
    const labels = {
      structures: 'Structures', wallet: 'Wallet Journal',
      assets: 'Corp Assets', mining: 'Mining Ledger',
      observers: 'Moon Observers', market_prices: 'Market Prices',
      members: 'Member Tracking', kills: 'Corp Kills',
    };

    el.innerHTML = Object.entries(status).map(([k, v]) => {
      const age = v.lastSync ? Math.round((Date.now() / 1000 - v.lastSync) / 60) : null;
      const ageStr = age == null ? 'Never' : age < 1 ? 'Just now' : `${age}m ago`;
      const dot    = v.lastError ? 'dot-red' : v.lastSync ? 'dot-green' : 'dot-grey';
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
          <span><span class="dot ${dot}" style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px"></span>${labels[k] || k}</span>
          <span class="dim" style="font-size:0.72rem">${v.lastError ? '⚠️ ' + v.lastError : ageStr}</span>
        </div>`;
    }).join('');

    const errLog = document.getElementById('sync-error-log');
    const errBody = document.getElementById('sync-error-log-body');
    if (errLog && errBody) {
      if (errors && errors.length > 0) {
        errLog.style.display = 'block';
        const labelMap = { structures: 'Structures', wallet: 'Wallet', assets: 'Assets', mining: 'Mining', observers: 'Observers', market_prices: 'Market prices', members: 'Members', kills: 'Kills' };
        errBody.innerHTML = errors.map(e => `<div style="margin-bottom:6px"><strong>${esc(labelMap[e.key] || e.key)}</strong>: ${esc(e.message)}${e.at ? ` (${new Date(e.at).toLocaleString()})` : ''}</div>`).join('');
      } else {
        errLog.style.display = 'none';
      }
    }
  } catch (err) { console.error('Sync status error:', err); }
}

document.getElementById('btn-full-sync').addEventListener('click', async () => {
  const btn = document.getElementById('btn-full-sync');
  btn.disabled = true; btn.textContent = '⟳ Syncing…';
  try {
    await api.post('/api/settings/sync-now');
    setTimeout(() => { loadSyncStatus(); btn.disabled = false; btn.textContent = '⟳ Full Sync Now'; }, 3000);
  } catch (err) {
    toast('Sync error: ' + err.message, 'error');
    btn.disabled = false; btn.textContent = '⟳ Full Sync Now';
  }
});

document.getElementById('btn-manual-snapshot').addEventListener('click', async () => {
  try {
    await api.post('/api/snapshots/create');
    toast('Snapshot created successfully!', 'success');
  } catch (err) { toast('Snapshot error: ' + err.message, 'error'); }
});

// ── Notification Settings ─────────────────────────────────────────────────────
async function loadNotificationSettings() {
  try {
    const cfg = await api.get('/api/settings/notifications');
    document.getElementById('smtp-host').value       = cfg.smtpHost || '';
    document.getElementById('smtp-port').value       = cfg.smtpPort || '587';
    document.getElementById('smtp-user').value       = cfg.smtpUser || '';
    document.getElementById('smtp-from').value       = cfg.smtpFrom || '';
    document.getElementById('smtp-pass').placeholder = cfg.smtpPassSet ? '••••••••  (saved — leave blank to keep)' : 'Password';
    document.getElementById('smtp-recipients').value = cfg.recipients || '';
    document.getElementById('discord-webhook-url').value = cfg.discordWebhookUrl || '';
    document.getElementById('fuel-threshold').value  = cfg.fuelThresholdDays || 14;
    document.getElementById('gas-threshold').value   = cfg.gasThresholdDays  || 7;
    document.getElementById('fuel-threshold-val').textContent = (cfg.fuelThresholdDays || 14) + ' days';
    document.getElementById('gas-threshold-val').textContent  = (cfg.gasThresholdDays  || 7)  + ' days';
    document.getElementById('notif-enabled').checked          = cfg.enabled !== 'false';
    document.getElementById('contract-notif-enabled').checked = cfg.contractNotificationsEnabled !== 'false';

    // Load notification log
    const log = await api.get('/api/settings/notifications/log');
    const logEl = document.getElementById('notif-log');
    if (!log.length) {
      logEl.innerHTML = '<p class="dim" style="font-size:0.8rem">No alerts sent yet.</p>'; return;
    }
    logEl.innerHTML = `<div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:4px"><table style="margin:0"><thead><tr><th>Structure</th><th>Type</th><th>Days Remaining</th><th>Sent</th></tr></thead>
      <tbody>${log.map(l => `<tr>
        <td>${l.structure_name || 'ID:'+l.structure_id}</td>
        <td>${l.alert_type === 'fuel' ? '⛽ Fuel' : '💨 Gas'}</td>
        <td class="${fuelClass(l.days_remaining)}">${l.days_remaining?.toFixed(1)}d</td>
        <td class="dim">${fmtDate(new Date(l.sent_at * 1000).toISOString())}</td>
      </tr>`).join('')}</tbody></table></div>`;
  } catch (err) { console.error('Notification settings load error:', err); }
}

// Range slider live updates
document.getElementById('fuel-threshold').addEventListener('input', e => {
  document.getElementById('fuel-threshold-val').textContent = e.target.value + ' days';
});
document.getElementById('gas-threshold').addEventListener('input', e => {
  document.getElementById('gas-threshold-val').textContent = e.target.value + ' days';
});

document.getElementById('btn-save-notif').addEventListener('click', async () => {
  const fb = document.getElementById('notif-feedback');
  try {
    const passEl = document.getElementById('smtp-pass');
    const body = {
      smtpHost:         document.getElementById('smtp-host').value,
      smtpPort:         document.getElementById('smtp-port').value,
      smtpUser:         document.getElementById('smtp-user').value,
      smtpFrom:         document.getElementById('smtp-from').value,
      recipients:       document.getElementById('smtp-recipients').value,
      fuelThresholdDays:              document.getElementById('fuel-threshold').value,
      gasThresholdDays:               document.getElementById('gas-threshold').value,
      discordWebhookUrl:              document.getElementById('discord-webhook-url').value.trim(),
      enabled:                        document.getElementById('notif-enabled').checked ? 'true' : 'false',
      contractNotificationsEnabled:   document.getElementById('contract-notif-enabled').checked ? 'true' : 'false',
    };
    if (passEl.value) body.smtpPass = passEl.value;
    await api.put('/api/settings/notifications', body);
    fb.innerHTML = '<div class="alert alert-ok">Settings saved.</div>';
    passEl.value = '';
    setTimeout(() => { fb.innerHTML = ''; }, 3000);
  } catch (err) {
    fb.innerHTML = `<div class="alert alert-error">Error: ${esc(err.message)}</div>`;
  }
});

document.getElementById('btn-test-email').addEventListener('click', async () => {
  const fb = document.getElementById('notif-feedback');
  fb.innerHTML = '<div class="alert alert-info">Sending…</div>';
  try {
    const res = await api.post('/api/settings/notifications/test');
    fb.innerHTML = res.ok
      ? '<div class="alert alert-ok">✅ Test email sent!</div>'
      : `<div class="alert alert-error">Failed: ${esc(res.error)}</div>`;
  } catch (err) {
    fb.innerHTML = `<div class="alert alert-error">Error: ${esc(err.message)}</div>`;
  }
  setTimeout(() => { fb.innerHTML = ''; }, 5000);
});

document.getElementById('btn-test-discord').addEventListener('click', async () => {
  const fb = document.getElementById('notif-feedback');
  fb.innerHTML = '<div class="alert alert-info">Sending…</div>';
  try {
    const res = await api.post('/api/settings/notifications/test-discord');
    fb.innerHTML = res.ok
      ? '<div class="alert alert-ok">✅ Test message sent to Discord!</div>'
      : `<div class="alert alert-error">Failed: ${esc(res.error)}</div>`;
  } catch (err) {
    fb.innerHTML = `<div class="alert alert-error">Error: ${esc(err.message)}</div>`;
  }
  setTimeout(() => { fb.innerHTML = ''; }, 5000);
});

// ── CSV Alt→Main Import ───────────────────────────────────────────────────────
document.getElementById('btn-csv-upload')?.addEventListener('click', () => {
  document.getElementById('csv-file-input').click();
});

document.getElementById('csv-file-input')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fb = document.getElementById('csv-feedback');
  fb.innerHTML = '<span class="dim">Reading file…</span>';
  try {
    const csvText = await file.text();
    const res     = await api.post('/api/settings/mappings/csv', { csvText });
    if (res.ok) {
      fb.innerHTML = `<div class="alert alert-ok">✅ Imported ${res.imported} mappings${res.errors?.length ? ` (${res.errors.length} skipped)` : ''}.</div>`;
      loadMappings();
    } else {
      fb.innerHTML = `<div class="alert alert-error">Error: ${esc(res.error)}</div>`;
    }
  } catch (err) {
    fb.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
  e.target.value = '';
  setTimeout(() => { fb.innerHTML = ''; }, 5000);
});

// ── Member Health Weights ─────────────────────────────────────────────────────
function updateHealthWeightSum() {
  const sum = ['hw-tax','hw-kills','hw-activity','hw-fatpap'].reduce((s, id) => {
    const el = document.getElementById(id);
    return s + (el ? parseInt(el.value, 10) || 0 : 0);
  }, 0);
  const lbl = document.getElementById('health-weight-sum-label');
  if (!lbl) return;
  lbl.textContent = `(Total: ${sum}%)`;
  lbl.style.color = sum === 100 ? 'var(--green)' : 'var(--orange)';
}

['hw-tax','hw-kills','hw-activity','hw-fatpap'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', e => {
    document.getElementById(id + '-val').textContent = e.target.value + '%';
    updateHealthWeightSum();
  });
});
document.getElementById('hw-inactive')?.addEventListener('input', e => {
  document.getElementById('hw-inactive-val').textContent = e.target.value + ' days';
});

async function loadHealthWeights() {
  try {
    const cfg = await api.get('/api/health/weights');
    document.getElementById('hw-tax').value               = cfg.weightTax;
    document.getElementById('hw-kills').value             = cfg.weightKills;
    document.getElementById('hw-activity').value          = cfg.weightActivity;
    document.getElementById('hw-fatpap').value            = cfg.weightFatPap;
    document.getElementById('hw-inactive').value          = cfg.inactiveDays;
    document.getElementById('hw-threshold-hardcore').value = cfg.thresholdHardcore;
    document.getElementById('hw-threshold-active').value   = cfg.thresholdActive;
    document.getElementById('hw-threshold-atrisk').value   = cfg.thresholdAtRisk;
    document.getElementById('hw-tax-val').textContent      = cfg.weightTax      + '%';
    document.getElementById('hw-kills-val').textContent    = cfg.weightKills    + '%';
    document.getElementById('hw-activity-val').textContent = cfg.weightActivity + '%';
    document.getElementById('hw-fatpap-val').textContent   = cfg.weightFatPap  + '%';
    document.getElementById('hw-inactive-val').textContent = cfg.inactiveDays  + ' days';
    updateHealthWeightSum();
  } catch (err) { console.error('Health weights load error:', err); }
}

document.getElementById('btn-save-health-weights')?.addEventListener('click', async () => {
  const fb  = document.getElementById('health-weights-feedback');
  const sum = ['hw-tax','hw-kills','hw-activity','hw-fatpap'].reduce((s, id) => {
    return s + parseInt(document.getElementById(id).value, 10) || 0;
  }, 0);
  if (sum !== 100) {
    fb.innerHTML = `<div class="alert alert-warn">Weights must sum to 100 (currently ${sum}).</div>`;
    setTimeout(() => { fb.innerHTML = ''; }, 4000);
    return;
  }
  try {
    await api.put('/api/health/weights', {
      weightTax:         document.getElementById('hw-tax').value,
      weightKills:       document.getElementById('hw-kills').value,
      weightActivity:    document.getElementById('hw-activity').value,
      weightFatPap:      document.getElementById('hw-fatpap').value,
      inactiveDays:      document.getElementById('hw-inactive').value,
      thresholdHardcore: document.getElementById('hw-threshold-hardcore').value,
      thresholdActive:   document.getElementById('hw-threshold-active').value,
      thresholdAtRisk:   document.getElementById('hw-threshold-atrisk').value,
    });
    fb.innerHTML = '<div class="alert alert-ok">Health weights saved.</div>';
    setTimeout(() => { fb.innerHTML = ''; }, 3000);
  } catch (err) {
    fb.innerHTML = `<div class="alert alert-error">Error: ${esc(err.message)}</div>`;
  }
});

// ── Fuel Hangar ───────────────────────────────────────────────────────────────
async function loadFuelHangar() {
  try {
    const { fuelHangar, gasConsumptionPerMonth } = await api.get('/api/settings/fuel-hangar');
    const sel = document.getElementById('fuel-hangar-select');
    if (sel && fuelHangar) sel.value = fuelHangar;
    const gasInput = document.getElementById('gas-consumption-per-month');
    if (gasInput && gasConsumptionPerMonth != null) gasInput.value = gasConsumptionPerMonth;
  } catch (err) { console.error('Fuel hangar load error:', err); }
}

document.getElementById('btn-save-fuel-hangar')?.addEventListener('click', async () => {
  const fb  = document.getElementById('fuel-hangar-feedback');
  const sel = document.getElementById('fuel-hangar-select');
  const gasInput = document.getElementById('gas-consumption-per-month');
  try {
    const body = { fuelHangar: sel.value };
    if (gasInput && gasInput.value.trim() !== '') body.gasConsumptionPerMonth = parseInt(gasInput.value, 10);
    await api.put('/api/settings/fuel-hangar', body);
    fb.innerHTML = '<span class="alert alert-ok" style="padding:2px 8px">Saved</span>';
    setTimeout(() => { fb.innerHTML = ''; }, 2500);
  } catch (err) {
    fb.innerHTML = `<span class="alert alert-error" style="padding:2px 8px">${esc(err.message)}</span>`;
  }
});

// ── Corp Tax & LP Rates ───────────────────────────────────────────────────────
async function loadCorpRates() {
  try {
    const r = await api.get('/api/settings/corp-rates');
    const taxEl = document.getElementById('corp-tax-rate');
    if (taxEl) taxEl.value = r.taxRatePercent != null ? r.taxRatePercent : '';
  } catch (err) { console.error('Corp rates load error:', err); }
}

document.getElementById('btn-save-corp-rates')?.addEventListener('click', async () => {
  const fb = document.getElementById('corp-rates-feedback');
  try {
    const taxVal = document.getElementById('corp-tax-rate')?.value?.trim() ?? '';
    await api.put('/api/settings/corp-rates', {
      taxRatePercent: taxVal === '' ? null : parseFloat(taxVal),
    });
    fb.innerHTML = '<span class="alert alert-ok" style="padding:2px 8px">Saved</span>';
    setTimeout(() => { fb.innerHTML = ''; }, 2500);
  } catch (err) {
    fb.innerHTML = `<span class="alert alert-error" style="padding:2px 8px">${esc(err.message)}</span>`;
  }
});

// ── Backup / Restore ──────────────────────────────────────────────────────────
document.getElementById('btn-export-backup')?.addEventListener('click', async () => {
  const fb = document.getElementById('backup-restore-feedback');
  fb.textContent = 'Preparing download…';
  try {
    const res = await fetch('/api/settings/backup', { credentials: 'include' });
    if (!res.ok) throw new Error(res.statusText);
    const blob = await res.blob();
    const name = res.headers.get('Content-Disposition')?.match(/filename="?([^";\n]+)"?/)?.[1] || 'corp.db';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    fb.textContent = 'Downloaded. File contains sensitive data — store securely.';
    if (typeof toast === 'function') toast('Backup contains sensitive data (tokens, settings). Store securely.', 'info');
    setTimeout(() => fb.textContent = '', 4000);
  } catch (err) {
    fb.textContent = 'Error: ' + err.message;
    fb.style.color = 'var(--red)';
  }
});

document.getElementById('btn-restore-backup')?.addEventListener('click', () => {
  document.getElementById('restore-file-input').click();
});

document.getElementById('restore-file-input')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fb = document.getElementById('backup-restore-feedback');
  fb.textContent = 'Uploading…';
  fb.style.color = '';
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/settings/restore', { method: 'POST', credentials: 'include', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    fb.textContent = data.message || 'Backup saved. Restart the app to complete restore.';
    fb.style.color = 'var(--green)';
  } catch (err) {
    fb.textContent = 'Error: ' + err.message;
    fb.style.color = 'var(--red)';
  }
  e.target.value = '';
});

// ── Tab Visibility ─────────────────────────────────────────────────────────────
async function loadTabVisibilitySettings() {
  try {
    const vis = await api.get('/api/settings/tabs');
    const tabs = ['structures', 'metenox', 'wallet', 'kills', 'contracts', 'health'];
    tabs.forEach(t => {
      const cb = document.getElementById(`tab-vis-${t}`);
      if (cb) cb.checked = vis[t] !== false;
    });
  } catch (err) { console.error('Tab visibility load error:', err); }
}

// Save on any checkbox change
document.getElementById('tab-visibility-controls').addEventListener('change', async () => {
  const tabs = ['structures', 'metenox', 'wallet', 'kills', 'contracts', 'health'];
  const vis = {};
  tabs.forEach(t => {
    const cb = document.getElementById(`tab-vis-${t}`);
    vis[t] = cb ? cb.checked : true;
  });
  try {
    await api.put('/api/settings/tabs', vis);
    applyTabVisibility(vis); // defined in app.js
  } catch (err) { toast('Error saving tab settings: ' + err.message, 'error'); }
});

// Show Tutorial button
document.getElementById('btn-show-tutorial').addEventListener('click', () => {
  showTutorialModal(); // defined in app.js
});

function loadSettings() {
  loadMappings();
  loadSyncStatus();
  loadDisplaySettings();
  loadTabVisibilitySettings();
  loadHealthWeights();
  loadNotificationSettings();
  loadFuelHangar();
  loadCorpRates();
}

// ── Display (color blind, date format, fuel month hours) ───────────────────────
async function loadDisplaySettings() {
  try {
    const data = await api.get('/api/settings/display');
    const cb = document.getElementById('color-blind-mode');
    if (cb) cb.checked = !!data.colorBlindMode;
    document.getElementById('app')?.classList.toggle('color-blind-mode', !!data.colorBlindMode);
    if (typeof window !== 'undefined') window.__dateFormat = data.dateFormat || 'eu';
    const dateSel = document.getElementById('date-format-select');
    if (dateSel) dateSel.value = data.dateFormat === 'us' ? 'us' : 'eu';
    const fuelHours = document.getElementById('structure-fuel-month-hours');
    if (fuelHours) fuelHours.value = data.structureFuelMonthHours || '720';
  } catch (err) { console.error('Display settings load error:', err); }
}

function saveDisplaySettings(extra = {}) {
  const fb = document.getElementById('display-feedback');
  const cb = document.getElementById('color-blind-mode');
  const dateSel = document.getElementById('date-format-select');
  const fuelHours = document.getElementById('structure-fuel-month-hours');
  const body = {
    colorBlindMode: !!cb?.checked,
    dateFormat: dateSel?.value === 'us' ? 'us' : 'eu',
    structureFuelMonthHours: fuelHours ? String(Math.max(1, Math.min(744, parseInt(fuelHours.value, 10) || 720))) : '720',
    ...extra,
  };
  return api.put('/api/settings/display', body).then(() => {
    if (typeof window !== 'undefined') window.__dateFormat = body.dateFormat;
    if (fb) { fb.textContent = 'Saved.'; fb.style.color = 'var(--green)'; setTimeout(() => { fb.textContent = ''; }, 2000); }
  }).catch(err => {
    if (fb) { fb.textContent = 'Error: ' + err.message; fb.style.color = 'var(--red)'; throw err; }
  });
}

document.getElementById('color-blind-mode')?.addEventListener('change', async function () {
  const enabled = this.checked;
  try {
    await saveDisplaySettings({ colorBlindMode: enabled });
    document.getElementById('app')?.classList.toggle('color-blind-mode', enabled);
  } catch (_) {}
});

document.getElementById('date-format-select')?.addEventListener('change', () => saveDisplaySettings());
document.getElementById('structure-fuel-month-hours')?.addEventListener('blur', () => saveDisplaySettings());
