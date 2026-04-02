// ── Gas & Fuel Stock ──────────────────────────────────────────────────────────
async function loadStructureInventory() {
  const gasEl  = document.getElementById('gas-stock-content');
  const fuelEl = document.getElementById('fuel-stock-content');
  try {
    const inv = await api.get('/api/structures/inventory');
    const { gas, fuel } = inv;

    // ── Magmatic Gas ──
    if (!gas.total) {
      gasEl.innerHTML = '<p class="dim" style="padding:10px;font-size:0.82rem">No Magmatic Gas found in corp hangars. Run an asset sync first.</p>';
    } else {
      const daysColor = gas.daysLeft == null ? '' : gas.daysLeft < 7 ? 'color:var(--red)' : gas.daysLeft < 14 ? 'color:var(--gold)' : 'color:var(--green)';
      const totalLine = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0 4px;border-bottom:1px solid var(--border);margin-bottom:8px">
          <span style="font-size:0.85rem;font-weight:700">Total: ${fmtNum(gas.total)} units</span>
          <span style="font-size:0.85rem;font-weight:700;${daysColor}">${gas.daysLeft != null ? gas.daysLeft + 'd remaining' : '—'}
            <span style="font-size:0.7rem;color:var(--text-dim);font-weight:400"> (${gas.metenoxCount} Metenox × ${gas.consumptionPerHour != null && gas.metenoxCount > 0 ? Math.round(gas.consumptionPerHour / gas.metenoxCount) : 200}/hr)</span>
          </span>
        </div>`;
      const rows = gas.rows.map(r => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:0.8rem;border-bottom:1px solid rgba(255,255,255,.05)">
          <span style="color:var(--text-dim)">${r.system_name ? r.system_name + ' — ' : ''}${r.structure_name}
            <button type="button" onclick="editLocName(${r.location_id},'${r.structure_name.replace(/'/g,"\\'")}')"
              style="margin-left:6px;background:none;border:none;cursor:pointer;font-size:0.72rem;opacity:.5;padding:0" title="Set custom name">✏️</button>
          </span>
          <span style="font-weight:600">${fmtNum(r.qty)}</span>
        </div>`).join('');
      gasEl.innerHTML = totalLine + rows;
    }

    // ── Fuel Blocks ──
    if (!fuel.total) {
      fuelEl.innerHTML = '<p class="dim" style="padding:10px;font-size:0.82rem">No Fuel Blocks found in corp hangars. Run an asset sync first.</p>';
    } else {
      const daysColor = fuel.daysLeft == null ? '' : fuel.daysLeft < 14 ? 'color:var(--red)' : fuel.daysLeft < 30 ? 'color:var(--gold)' : 'color:var(--green)';
      const totalLine = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0 4px;border-bottom:1px solid var(--border);margin-bottom:8px">
          <span style="font-size:0.85rem;font-weight:700">Total: ${fmtNum(fuel.total)} blocks</span>
          <span style="font-size:0.85rem;font-weight:700;${daysColor}">${fuel.daysLeft != null ? fuel.daysLeft + 'd remaining' : '—'}
            <span style="font-size:0.7rem;color:var(--text-dim);font-weight:400"> (${fuel.consumptionPerHour ?? 0} fuel/hr total)</span>
          </span>
        </div>`;
      const rows = fuel.rows.map(r => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:0.8rem;border-bottom:1px solid rgba(255,255,255,.05)">
          <span style="color:var(--text-dim)">${r.system_name ? r.system_name + ' — ' : ''}${r.structure_name}
            <button type="button" onclick="editLocName(${r.location_id},'${r.structure_name.replace(/'/g,"\\'")}')"
              style="margin-left:6px;background:none;border:none;cursor:pointer;font-size:0.72rem;opacity:.5;padding:0" title="Set custom name">✏️</button>
          </span>
          <span><span style="font-size:0.72rem;color:var(--text-dim);margin-right:6px">${r.type_name}</span>
            <strong>${fmtNum(r.qty)}</strong>
          </span>
        </div>`).join('');
      fuelEl.innerHTML = totalLine + rows;
    }

  } catch (err) {
    const msg = `<p class="alert alert-error" style="padding:8px;font-size:0.8rem">${esc(err.message)}</p>`;
    gasEl.innerHTML = fuelEl.innerHTML = msg;
  }
}

// Track current resupply target (days)
let _resupplyTarget = 30;

async function loadResupply(target) {
  if (target !== undefined) _resupplyTarget = target;
  const el = document.getElementById('resupply-content');
  if (!el) return;

  // Highlight active button
  document.querySelectorAll('.resupply-target-btn').forEach(b => {
    b.classList.toggle('btn-primary', parseInt(b.dataset.days, 10) === _resupplyTarget);
    b.classList.toggle('btn-ghost',   parseInt(b.dataset.days, 10) !== _resupplyTarget);
  });

  try {
    const d = await api.get('/api/structures/resupply', { target: _resupplyTarget });

    const fuelDaysColor = d.daysOfFuelRemaining == null ? '' :
      d.daysOfFuelRemaining < 14 ? 'color:var(--red)' :
      d.daysOfFuelRemaining < 30 ? 'color:var(--gold)' : 'color:var(--green)';
    const gasDaysColor = d.daysOfGasRemaining == null ? '' :
      d.daysOfGasRemaining < 7  ? 'color:var(--red)' :
      d.daysOfGasRemaining < 14 ? 'color:var(--gold)' : 'color:var(--green)';

    const fuelSummary = `<strong>${fmtNum(d.totalFuelStock)}</strong> blocks
      <span style="font-size:0.72rem;color:var(--text-dim);margin-left:4px">(${d.fuelConsumptionPerDay}/day)</span>
      ${d.daysOfFuelRemaining != null ? `<span style="${fuelDaysColor};margin-left:4px">${d.daysOfFuelRemaining}d remaining</span>` : ''}`;

    const gasSummary = d.gasConsumptionPerDay > 0
      ? `<strong>${fmtNum(d.totalGasStock)}</strong> units
        <span style="font-size:0.72rem;color:var(--text-dim);margin-left:4px">(${fmtNum(d.gasConsumptionPerDay)}/day)</span>
        ${d.daysOfGasRemaining != null ? `<span style="${gasDaysColor};margin-left:4px">${d.daysOfGasRemaining}d remaining</span>` : ''}`
      : '<span style="color:var(--text-dim);font-size:0.8rem">No Metenox</span>';

    const shopItems = [];
    if (d.fuelNeeded > 0) shopItems.push(
      `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <span>⛽ Buy <strong>${fmtNum(d.fuelNeeded)}</strong> fuel blocks</span>
        <span class="isk">${fmtISK(d.fuelTotalCost)} ISK
          <span style="font-size:0.68rem;color:var(--text-dim);margin-left:4px">@ ${fmtISK(d.fuelPriceEach)} ea</span>
        </span>
      </div>`
    );
    if (d.gasNeeded > 0) shopItems.push(
      `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <span>💨 Buy <strong>${fmtNum(d.gasNeeded)}</strong> Magmatic Gas</span>
        <span class="isk">${fmtISK(d.gasTotalCost)} ISK
          <span style="font-size:0.68rem;color:var(--text-dim);margin-left:4px">@ ${fmtISK(d.gasPriceEach)} ea</span>
        </span>
      </div>`
    );
    if (shopItems.length === 0 && d.grandTotalCost === 0) {
      shopItems.push(`<p style="font-size:0.82rem;color:var(--green);padding:8px 0">Stock is sufficient for ${_resupplyTarget} days.</p>`);
    }
    if (d.grandTotalCost > 0) {
      shopItems.push(
        `<div style="display:flex;justify-content:space-between;padding:8px 0;font-weight:700;font-size:0.9rem">
          <span>Total cost</span>
          <span class="isk">${fmtISK(d.grandTotalCost)} ISK</span>
        </div>`
      );
    }

    el.innerHTML = `
      <div class="grid-2" style="gap:16px;margin-bottom:14px">
        <div style="padding:10px 14px;background:rgba(30,48,79,.35);border-radius:6px;border:1px solid var(--border)">
          <div style="font-size:0.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Fuel Blocks</div>
          <div style="font-size:0.9rem">${fuelSummary}</div>
        </div>
        <div style="padding:10px 14px;background:rgba(30,48,79,.35);border-radius:6px;border:1px solid var(--border)">
          <div style="font-size:0.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Magmatic Gas</div>
          <div style="font-size:0.9rem">${gasSummary}</div>
        </div>
      </div>
      <div style="padding:4px 0">${shopItems.join('')}</div>`;
  } catch (err) {
    el.innerHTML = `<p class="alert alert-error" style="padding:8px;font-size:0.8rem">${esc(err.message)}</p>`;
  }
}

// Wire up resupply target buttons (runs after DOM load — safe because this file loads before app.js)
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.resupply-target-btn').forEach(btn => {
    btn.addEventListener('click', () => loadResupply(parseInt(btn.dataset.days, 10)));
  });
  // Set initial active state
  document.querySelectorAll('.resupply-target-btn').forEach(b => {
    b.classList.toggle('btn-primary', parseInt(b.dataset.days, 10) === _resupplyTarget);
    b.classList.toggle('btn-ghost',   parseInt(b.dataset.days, 10) !== _resupplyTarget);
  });
});

async function loadStructures() {
  loadStructureInventory(); // load gas/fuel stock in parallel
  loadResupply();           // load resupply planner in parallel
  try {
    const resp = await api.get('/api/structures');
    const data = resp.structures || resp;
    const gasConsumptionPerMonth = resp.gasConsumptionPerMonth != null ? resp.gasConsumptionPerMonth : 144000;
    const tbody = document.getElementById('structures-tbody');
    const tfoot = document.getElementById('structures-tfoot');
    const alertsEl = document.getElementById('struct-alerts');

    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty">No structures found. Trigger a sync to load structure data.</td></tr>';
      return;
    }

    // Collect alerts
    const fuelThreshold = 14, gasThreshold = 7;
    const alerts = data.filter(s =>
      (s.fuelDaysLeft != null && s.fuelDaysLeft <= fuelThreshold) ||
      (s.gas?.daysLeft != null && s.gas.daysLeft <= gasThreshold)
    );
    if (alerts.length) {
      alertsEl.innerHTML = alerts.map(s => {
        const parts = [];
        if (s.fuelDaysLeft != null && s.fuelDaysLeft <= fuelThreshold)
          parts.push(`⛽ Fuel: ${s.fuelDaysLeft}d`);
        if (s.gas?.daysLeft != null && s.gas.daysLeft <= gasThreshold)
          parts.push(`💨 Gas: ${s.gas.daysLeft}d`);
        return `<div class="alert alert-warn">⚠️ <strong>${s.name}</strong> (${s.systemName}) — ${parts.join('  ·  ')}</div>`;
      }).join('');
    } else {
      alertsEl.innerHTML = '';
    }

    // Render rows
    tbody.innerHTML = data.map(s => {
      const typeColor = s.typeId === 81826 ? 'var(--green)' : s.typeId === 35835 ? 'var(--gold)' : 'var(--blue)';
      const fuelBar = s.fuelDaysLeft != null
        ? `<div class="bar-outer"><div class="bar-fill ${fuelBarClass(s.fuelDaysLeft)}" style="width:${barPct(s.fuelDaysLeft)}%"></div></div>`
        : '—';
      const fuelDaysCell = s.fuelDaysLeft != null
        ? `<span class="${fuelClass(s.fuelDaysLeft)}">${s.fuelDaysLeft}d</span>` : '—';

      let gasBar = '—', gasDaysCell = '—', gasAction = '';
      if (s.isMetenox) {
        const g = s.gas;
        gasBar = g?.daysLeft != null
          ? `<div class="bar-outer"><div class="bar-fill ${fuelBarClass(g.daysLeft)}" style="width:${barPct(g.daysLeft, 60)}%"></div></div>`
          : '<span class="dim">Not set</span>';
        gasDaysCell = g?.daysLeft != null
          ? `<span class="${fuelClass(g.daysLeft)}">${g.daysLeft}d</span>`
          : '<span class="dim">?</span>';
        gasAction = `<button class="btn btn-ghost btn-small" onclick="openGasModal(${s.structureId},'${s.name.replace(/'/g, "\\'")}',${JSON.stringify(s.gas || {}).replace(/"/g, '&quot;')})">💨 Gas</button>`;
      }

      return `<tr>
        <td><strong>${s.name}</strong></td>
        <td><span style="color:${typeColor}">${s.typeName}</span></td>
        <td>${s.systemName}</td>
        <td class="text-right dim">${fmtDate(s.fuelExpires)}</td>
        <td class="text-right">${fuelDaysCell}</td>
        <td>${fuelBar}</td>
        <td class="text-right isk">${s.fuelPerMonth != null ? s.fuelPerMonth.toLocaleString() : '—'} <button type="button" class="btn btn-ghost btn-small structure-fuel-edit" style="padding:2px 6px;font-size:0.7rem;margin-left:4px" data-structure-id="${s.structureId}" data-fuel-value="${s.fuelPerMonth != null ? s.fuelPerMonth : ''}" data-override="${s.fuelOverride ? '1' : '0'}" data-name="${(s.name || '').replace(/"/g, '&quot;')}" title="Override fuel/mo (leave empty for automatic)">✏️</button></td>
        <td class="text-right">${gasDaysCell}</td>
        <td>${gasBar}</td>
        <td>${gasAction}</td>
      </tr>`;
    }).join('');

    // Footer totals — fuel/mo and gas/mo from API (fuel = sum of per-structure consumption from online services)
    const totalFuelPerMonth = data.reduce((s, r) => s + (r.fuelPerMonth || 0), 0);
    const gasPerMonth   = data.filter(r => r.isMetenox).length * gasConsumptionPerMonth;
    tfoot.innerHTML = `<tr>
      <td colspan="3"><strong>Totals</strong></td>
      <td></td><td></td><td></td>
      <td class="isk" title="Fuel blocks per month from online service modules."><strong>${totalFuelPerMonth.toLocaleString()} fuel/mo</strong></td>
      <td></td>
      <td class="isk" title="Metenox gas units per month (Settings → Gas consumption per month)."><strong>${gasPerMonth.toLocaleString()} gas/mo</strong></td>
      <td></td>
    </tr>`;

  } catch (err) {
    document.getElementById('structures-tbody').innerHTML =
      `<tr><td colspan="10" class="alert alert-error">Error: ${esc(err.message)}</td></tr>`;
  }
}

function editStructureFuel(btn) {
  const id = btn.dataset.structureId;
  const currentValue = btn.dataset.fuelValue;
  const structureName = (btn.dataset.name || '').replace(/&quot;/g, '"');
  document.getElementById('fuel-override-id').value = id;
  document.getElementById('fuel-override-name').textContent = structureName || 'Structure';
  const input = document.getElementById('fuel-override-value');
  const num = currentValue !== '' ? parseInt(currentValue, 10) : NaN;
  input.value = (!isNaN(num) && num >= 0) ? num : '';
  document.getElementById('fuel-override-modal').style.display = 'flex';
  setTimeout(() => input.focus(), 50);
}

async function saveFuelOverride() {
  const id = document.getElementById('fuel-override-id').value;
  const raw = document.getElementById('fuel-override-value').value.trim();
  try {
    await api.put(`/api/structures/${id}/fuel-override`, { fuelPerMonth: raw === '' ? null : parseInt(raw, 10) });
    document.getElementById('fuel-override-modal').style.display = 'none';
    loadStructures();
    loadStructureInventory();
  } catch (err) {
    toast('Failed to save: ' + err.message, 'error');
  }
}

async function clearFuelOverride() {
  const id = document.getElementById('fuel-override-id').value;
  try {
    await api.put(`/api/structures/${id}/fuel-override`, { fuelPerMonth: null });
    document.getElementById('fuel-override-modal').style.display = 'none';
    loadStructures();
    loadStructureInventory();
  } catch (err) {
    toast('Failed to clear: ' + err.message, 'error');
  }
}

function openGasModal(structureId, name, gasData) {
  document.getElementById('gas-modal-id').value = structureId;
  document.getElementById('gas-modal-name').textContent = name;
  document.getElementById('gas-refill-date').value   = gasData.lastRefillDate   || '';
  document.getElementById('gas-qty').value            = gasData.quantityRefilled  || '';
  document.getElementById('gas-daily').value          = gasData.dailyConsumption  || 4800;
  document.getElementById('gas-notes').value          = gasData.notes             || '';
  const modal = document.getElementById('gas-modal');
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('gas-refill-date')?.focus(), 50);
}

function closeGasModal() {
  document.getElementById('gas-modal').style.display = 'none';
}

async function saveGasModal() {
  const id = document.getElementById('gas-modal-id').value;
  try {
    await api.put(`/api/structures/${id}/gas`, {
      lastRefillDate:  document.getElementById('gas-refill-date').value,
      quantityRefilled: parseInt(document.getElementById('gas-qty').value, 10),
      dailyConsumption: parseInt(document.getElementById('gas-daily').value, 10),
      notes:           document.getElementById('gas-notes').value,
    });
    closeGasModal();
    loadStructures();
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  }
}

document.getElementById('gas-modal-cancel').addEventListener('click', closeGasModal);
document.getElementById('gas-modal-save').addEventListener('click', saveGasModal);
document.getElementById('gas-modal')?.addEventListener('mousedown', e => {
  if (e.target === e.currentTarget) closeGasModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('gas-modal')?.style.display === 'flex')
    closeGasModal();
});

document.getElementById('fuel-override-save').addEventListener('click', saveFuelOverride);
document.getElementById('fuel-override-cancel').addEventListener('click', () => {
  document.getElementById('fuel-override-modal').style.display = 'none';
});
document.getElementById('fuel-override-clear').addEventListener('click', clearFuelOverride);
document.getElementById('fuel-override-modal').addEventListener('mousedown', e => {
  if (e.target === e.currentTarget) document.getElementById('fuel-override-modal').style.display = 'none';
});
document.getElementById('fuel-override-value').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('fuel-override-save').click();
  if (e.key === 'Escape') document.getElementById('fuel-override-cancel').click();
});

document.getElementById('structures-table')?.addEventListener('click', e => {
  const btn = e.target.closest('.structure-fuel-edit');
  if (btn) editStructureFuel(btn);
});

// ── Manual location name override ─────────────────────────────────────────────
let _locRenameId = null;

function editLocName(locationId, currentName) {
  _locRenameId = locationId;
  const input = document.getElementById('loc-rename-input');
  input.value = currentName || '';
  document.getElementById('loc-rename-modal').style.display = 'flex';
  setTimeout(() => input.focus(), 50);
}

document.getElementById('loc-rename-cancel').addEventListener('click', () => {
  document.getElementById('loc-rename-modal').style.display = 'none';
  _locRenameId = null;
});

document.getElementById('loc-rename-modal').addEventListener('mousedown', e => {
  if (e.target === e.currentTarget) {
    document.getElementById('loc-rename-modal').style.display = 'none';
    _locRenameId = null;
  }
});

document.getElementById('loc-rename-save').addEventListener('click', async () => {
  if (_locRenameId == null) return;
  const newName = document.getElementById('loc-rename-input').value;
  document.getElementById('loc-rename-modal').style.display = 'none';
  try {
    await api.put('/api/structures/location-name', { locationId: _locRenameId, name: newName });
    loadStructureInventory();
  } catch (err) {
    toast('Failed to save name: ' + err.message, 'error');
  }
  _locRenameId = null;
});

document.getElementById('loc-rename-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loc-rename-save').click();
  if (e.key === 'Escape') document.getElementById('loc-rename-cancel').click();
});
