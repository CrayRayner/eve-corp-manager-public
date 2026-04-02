// Chart.js global defaults & factory helpers
Chart.defaults.color        = '#7a95b5';
Chart.defaults.borderColor  = '#1e304f';
Chart.defaults.font.family  = "'Segoe UI', system-ui, sans-serif";

// Resolve current theme colors from CSS (respects color-blind mode on #app)
function getThemeColors() {
  const app = document.getElementById('app');
  if (!app) return { red: '#ff5555', green: '#00d4aa', orange: '#ff9933', gold: '#f0c040', blue: '#4a9eff' };
  const s = getComputedStyle(app);
  return {
    red:   (s.getPropertyValue('--red').trim())   || '#ff5555',
    green: (s.getPropertyValue('--green').trim()) || '#00d4aa',
    orange:(s.getPropertyValue('--orange').trim())|| '#ff9933',
    gold:  (s.getPropertyValue('--gold').trim())  || '#f0c040',
    blue:  (s.getPropertyValue('--blue').trim())  || '#4a9eff',
  };
}

// Hex or rgb/rgba with alpha for Chart.js
function themeColorWithAlpha(cssValue, alpha) {
  if (!cssValue) return `rgba(255,85,85,${alpha})`;
  if (cssValue.startsWith('#')) {
    const r = parseInt(cssValue.slice(1, 3), 16), g = parseInt(cssValue.slice(3, 5), 16), b = parseInt(cssValue.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const m = cssValue.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
  return cssValue;
}

const EVE_COLORS = [
  '#4a9eff','#00d4aa','#f0c040','#9b7fd4','#ff9933',
  '#ff5555','#5ba4f5','#2ecc71','#e74c3c','#e67e22',
];

const charts = {};

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function makeLineChart(id, labels, datasets) {
  destroyChart(id);
  charts[id] = new Chart(document.getElementById(id), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16 } } },
      scales: {
        x: { grid: { color: 'rgba(30,48,79,.5)' }, ticks: { color: '#7a95b5' } },
        y: { grid: { color: 'rgba(30,48,79,.5)' }, ticks: { color: '#7a95b5',
          callback: v => fmtISK(v) } },
      },
    },
  });
}

function makeBarChart(id, labels, datasets, opts = {}) {
  destroyChart(id);
  charts[id] = new Chart(document.getElementById(id), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      indexAxis: opts.horizontal ? 'y' : 'x',
      responsive: true,
      plugins: {
        legend: { display: datasets.length > 1,
          position: 'bottom', labels: { boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => ` ${fmtISK(ctx.raw)} ISK` } },
      },
      scales: {
        x: { stacked: opts.stacked, grid: { color: 'rgba(30,48,79,.5)' },
          ticks: { color: '#7a95b5', callback: v => opts.horizontal ? v : fmtISK(v) } },
        y: { stacked: opts.stacked, grid: { display: !opts.horizontal },
          ticks: { color: '#c5d5e8', callback: v => opts.horizontal ? v : fmtISK(v) } },
      },
    },
  });
}

/**
 * makeFlowChart — grouped bars (income/expenses) + net line on a single shared axis.
 * Bars sit above zero, net line dips below — one zero reference line for everything.
 */
function makeFlowChart(id, labels, income, expenses, net) {
  destroyChart(id);
  const c = getThemeColors();
  const fmtB = v => {
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    return (v / 1e3).toFixed(0) + 'K';
  };
  charts[id] = new Chart(document.getElementById(id), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Income',
          data: income,
          backgroundColor: themeColorWithAlpha(c.green, 0.55),
          borderColor: c.green,
          borderWidth: 1,
          maxBarThickness: 60,
          barPercentage: 1.0,
          categoryPercentage: 0.8,
          order: 2,
        },
        {
          label: 'Expenses',
          data: expenses,
          backgroundColor: themeColorWithAlpha(c.red, 0.55),
          borderColor: c.red,
          borderWidth: 1,
          maxBarThickness: 60,
          barPercentage: 1.0,
          categoryPercentage: 0.8,
          order: 2,
        },
        {
          type: 'line',
          label: 'Net',
          data: net,
          borderColor: c.blue,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          tension: 0.25,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmtISK(ctx.raw)} ISK` } },
      },
      scales: {
        x: { grid: { color: 'rgba(30,48,79,.5)' }, ticks: { color: '#7a95b5' } },
        y: {
          grid: {
            color: ctx => ctx.tick.value === 0
              ? 'rgba(190,210,240,0.55)'
              : 'rgba(30,48,79,.5)',
            lineWidth: ctx => ctx.tick.value === 0 ? 2 : 1,
          },
          ticks: { color: '#7a95b5', callback: v => fmtB(v) },
        },
      },
    },
  });
}

function makeDoughnutChart(id, labels, data, title = '') {
  destroyChart(id);
  const total = data.reduce((a, b) => a + b, 0);
  charts[id] = new Chart(document.getElementById(id), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data, backgroundColor: EVE_COLORS.slice(0, labels.length),
        borderWidth: 2, borderColor: '#0d1526', hoverOffset: 6,
      }],
    },
    options: {
      cutout: '58%',
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
        tooltip: { callbacks: {
          label: ctx => ` ${ctx.label}: ${fmtISK(ctx.raw)} ISK (${total > 0 ? (ctx.raw / total * 100).toFixed(1) : 0}%)`,
        } },
      },
    },
  });
}
