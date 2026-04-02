let metenoxData      = [];
let metenoxSortKey   = 'monthlyProfit';
let metenoxSortAsc   = false;
let jitaFactor       = 100;           // 10–100 (%)
let modalStructureId = null;
let moonOreTypes     = [];            // cached for the dropdown

// ── Jita factor helpers ────────────────────────────────────────────────────────
function applyFactor(structures) {
  if (jitaFactor === 100) return structures; // no change needed
  const f = jitaFactor / 100;
  return structures.map(s => {
    const monthlyRevenue = (s.materials || []).reduce(
      (sum, m) => sum + (m.qty || 0) * (m.unitPrice || 0) * f, 0
    );
    const monthlyProfit = monthlyRevenue - s.monthlyCost;
    return { ...s, monthlyRevenue: Math.round(monthlyRevenue), monthlyProfit: Math.round(monthlyProfit) };
  });
}

// ── Main load ─────────────────────────────────────────────────────────────────
async function loadMetenox() {
  try {
    const data = await api.get('/api/metenox');
    metenoxData = data.structures;

    if (data.pricesUpdatedAt) {
      const age = Math.round((Date.now() - new Date(data.pricesUpdatedAt)) / 60000);
      document.getElementById('metenox-price-age').textContent =
        `Jita prices updated ${age < 2 ? 'just now' : age + ' min ago'}`;
    }

    renderMetenoxTable();
    renderMetenoxChart(data);
    renderMetenoxTotals(data.totals);

  } catch (err) {
    document.getElementById('metenox-tbody').innerHTML =
      `<tr><td colspan="8" class="alert alert-error">Error: ${esc(err.message)}</td></tr>`;
  }
}

// ── Table ─────────────────────────────────────────────────────────────────────
function renderMetenoxTable() {
  const adjusted = applyFactor(metenoxData);
  const sorted   = [...adjusted].sort((a, b) => {
    const va = a[metenoxSortKey] ?? -Infinity;
    const vb = b[metenoxSortKey] ?? -Infinity;
    if (typeof va === 'string') return metenoxSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return metenoxSortAsc ? va - vb : vb - va;
  });

  // Also recompute totals row from adjusted data
  const totals = {
    totalRevenue: adjusted.reduce((a, b) => a + b.monthlyRevenue, 0),
    totalCost:    adjusted.reduce((a, b) => a + b.monthlyCost,    0),
    totalProfit:  adjusted.reduce((a, b) => a + b.monthlyProfit,  0),
  };
  renderMetenoxTotals(totals);

  const tbody = document.getElementById('metenox-tbody');
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No Metenox structures found. Ensure you have the esi-corporations.read_structures.v1 scope.</td></tr>';
    return;
  }

  tbody.innerHTML = sorted.map(s => {
    const profitClass = s.monthlyProfit > 0 ? 'green' : s.monthlyProfit < 0 ? 'red' : 'dim';
    const badge = s.monthlyProfit > 0
      ? '<span class="badge badge-green">Profitable</span>'
      : s.monthlyProfit > -10_000_000
        ? '<span class="badge badge-gold">Break-even</span>'
        : '<span class="badge badge-red">Loss</span>';
    const hasData    = s.materials && s.materials.length > 0;
    const dataSource = s.hasObserverData
      ? '<span title="ESI observer data" style="font-size:0.65rem;color:var(--green);margin-left:4px">●ESI</span>'
      : hasData
        ? '<span title="Manual entry data" style="font-size:0.65rem;color:var(--gold);margin-left:4px">●Manual</span>'
        : '';

    return `<tr>
      <td><strong>${s.name}</strong>${dataSource}${!hasData ? ' <span class="dim" style="font-size:0.7rem">(no price data)</span>' : ''}</td>
      <td>${s.systemName}</td>
      <td class="text-right ${fuelClass(s.fuelDaysLeft)}">${s.fuelDaysLeft != null ? s.fuelDaysLeft.toFixed(1) + 'd' : '—'}</td>
      <td class="text-right isk">${hasData ? fmtISK(s.monthlyRevenue) + ' ISK' : '—'}</td>
      <td class="text-right" style="color:var(--red)">${fmtISK(s.monthlyCost)} ISK</td>
      <td class="text-right ${profitClass}">${hasData ? (s.monthlyProfit >= 0 ? '+' : '') + fmtISK(s.monthlyProfit) + ' ISK' : '—'}</td>
      <td class="text-center">${hasData ? badge : '<span class="dim">awaiting data</span>'}</td>
      <td class="text-center">
        <button class="btn btn-ghost btn-small" title="Edit manual materials"
                onclick="openManualModal(${s.structureId}, '${s.name.replace(/'/g, "\\'")}')">✏ Edit</button>
      </td>
    </tr>`;
  }).join('');
}

function renderMetenoxTotals(totals) {
  if (!totals) return;
  const profitClass = totals.totalProfit >= 0 ? 'green' : 'red';
  document.getElementById('metenox-tfoot').innerHTML = `<tr>
    <td colspan="3"><strong>Fleet Total</strong></td>
    <td class="text-right isk"><strong>${fmtISK(totals.totalRevenue)} ISK</strong></td>
    <td class="text-right" style="color:var(--red)"><strong>${fmtISK(totals.totalCost)} ISK</strong></td>
    <td class="text-right ${profitClass}"><strong>${totals.totalProfit >= 0 ? '+' : ''}${fmtISK(totals.totalProfit)} ISK</strong></td>
    <td></td><td></td>
  </tr>`;
}

function renderMetenoxChart(data) {
  const adjusted   = applyFactor(data.structures);
  const structures = [...adjusted].sort((a, b) => b.monthlyProfit - a.monthlyProfit);
  const labels     = structures.map(s => s.systemName || s.name);
  const values     = structures.map(s => s.monthlyProfit || 0);
  const theme      = getThemeColors();
  const colors     = values.map(v => v >= 0 ? theme.green : theme.red);

  destroyChart('chart-metenox');
  charts['chart-metenox'] = new Chart(document.getElementById('chart-metenox'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Net Profit/mo', data: values, backgroundColor: colors, borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${fmtISK(ctx.raw)} ISK/mo` } },
      },
      scales: {
        x: { grid: { color: 'rgba(30,48,79,.5)' }, ticks: { color: '#7a95b5', callback: v => fmtISK(v) } },
        y: { grid: { display: false }, ticks: { color: '#c5d5e8' } },
      },
    },
  });
}

// ── Jita factor slider ────────────────────────────────────────────────────────
document.getElementById('jita-factor-slider')?.addEventListener('input', e => {
  jitaFactor = parseInt(e.target.value, 10);
  document.getElementById('jita-factor-val').textContent = jitaFactor + '%';
  renderMetenoxTable();
  // Redraw chart with existing metenoxData
  if (metenoxData.length) {
    renderMetenoxChart({ structures: metenoxData });
  }
});

// ── Sort headers ──────────────────────────────────────────────────────────────
document.querySelectorAll('#metenox-table th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (metenoxSortKey === key) metenoxSortAsc = !metenoxSortAsc;
    else { metenoxSortKey = key; metenoxSortAsc = false; }
    renderMetenoxTable();
  });
});

// ── Manual materials modal ────────────────────────────────────────────────────
async function openManualModal(structureId, structureName) {
  modalStructureId = structureId;
  document.getElementById('modal-structure-name').textContent = structureName;
  const modal = document.getElementById('metenox-manual-modal');
  modal.style.display = 'flex';

  // Load type dropdown once
  if (moonOreTypes.length === 0) {
    try {
      moonOreTypes = await api.get('/api/metenox/materials/types');
    } catch (_) {
      moonOreTypes = [];
    }
  }
  const sel = document.getElementById('manual-type-select');
  const byGroup = {};
  for (const t of moonOreTypes) {
    const label = t.groupLabel || ('R' + (t.tier || '') + ' Materials');
    if (!byGroup[label]) byGroup[label] = [];
    byGroup[label].push(t);
  }
  sel.innerHTML = '<option value="">— select material —</option>' +
    Object.entries(byGroup).map(([label, items]) =>
      '<optgroup label="' + String(label).replace(/"/g, '&quot;') + '">' +
      items.map(t => `<option value="${t.type_id}" data-name="${(t.type_name || '').replace(/"/g, '&quot;')}">R${t.tier || ''} ${t.type_name}</option>`).join('') +
      '</optgroup>'
    ).join('');

  await refreshManualTable();
}

function closeManualModal() {
  document.getElementById('metenox-manual-modal').style.display = 'none';
  modalStructureId = null;
  // Reload main table so changes are reflected
  loadMetenox();
}

async function refreshManualTable() {
  const tbody = document.getElementById('manual-materials-tbody');
  tbody.innerHTML = '<tr><td colspan="4" class="dim" style="padding:10px;text-align:center;font-size:0.8rem">Loading…</td></tr>';
  try {
    const rows = await api.get(`/api/metenox/manual/${modalStructureId}`);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="dim" style="padding:12px;text-align:center;font-size:0.8rem">No manual materials set. Add rows below.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const monthlyQty = r.qty_per_hour * 720;
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:7px 8px;font-size:0.85rem">${r.type_name}</td>
        <td style="padding:7px 8px;text-align:right;font-size:0.85rem">${fmtNum(r.qty_per_hour)} / hr</td>
        <td style="padding:7px 8px;text-align:right;font-size:0.75rem;color:var(--text-dim)">${fmtNum(Math.round(monthlyQty))} units/mo</td>
        <td style="padding:7px 4px;text-align:center">
          <button class="btn btn-danger btn-small" onclick="deleteManualRow(${r.type_id})">✕</button>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="alert alert-error" style="padding:8px">${esc(err.message)}</td></tr>`;
  }
}

async function addManualMaterialRow() {
  const sel     = document.getElementById('manual-type-select');
  const typeId   = parseInt(sel.value, 10);
  const typeName = sel.options[sel.selectedIndex]?.dataset?.name || sel.options[sel.selectedIndex]?.text || '';
  const qtyHour  = parseFloat(document.getElementById('manual-qty-day').value);

  if (!typeId || !typeName || isNaN(qtyHour) || qtyHour <= 0) {
    toast('Please select a material and enter a quantity per hour > 0.', 'error');
    return;
  }

  try {
    await api.post(`/api/metenox/manual/${modalStructureId}`, {
      typeId,
      typeName,
      qtyPerHour: qtyHour,   // stored directly as qty/hr
    });
    document.getElementById('manual-qty-day').value = '';
    sel.value = '';
    await refreshManualTable();
  } catch (err) {
    toast('Error saving: ' + err.message, 'error');
  }
}

async function deleteManualRow(typeId) {
  if (!confirm('Remove this material?')) return;
  try {
    await api.del(`/api/metenox/manual/${modalStructureId}/${typeId}`);
    await refreshManualTable();
  } catch (err) {
    toast('Error deleting: ' + err.message, 'error');
  }
}

// Close modal when clicking backdrop; Escape to close
document.getElementById('metenox-manual-modal')?.addEventListener('mousedown', e => {
  if (e.target === e.currentTarget) closeManualModal();
});
document.getElementById('metenox-manual-modal')?.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeManualModal(); e.preventDefault(); }
});
