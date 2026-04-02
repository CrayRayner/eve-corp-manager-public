'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let _contractsPage   = 1;
let _contractsScope  = 'for_corp';
let _contractsStatus = 'outstanding';

// ── Helpers ───────────────────────────────────────────────────────────────────
function contractTypeLabel(t) {
  const map = { item_exchange: 'Item Exchange', courier: 'Courier', auction: 'Auction', loan: 'Loan', unknown: 'Unknown' };
  return map[t] || t || '—';
}

function contractStatusBadge(s) {
  const map = {
    outstanding: ['badge-warning', 'Outstanding'],
    in_progress: ['badge-info',    'In Progress'],
    finished:    ['badge-success', 'Finished'],
    cancelled:   ['badge-neutral', 'Cancelled'],
    deleted:     ['badge-neutral', 'Deleted'],
    failed:      ['badge-danger',  'Failed'],
    reversed:    ['badge-neutral', 'Reversed'],
    unknown:     ['badge-neutral', 'Unknown'],
  };
  const [cls, label] = map[s] || ['badge-neutral', s || '—'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function contractValueLabel(c) {
  if (c.price  > 0) return fmtISK(c.price)  + ' ISK';
  if (c.reward > 0) return fmtISK(c.reward) + ' ISK reward';
  return '—';
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadContracts(page, scope, status) {
  if (page   !== undefined) _contractsPage   = page;
  if (scope  !== undefined) _contractsScope  = scope;
  if (status !== undefined) _contractsStatus = status;

  const container  = document.getElementById('contracts-table-wrap');
  const pagination = document.getElementById('contracts-pagination');
  if (!container) return;
  container.innerHTML = '<p class="loading"><span class="spinner"></span></p>';

  try {
    const data = await api.get('/api/contracts', {
      scope:  _contractsScope,
      status: _contractsStatus,
      page:   _contractsPage,
    });

    updateContractTabBadge(data.newCount || 0);
    updateScopeBadges(data.scopeCounts || {});
    updateStatusBadges(data.statusCounts || {});

    if (!data.contracts.length) {
      container.innerHTML = '<p class="empty">No contracts found.</p>';
      if (pagination) pagination.innerHTML = '';
      return;
    }

    const fmt  = d => d ? fmtDate(d.slice(0, 10)) : '—';
    const fmtLoc = (name, id) => {
      if (name) {
        const parts = name.split(' - ');
        return esc(parts.length > 2 ? parts.slice(0, 2).join(' - ') + '…' : name);
      }
      if (id) return `<span style="color:var(--text-dim);font-size:11px">ID:${id}</span>`;
      return '—';
    };
    const rows = data.contracts.map(c => {
      const isNew = c.notified === 0;
      return `<tr>
        <td>${isNew ? '<span class="badge badge-warning" style="font-size:10px">NEW</span> ' : ''}${esc(contractTypeLabel(c.type))}</td>
        <td class="col-title">${esc(c.title || '—')}</td>
        <td>${esc(c.issuer_name || '—')}</td>
        <td>${contractStatusBadge(c.status)}</td>
        <td style="text-align:right;color:var(--gold)">${contractValueLabel(c)}</td>
        <td>${fmtLoc(c.location_name, c.start_location_id)}</td>
        <td>${fmt(c.date_issued)}</td>
        <td>${fmt(c.date_expired)}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th>Type</th><th>Title</th><th>From</th><th>Status</th>
          <th style="text-align:right">Value</th><th>Location</th><th>Issued</th><th>Expires</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    // Pagination
    if (pagination) {
      const totalPages = Math.ceil(data.total / 50);
      if (totalPages <= 1) {
        pagination.innerHTML = `<span class="table-count">${data.total} contract${data.total !== 1 ? 's' : ''}</span>`;
      } else {
        const prev = _contractsPage > 1          ? `<button class="btn btn-ghost btn-small" id="contracts-prev">← Prev</button>` : '';
        const next = _contractsPage < totalPages  ? `<button class="btn btn-ghost btn-small" id="contracts-next">Next →</button>` : '';
        pagination.innerHTML = `${prev}<span class="table-count">Page ${_contractsPage} / ${totalPages} &nbsp;(${data.total} total)</span>${next}`;
        document.getElementById('contracts-prev')?.addEventListener('click', () => loadContracts(_contractsPage - 1));
        document.getElementById('contracts-next')?.addEventListener('click', () => loadContracts(_contractsPage + 1));
      }
    }

    // Mark seen when user is viewing for_corp contracts
    if (_contractsScope === 'for_corp' && (data.newCount || 0) > 0) {
      api.post('/api/contracts/mark-seen').catch(() => {});
      updateContractTabBadge(0);
    }

  } catch (err) {
    container.innerHTML = `<p class="empty error">Failed to load contracts: ${esc(err.message)}</p>`;
  }
}

function updateContractTabBadge(count) {
  const badge = document.getElementById('contracts-new-badge');
  if (!badge) return;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-block' : 'none';
}

function updateScopeBadges(counts) {
  document.querySelectorAll('#tab-contracts .scope-btn[data-scope]').forEach(btn => {
    const n = counts[btn.dataset.scope] || 0;
    const el = btn.querySelector('.filter-count');
    if (el) el.textContent = n > 0 ? ` (${n})` : '';
  });
}

function updateStatusBadges(counts) {
  document.querySelectorAll('#tab-contracts .status-btn[data-status]').forEach(btn => {
    const s = btn.dataset.status;
    const n = s === 'all' ? (counts.all || 0) : (counts[s] || 0);
    const el = btn.querySelector('.filter-count');
    if (el) el.textContent = n > 0 ? ` (${n})` : '';
  });
}

// ── Wire up filter buttons ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Scope buttons
  document.querySelectorAll('#tab-contracts .scope-btn[data-scope]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-contracts .scope-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadContracts(1, btn.dataset.scope, _contractsStatus);
    });
  });

  // Status buttons
  document.querySelectorAll('#tab-contracts .status-btn[data-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-contracts .status-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadContracts(1, _contractsScope, btn.dataset.status);
    });
  });
});
