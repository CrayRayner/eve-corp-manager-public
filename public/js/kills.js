// ── Corp Kills Tab ────────────────────────────────────────────────────────────
async function loadKills() {
  const periodSel = document.getElementById('kills-period');
  const period    = periodSel?.value || 'rolling30';

  try {
    const [data, historyRes] = await Promise.all([
      api.get(`/api/kills?period=${period}`),
      api.get('/api/kills/history'),
    ]);

    // Populate period selector — rolling30 always first, labelled "Last 30 days"
    if (periodSel && data.periods?.length) {
      const current = periodSel.value || 'rolling30';
      periodSel.innerHTML = data.periods.map(p =>
        `<option value="${p}" ${p === current ? 'selected' : ''}>${p === 'rolling30' ? 'Last 30 days' : p}</option>`
      ).join('');
    }

    document.getElementById('kills-total').textContent        = data.totalKills;
    document.getElementById('kills-period-label').textContent = data.periodLabel || data.period;

    // Top 10 killers
    const top10El = document.getElementById('kills-top10');
    if (!data.top10 || data.top10.length === 0) {
      top10El.innerHTML = '<p class="empty">No kill data for this period. Click "Sync Kills" to fetch from zKillboard.</p>';
      destroyChart('chart-kills');
    } else {
      const maxKills = data.top10[0]?.kills || 1;
      const medals   = ['🥇', '🥈', '🥉'];
      top10El.innerHTML = data.top10.map((k, i) => `
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span>${medals[i] || (i + 1) + '.'} <strong>${k.mainName}</strong></span>
            <span style="color:var(--isk)">${k.kills} kills &nbsp;·&nbsp; ${fmtISK(k.totalValue)} ISK</span>
          </div>
          <div class="bar-outer">
            <div class="bar-fill bar-red" style="width:${(k.kills / maxKills * 100).toFixed(1)}%"></div>
          </div>
        </div>`).join('');

      // Doughnut — kills share per pilot, ship icon on slice or leader line for small slices
      buildPilotDoughnut({
        canvasId:  'chart-kills',
        legendId:  'kills-pie-legend',
        top10:     data.top10,
        valueKey:  'kills',
        valueSuffix: 'kills',
      });
    }

    // Kill history chart: total kills + ISK destroyed per month
    const history = historyRes?.history || [];
    if (history.length === 0) {
      destroyChart('chart-kills-history');
    } else {
      const theme = getThemeColors();
      const labels = history.map(h => h.period);
      destroyChart('chart-kills-history');
      charts['chart-kills-history'] = new Chart(document.getElementById('chart-kills-history'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Kills',
              data: history.map(h => h.kills),
              backgroundColor: themeColorWithAlpha(theme.red, 0.53),
              borderColor: theme.red,
              borderWidth: 1,
              yAxisID: 'y',
            },
            {
              label: 'ISK destroyed',
              data: history.map(h => h.iskDestroyed),
              type: 'line',
              borderColor: theme.gold,
              backgroundColor: 'transparent',
              borderWidth: 2,
              tension: 0.2,
              fill: false,
              yAxisID: 'y1',
            },
          ],
        },
        options: {
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 12 } },
            tooltip: {
              callbacks: {
                label: ctx => {
                  if (ctx.dataset.yAxisID === 'y1') return ` ${ctx.dataset.label}: ${fmtISK(ctx.raw)} ISK`;
                  return ` ${ctx.dataset.label}: ${ctx.raw}`;
                },
              },
            },
          },
          scales: {
            y: {
              type: 'linear',
              position: 'left',
              title: { display: true, text: 'Kills' },
              grid: { color: 'rgba(30,48,79,.5)' },
              ticks: { color: '#7a95b5', stepSize: 1 },
            },
            y1: {
              type: 'linear',
              position: 'right',
              title: { display: true, text: 'ISK destroyed' },
              grid: { drawOnChartArea: false },
              ticks: { color: theme.gold, callback: v => fmtISK(v) },
            },
            x: { grid: { color: 'rgba(30,48,79,.5)' }, ticks: { color: '#7a95b5' } },
          },
        },
      });
    }

    // Recent kills table
    const tbody = document.getElementById('kills-tbody');
    if (!data.recentKills || data.recentKills.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No recent kills found.</td></tr>';
    } else {
      tbody.innerHTML = data.recentKills.map(k => `
        <tr>
          <td class="dim">${fmtDate(k.killTime)}</td>
          <td>${k.victimShip || '—'}</td>
          <td>${k.systemName || '—'}</td>
          <td class="text-right isk">${fmtISK(k.totalValue)} ISK</td>
          <td>
            <a href="https://zkillboard.com/kill/${k.killId}/" target="_blank"
               class="btn btn-ghost btn-small" rel="noopener">zKill ↗</a>
          </td>
        </tr>`).join('');
    }

  } catch (err) {
    document.getElementById('kills-top10').innerHTML =
      `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
  // Always reload losses for the same period
  loadLosses();
}

document.getElementById('kills-period')?.addEventListener('change', loadKills);

document.querySelectorAll('.kills-period-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const period = btn.dataset.period;
    const sel = document.getElementById('kills-period');
    if (!sel) return;
    if (period === 'rolling30') {
      sel.value = 'rolling30';
    } else if (period === 'this') {
      const yyyyMm = new Date().toISOString().slice(0, 7);
      if (![...sel.options].some(o => o.value === yyyyMm)) {
        const opt = document.createElement('option');
        opt.value = yyyyMm;
        opt.textContent = yyyyMm;
        sel.appendChild(opt);
      }
      sel.value = yyyyMm;
    } else if (period === 'last') {
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
    }
    loadKills();
  });
});

document.querySelectorAll('.btn-sync-kills').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.btn-sync-kills').forEach(b => { b.disabled = true; b.textContent = '⟳ Syncing…'; });
    try {
      await api.post('/api/kills/sync');
      setTimeout(() => {
        loadKills();
        loadLosses();
        document.querySelectorAll('.btn-sync-kills').forEach(b => { b.disabled = false; b.textContent = '⟳ Sync Kills'; });
      }, 5000);
    } catch (err) {
      toast('Kills sync error: ' + err.message, 'error');
      document.querySelectorAll('.btn-sync-kills').forEach(b => { b.disabled = false; b.textContent = '⟳ Sync Kills'; });
    }
  });
});

// ── Shared doughnut builder (kills + losses) ──────────────────────────────────
const SLICE_COLORS = [
  '#e55','#e9a','#4af','#5d5',
  '#c084fc','#f97316','#22d3ee','#a3e635','#fb7185','#fde68a',
];

async function buildPilotDoughnut({ canvasId, legendId, top10, valueKey, valueSuffix }) {
  const canvas = document.getElementById(canvasId);
  const legendEl = document.getElementById(legendId);
  if (!canvas) return;

  const theme  = getThemeColors();
  const colors = [theme.red, theme.gold, theme.blue, theme.green, ...SLICE_COLORS.slice(4)];

  // Preload ship icons
  const typeIds   = top10.map(k => k.favShipTypeId);
  const iconCache = {};
  await Promise.all(typeIds.map(tid => {
    if (!tid) return Promise.resolve();
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => { iconCache[tid] = img; resolve(); };
      img.onerror = () => resolve();
      img.src = `https://images.evetech.net/types/${tid}/icon?size=32`;
    });
  }));

  // Custom plugin: icon on large slices only — small slices covered by HTML legend
  const shipIconPlugin = {
    id: `shipIcons_${canvasId}`,
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      meta.data.forEach((arc, i) => {
        const tid = typeIds[i];
        const img = tid && iconCache[tid];
        if (!img) return;
        const span = arc.endAngle - arc.startAngle;
        if (span < 0.55) return; // only draw on slices wide enough to fit an icon
        const mid  = (arc.startAngle + arc.endAngle) / 2;
        const r    = (arc.innerRadius + arc.outerRadius) / 2;
        const x    = arc.x + Math.cos(mid) * r;
        const y    = arc.y + Math.sin(mid) * r;
        const size = Math.min(28, r * span * 0.45);
        if (size < 12) return;
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
        ctx.restore();
      });
    },
  };

  destroyChart(canvasId);
  charts[canvasId] = new Chart(canvas, {
    type: 'doughnut',
    plugins: [shipIconPlugin],
    data: {
      labels:   top10.map(k => k.mainName),
      datasets: [{
        data:            top10.map(k => k[valueKey]),
        backgroundColor: top10.map((_, i) => themeColorWithAlpha(colors[i % colors.length], 0.72)),
        borderColor:     top10.map((_, i) => colors[i % colors.length]),
        borderWidth:     2,
        hoverOffset:     8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 1,
      cutout: '42%',
      layout: { padding: 4 },
      plugins: {
        legend: { display: false }, // replaced by custom HTML legend below
        tooltip: {
          callbacks: {
            title: ctx => ctx[0].label,
            label: ctx => {
              const k = top10[ctx.dataIndex];
              const lines = [`  ${ctx.raw} ${valueSuffix}`, `  ${fmtISK(k.totalValue)} ISK`];
              if (k.favShipName) lines.push(`  Fav ship: ${k.favShipName}`);
              return lines;
            },
          },
        },
      },
    },
  });

  // Render custom HTML legend with ship icons + colour swatch + name + count
  if (legendEl) {
    legendEl.innerHTML = top10.map((k, i) => {
      const color = colors[i % colors.length];
      const tid   = k.favShipTypeId;
      const iconHtml = tid
        ? `<img src="https://images.evetech.net/types/${tid}/icon?size=32"
             style="width:20px;height:20px;object-fit:contain;flex-shrink:0"
             title="${esc(k.favShipName || 'Unknown ship')}">`
        : `<span style="width:20px;height:20px;display:inline-block;flex-shrink:0"></span>`;
      return `
        <div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border)">
          <span style="width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0"></span>
          ${iconHtml}
          <span style="font-size:0.78rem;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k.mainName)}</span>
          <span style="font-size:0.72rem;color:var(--text-dim);white-space:nowrap">${k[valueKey]}</span>
        </div>`;
    }).join('');
  }
}

// ── Corp Losses ───────────────────────────────────────────────────────────────
async function loadLosses() {
  try {
    const period = document.getElementById('kills-period')?.value || 'rolling30';
    const data   = await api.get(`/api/kills/losses?period=${period}`);

    // Top 10 losses
    const top10El = document.getElementById('losses-top10');
    if (!data.top10 || data.top10.length === 0) {
      top10El.innerHTML = '<p class="empty">No loss data for this period.</p>';
      destroyChart('chart-losses');
      document.getElementById('losses-pie-legend').innerHTML = '';
    } else {
      const maxL = data.top10[0]?.losses || 1;
      const medals = ['🥇', '🥈', '🥉'];
      top10El.innerHTML = data.top10.map((k, i) => `
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span>${medals[i] || (i + 1) + '.'} <strong>${esc(k.mainName)}</strong></span>
            <span style="color:var(--red)">${k.losses} losses &nbsp;·&nbsp; ${fmtISK(k.totalValue)} ISK</span>
          </div>
          <div class="bar-outer">
            <div class="bar-fill bar-red" style="width:${(k.losses / maxL * 100).toFixed(1)}%;opacity:0.55"></div>
          </div>
        </div>`).join('');

      buildPilotDoughnut({
        canvasId:    'chart-losses',
        legendId:    'losses-pie-legend',
        top10:       data.top10,
        valueKey:    'losses',
        valueSuffix: 'losses',
      });
    }

    const lossTotal = document.getElementById('losses-total');
    if (lossTotal) lossTotal.textContent = data.totalLosses || 0;

    // Recent losses table
    const tbody = document.getElementById('losses-tbody');
    if (!data.recentLosses || data.recentLosses.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No losses for this period.</td></tr>';
    } else {
      tbody.innerHTML = data.recentLosses.map(l => `
        <tr>
          <td>${fmtDate(l.killTime)}</td>
          <td>${esc(l.victimName || '—')}</td>
          <td>${esc(l.shipName || '—')}</td>
          <td>${esc(l.systemName || '—')}</td>
          <td class="text-right" style="color:var(--red)">${fmtISK(l.totalValue)}</td>
          <td><a href="https://zkillboard.com/kill/${l.killId}/" target="_blank"
               style="color:var(--text-dim);font-size:0.72rem">zKill ↗</a></td>
        </tr>`).join('');
    }

  } catch (err) {
    console.error('Losses load error:', err);
  }
}
