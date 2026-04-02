'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../auth');
const { db }          = require('../db');

// GET /api/inventory — corp assets grouped by location
router.get('/', requireAuth, (req, res) => {
  const search   = (req.query.search || '').toLowerCase();
  const category = req.query.category || null;

  let where = '1=1';
  const args = [];

  if (search) {
    where += ' AND LOWER(type_name) LIKE ?';
    args.push(`%${search}%`);
  }
  if (category) {
    where += ' AND category = ?';
    args.push(category);
  }

  const items = db.prepare(`
    SELECT * FROM assets WHERE ${where} ORDER BY location_name, category, type_name
  `).all(...args);

  // Group by location
  const locations = {};
  let totalValue = 0;

  for (const item of items) {
    const loc = item.location_name || `Location ${item.location_id}`;
    if (!locations[loc]) {
      locations[loc] = { locationId: item.location_id, locationName: loc, categories: {}, totalValue: 0 };
    }
    const cat = item.category || 'Other';
    if (!locations[loc].categories[cat]) locations[loc].categories[cat] = [];

    locations[loc].categories[cat].push({
      itemId:    item.item_id,
      typeId:    item.type_id,
      typeName:  item.type_name,
      quantity:  item.quantity,
      groupName: item.group_name,
      estValue:  item.est_value,
    });

    locations[loc].totalValue += item.est_value || 0;
    totalValue += item.est_value || 0;
  }

  // Convert to array, sort by total value desc
  const result = Object.values(locations)
    .sort((a, b) => b.totalValue - a.totalValue)
    .map(loc => ({
      ...loc,
      categories: Object.entries(loc.categories)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, items]) => ({ name, items,
          categoryValue: items.reduce((s, i) => s + (i.estValue || 0), 0) })),
      totalValue: Math.round(loc.totalValue),
    }));

  // Available categories for filter
  const categories = db.prepare('SELECT DISTINCT category FROM assets WHERE category IS NOT NULL ORDER BY category').all()
    .map(r => r.category);

  const syncRow = db.prepare("SELECT last_sync FROM sync_status WHERE key = 'assets'").get();

  res.json({
    locations: result,
    totalItems: items.length,
    totalValue:  Math.round(totalValue),
    categories,
    syncedAt: syncRow?.last_sync || null,
  });
});

module.exports = router;
