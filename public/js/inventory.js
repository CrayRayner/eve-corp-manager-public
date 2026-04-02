async function loadInventory(search = '', category = '') {
  const locEl = document.getElementById('inv-locations');
  locEl.innerHTML = '<div class="loading"><span class="spinner"></span> Loading inventory…</div>';

  try {
    const data = await api.get('/api/inventory', { search, category });

    document.getElementById('inv-summary').textContent =
      `${data.totalItems.toLocaleString()} items · est. ${fmtISK(data.totalValue)} ISK`;

    // Populate category dropdown
    const catSel = document.getElementById('inv-category');
    if (catSel.options.length === 1) {
      data.categories.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = c;
        catSel.appendChild(opt);
      });
    }

    if (!data.locations.length) {
      locEl.innerHTML = '<p class="empty">No assets found. Trigger a sync to load corp inventory.</p>';
      return;
    }

    locEl.innerHTML = data.locations.map((loc, li) => `
      <div style="margin-bottom:8px">
        <div class="collapsible-header ${li === 0 ? 'open' : ''}" onclick="toggleCollapsible(this)">
          <span class="collapsible-arrow">▶</span>
          <strong>${loc.locationName}</strong>
          <span class="badge badge-blue" style="margin-left:6px">${loc.categories.reduce((s,c) => s + c.items.length, 0)} items</span>
          <span class="isk" style="margin-left:auto">${fmtISK(loc.totalValue)} ISK</span>
        </div>
        <div class="collapsible-body ${li === 0 ? 'open' : ''}" style="padding-left:16px;margin-top:4px">
          ${loc.categories.map(cat => `
            <div style="margin-bottom:6px">
              <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-dim);padding:6px 0 4px">
                ${cat.name}
                <span class="isk" style="margin-left:8px">${fmtISK(cat.categoryValue)} ISK</span>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr>
                    <th>Item</th>
                    <th class="text-right">Quantity</th>
                    <th class="text-right">Est. Value</th>
                  </tr></thead>
                  <tbody>
                    ${cat.items.map(item => `
                      <tr>
                        <td>${item.typeName}</td>
                        <td class="text-right num">${item.quantity.toLocaleString()}</td>
                        <td class="text-right isk">${item.estValue > 0 ? fmtISK(item.estValue) + ' ISK' : '—'}</td>
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>`).join('')}
        </div>
      </div>`).join('');

  } catch (err) {
    locEl.innerHTML = `<div class="alert alert-error">Error loading inventory: ${err.message}</div>`;
  }
}

function toggleCollapsible(header) {
  header.classList.toggle('open');
  header.nextElementSibling.classList.toggle('open');
}

document.getElementById('inv-search-btn')?.addEventListener('click', () => {
  loadInventory(
    document.getElementById('inv-search').value,
    document.getElementById('inv-category').value,
  );
});
document.getElementById('inv-search')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('inv-search-btn')?.click();
});
