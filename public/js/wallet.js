let journalPage = 1;
let journalPages = 1;

async function loadWallet() {
  await Promise.all([
    loadDivisionHistory(),
    loadPnl(),
    loadCorpFlowChart(),
    loadTaxCharts(),
    loadJournal(),
    loadWalletHistory(),
  ]);
}

let _divHistoryChart = null;

async function loadDivisionHistory() {
  const canvas = document.getElementById('wallet-trend-chart');
  const section = document.getElementById('division-history-content');
  if (!canvas) return;

  try {
    const data = await api.get('/api/wallet/division-history');

    if (!data.months || !data.months.length) {
      if (_divHistoryChart) { _divHistoryChart.destroy(); _divHistoryChart = null; }
      if (canvas) canvas.style.display = 'none';
      const msg = document.getElementById('div-history-empty');
      if (!msg && section) {
        const p = document.createElement('p');
        p.id = 'div-history-empty';
        p.className = 'dim';
        p.style.cssText = 'padding:12px;font-size:0.82rem';
        p.textContent = 'Division balance history will appear here after the next sync.';
        section.appendChild(p);
      }
      return;
    }

    // Hide empty message, show canvas
    const emptyMsg = document.getElementById('div-history-empty');
    if (emptyMsg) emptyMsg.remove();
    if (canvas) canvas.style.display = '';

    const EVE_COLORS = [
      '#00b4d8', '#48cae4', '#90e0ef', '#0077b6', '#023e8a',
      '#e9c46a', '#f4a261', '#e76f51', '#a8dadc', '#457b9d',
    ];

    const datasets = Object.entries(data.divisions).map(([div, balances], idx) => ({
      label: `Div ${div}`,
      data: balances,
      borderColor: EVE_COLORS[idx % EVE_COLORS.length],
      backgroundColor: EVE_COLORS[idx % EVE_COLORS.length] + '22',
      tension: 0.3,
      fill: false,
      spanGaps: true,
    }));

    if (_divHistoryChart) { _divHistoryChart.destroy(); _divHistoryChart = null; }

    const ctx = document.getElementById('wallet-trend-chart');
    if (!ctx) return;

    _divHistoryChart = new Chart(ctx, {
      type: 'line',
      data: { labels: data.months, datasets },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'top', labels: { color: '#c5d5e8', boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${fmtISK(ctx.parsed.y)} ISK`,
            },
          },
        },
        scales: {
          x: { ticks: { color: '#8899aa' }, grid: { color: '#1e304f' } },
          y: {
            ticks: { color: '#8899aa', callback: v => fmtISK(v) },
            grid: { color: '#1e304f' },
          },
        },
      },
    });
  } catch (err) {
    if (section) section.innerHTML = `<p class="alert alert-error" style="padding:8px;font-size:0.8rem">${esc(err.message)}</p>`;
  }
}

async function loadTaxCharts() {
  try {
    const period = document.getElementById('wallet-period-select').value || undefined;
    const [groups, top5, rates] = await Promise.all([
      api.get('/api/wallet/groups', period ? { period } : {}),
      api.get('/api/wallet/taxpayers', { limit: 5, ...(period ? { period } : {}) }),
      api.get('/api/wallet/rates'),
    ]);

    // Tax rates info
    const ratesEl = document.getElementById('tax-rates-info');
    if (ratesEl) {
      const iskStr = rates.taxRatePercent != null ? `${rates.taxRatePercent}%` : '—';
      ratesEl.textContent = `ISK tax: ${iskStr}${!rates.taxRatePercent ? ' (set in Settings)' : ''}`;
    }

    // Donut chart — by main group
    if (groups.data && groups.data.length) {
      makeDoughnutChart('chart-tax-donut',
        groups.data.map(g => g.main_name || 'Unknown'),
        groups.data.map(g => g.total),
      );
    }

    // Top 5 list
    const el = document.getElementById('top5-tax');
    if (!top5.data || top5.data.length === 0) {
      el.innerHTML = '<p class="empty">No tax data available for this period.</p>'; return;
    }
    const max = top5.data[0].total_amount;
    const medals = ['🥇', '🥈', '🥉', '4th', '5th'];
    el.innerHTML = `
      <table><thead><tr><th>#</th><th>Character</th><th>Main Group</th><th class="text-right">Total ISK</th><th style="min-width:150px">Share</th></tr></thead>
      <tbody>${top5.data.map((d, i) => `
        <tr>
          <td class="dim">${medals[i] || (i+1)}</td>
          <td><strong>${d.character_name}</strong></td>
          <td class="dim">${d.main_name !== d.character_name ? d.main_name : '—'}</td>
          <td class="text-right isk">${fmtISK(d.total_amount)} ISK</td>
          <td><div class="bar-outer"><div class="bar-fill bar-green" style="width:${(d.total_amount/max*100).toFixed(1)}%"></div></div></td>
        </tr>`).join('')}
      </tbody></table>`;

  } catch (err) {
    console.error('Tax chart error:', err);
  }
}

async function loadWalletHistory() {
  try {
    const rows = await api.get('/api/wallet/history', { days: 30 });
    if (!rows.length) return;
    makeLineChart('chart-wallet-balance',
      rows.map(r => r.day),
      [{
        label: 'TAX income',
        data: rows.map(r => r.balance),
        borderColor: '#4a9eff',
        backgroundColor: 'rgba(74,158,255,.1)',
        fill: true, tension: 0.3,
      }]
    );
  } catch (err) {
    console.error('Wallet history error:', err);
  }
}

let _corpFlowData = [];

async function loadCorpFlowChart() {
  try {
    const rows = await api.get('/api/wallet/monthly-flow', { months: 12 });
    _corpFlowData = rows;
    if (!rows.length) return;
    makeFlowChart(
      'chart-corp-flow',
      rows.map(r => r.month),
      rows.map(r => r.income),
      rows.map(r => r.expenses),
      rows.map(r => r.net),
    );
  } catch (err) {
    console.error('Corp flow chart error:', err);
  }
}

document.getElementById('btn-export-flow-csv')?.addEventListener('click', async () => {
  try {
    // Fetch all available months (months=0) for the export — not just the 12 shown in the chart
    const rows = await api.get('/api/wallet/monthly-flow', { months: 0 });
    if (!rows.length) { toast('No data to export.', 'error'); return; }
    const lines = ['Month,Income (ISK),Expenses (ISK),Net (ISK)'];
    for (const r of rows) lines.push([r.month, r.income, r.expenses, r.net].join(','));
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'corp-monthly-flow.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast('Export failed: ' + err.message, 'error');
  }
});

async function loadJournal() {
  const filter = document.getElementById('journal-filter').value.trim();
  const search = document.getElementById('journal-search')?.value.trim() || '';
  try {
    const period = document.getElementById('wallet-period-select').value || undefined;
    const data = await api.get('/api/wallet/journal', {
      page: journalPage,
      ...(filter ? { type: filter } : {}),
      ...(period ? { period } : {}),
      ...(search ? { search } : {}),
    });

    journalPages = data.pages;
    document.getElementById('journal-page-info').textContent =
      `Page ${data.page} of ${data.pages} (${data.total.toLocaleString()} entries)`;
    document.getElementById('journal-prev').disabled = journalPage <= 1;
    document.getElementById('journal-next').disabled = journalPage >= journalPages;

    const tbody = document.getElementById('journal-tbody');
    if (!data.rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No journal entries found.</td></tr>'; return;
    }

    tbody.innerHTML = data.rows.map(r => {
      const amtClass = r.amount >= 0 ? 'green' : 'red';
      const amtSign  = r.amount >= 0 ? '+' : '';
      return `<tr>
        <td class="dim">${fmtDate(r.date)}</td>
        <td class="dim">${r.division}</td>
        <td style="font-size:0.72rem;color:var(--text-dim)">${r.ref_type}</td>
        <td style="font-size:0.75rem">${r.second_party_id ? `<span class="dim">${r.second_party_id}</span>` : '—'}</td>
        <td class="text-right ${amtClass}">${amtSign}${fmtISK(r.amount)} ISK</td>
        <td class="text-right isk">${fmtISK(r.balance)} ISK</td>
      </tr>`;
    }).join('');
  } catch (err) {
    document.getElementById('journal-tbody').innerHTML =
      `<tr><td colspan="6" class="alert alert-error">Error: ${esc(err.message)}</td></tr>`;
  }
}

// Load available periods for the selector
// The "Last 30 days" default option (value="") is already in the HTML.
// We append historical months below it so the user can browse past months.
async function loadWalletPeriods() {
  try {
    const periods = await api.get('/api/wallet/periods');
    const sel = document.getElementById('wallet-period-select');
    periods.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      sel.appendChild(opt);
    });
  } catch { /* ignore */ }
}

document.getElementById('journal-prev').addEventListener('click', () => {
  if (journalPage > 1) { journalPage--; loadJournal(); }
});
document.getElementById('journal-next').addEventListener('click', () => {
  if (journalPage < journalPages) { journalPage++; loadJournal(); }
});
document.getElementById('journal-filter').addEventListener('keydown', e => {
  if (e.key === 'Enter') { journalPage = 1; loadJournal(); }
});
document.getElementById('journal-search')?.addEventListener('input', () => {
  journalPage = 1;
});
document.getElementById('journal-search')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { journalPage = 1; loadJournal(); }
});
document.getElementById('journal-search-btn')?.addEventListener('click', () => {
  journalPage = 1;
  loadJournal();
});

async function downloadCsv(url, defaultFilename) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(res.statusText);
  const blob = await res.blob();
  const name = res.headers.get('Content-Disposition')?.match(/filename="?([^";\n]+)"?/)?.[1] || defaultFilename;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById('journal-export-csv').addEventListener('click', async () => {
  const period = document.getElementById('wallet-period-select').value || '';
  const type   = document.getElementById('journal-filter').value.trim() || 'all';
  const params = new URLSearchParams();
  if (period) params.set('period', period);
  if (type !== 'all') params.set('type', type);
  try {
    await downloadCsv(`/api/wallet/journal/export?${params}`, 'wallet-journal.csv');
  } catch (err) {
    toast('Export failed: ' + err.message, 'error');
  }
});

document.getElementById('wallet-export-tax-csv').addEventListener('click', async () => {
  const period = document.getElementById('wallet-period-select').value || '';
  const params = period ? `?period=${encodeURIComponent(period)}` : '';
  try {
    await downloadCsv(`/api/wallet/tax-summary/export${params}`, 'tax-summary.csv');
  } catch (err) {
    toast('Export failed: ' + err.message, 'error');
  }
});

document.getElementById('wallet-period-select').addEventListener('change', () => {
  journalPage = 1; loadPnl(); loadTaxCharts(); loadJournal();
});

// Period presets: set select and reload
function setWalletPeriod(value) {
  const sel = document.getElementById('wallet-period-select');
  if (!sel) return;
  if (value === '') {
    sel.value = '';
  } else if (value === 'this') {
    const yyyyMm = new Date().toISOString().slice(0, 7);
    if (![...sel.options].some(o => o.value === yyyyMm)) {
      const opt = document.createElement('option');
      opt.value = yyyyMm;
      opt.textContent = yyyyMm;
      sel.appendChild(opt);
    }
    sel.value = yyyyMm;
  } else if (value === 'last') {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    const yyyyMm = d.toISOString().slice(0, 7);
    if (![...sel.options].some(o => o.value === yyyyMm)) {
      const opt = document.createElement('option');
      opt.value = yyyyMm;
      opt.textContent = yyyyMm;
      sel.appendChild(opt);
    }
    sel.value = yyyyMm;
  } else {
    sel.value = value;
  }
  journalPage = 1;
  loadPnl();
  loadTaxCharts();
  loadJournal();
}
document.querySelectorAll('#tab-wallet .period-preset[data-period]').forEach(btn => {
  btn.addEventListener('click', () => setWalletPeriod(btn.dataset.period));
});

// ── P&L (Multi-Wallet T-Account View) ─────────────────────────────────────────

function fmtRefType(s) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function loadPnl() {
  const period = document.getElementById('wallet-period-select').value || null;
  try {
    const data = await api.get('/api/wallet/multi-pnl', period ? { period } : {});
    renderPnl(data);
  } catch (err) {
    console.error('P&L error:', err);
  }
}

function renderPnl(data) {
  // Consolidated KPI tiles
  const c        = data.consolidated;
  const netColor = c.realNet >= 0 ? 'var(--green)' : 'var(--red)';
  const netSign  = c.realNet >= 0 ? '+' : '';
  document.getElementById('pnl-income').textContent   = fmtISK(c.realIncome)   + ' ISK';
  document.getElementById('pnl-expenses').textContent = fmtISK(c.realExpenses) + ' ISK';
  const netEl = document.getElementById('pnl-net');
  netEl.textContent = netSign + fmtISK(c.realNet) + ' ISK';
  netEl.style.color = netColor;
  document.getElementById('pnl-period-label').textContent = data.period;

  // Per-division T-account cards — dynamically rendered for however many divisions are active
  const accountsEl = document.getElementById('pnl-accounts');
  const divKeys = Object.keys(data.divisions).map(Number).sort((a, b) => a - b);
  if (!divKeys.length) {
    accountsEl.innerHTML = '<p class="empty">No wallet activity this period.</p>';
    return;
  }
  accountsEl.innerHTML = divKeys.map(divNum => {
    const div = data.divisions[divNum];
    return `<div class="card">
      <div class="card-title" style="font-size:0.78rem">${esc(div.name)}</div>
      ${renderPnlDivision(div)}
    </div>`;
  }).join('');
}

/** Render a single-division T-account view (external + internal separated). */
function renderPnlDivision(div) {
  if (!div) return '<p class="empty" style="font-size:0.78rem">No data.</p>';

  const allIn  = div.extIn  + div.intIn;
  const allOut = div.extOut + div.intOut;
  const maxBar = Math.max(allIn, allOut, 1);
  const netColor = div.net >= 0 ? 'var(--green)' : 'var(--red)';
  const netSign  = div.net >= 0 ? '+' : '';

  // Balance + net row
  let html = `<div style="display:flex;justify-content:space-between;font-size:0.73rem;margin-bottom:8px;gap:10px">`;
  if (div.currentBalance !== null) {
    html += `<span style="color:var(--text-dim)">Balance: <strong style="color:var(--isk)">${fmtISK(div.currentBalance)} ISK</strong></span>`;
  }
  html += `<span style="color:var(--text-dim);margin-left:auto">Net: <strong style="color:${netColor}">${netSign}${fmtISK(div.net)} ISK</strong></span>`;
  html += `</div>`;

  const makeRows = (rows, color, cssClass) => rows.map(r => {
    const pct = (r.total / maxBar * 100).toFixed(1);
    const amtStyle = cssClass ? `class="${cssClass}"` : `style="color:${color};font-size:0.7rem"`;
    return `<div style="margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;font-size:0.71rem;margin-bottom:2px">
        <span style="color:var(--text-dim)">${esc(fmtRefType(r.refType))}</span>
        <span ${amtStyle} style="font-size:0.7rem">${fmtISK(r.total)}</span>
      </div>
      <div class="bar-outer">
        <div style="height:100%;border-radius:4px;background:${color};width:${pct}%;transition:width 0.3s"></div>
      </div>
    </div>`;
  }).join('');

  // External IN
  if (div.externalCredits.length) {
    html += `<div style="font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:var(--green);margin-bottom:5px;font-weight:700">▲ IN — ${fmtISK(div.extIn)}</div>`;
    html += makeRows(div.externalCredits, 'var(--green)', 'isk');
  }

  // External OUT (real expenses)
  if (div.externalDebits.length) {
    html += `<div style="font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:var(--red);margin:10px 0 5px;font-weight:700">▼ OUT — ${fmtISK(div.extOut)}</div>`;
    html += makeRows(div.externalDebits, 'var(--red)', null);
  }

  // Internal flows (inter-division transfers) — shown dimmed at bottom
  const hasInternal = div.internalCredits.length || div.internalDebits.length;
  if (hasInternal) {
    html += `<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(30,48,79,.6)">
      <div style="font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-dim);margin-bottom:6px;font-weight:700">↔ INTER-DIVISION TRANSFERS</div>`;
    if (div.internalCredits.length) {
      html += `<div style="font-size:0.63rem;color:var(--text-dim);margin-bottom:4px">▲ received ${fmtISK(div.intIn)}</div>`;
      html += makeRows(div.internalCredits, 'rgba(0,212,170,.35)', null);
    }
    if (div.internalDebits.length) {
      html += `<div style="font-size:0.63rem;color:var(--text-dim);margin:6px 0 4px">▼ sent ${fmtISK(div.intOut)}</div>`;
      html += makeRows(div.internalDebits, 'rgba(255,85,85,.3)', null);
    }
    html += `</div>`;
  }

  if (!div.externalCredits.length && !div.externalDebits.length && !hasInternal) {
    html += '<p class="empty" style="font-size:0.78rem">No wallet entries this period.</p>';
  }

  return html;
}
