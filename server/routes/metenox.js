'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../auth');
const { db }          = require('../db');

const METENOX_TYPE_ID   = 81826;

// Monthly cost components
// All 4 fuel block types — cost = average(p99 buy prices) × 3600
const FUEL_BLOCK_TYPE_IDS   = [4051, 4246, 4247, 4312]; // Caldari/Gallente/Amarr/Minmatar
const MAGMATIC_GAS_TYPE_ID  = 81143;  // Magmatic Gas
const FUEL_BLOCKS_PER_MONTH = 3600;   // 5 blocks/hr × 720 hr
const GAS_PER_MONTH         = 144000; // 200 units/hr × 720 hr
const FALLBACK_MONTHLY_COST = 285_772_000;

// Returns cost total + full breakdown for UI tooltip
function getCostDetails() {
  const fuelRows = FUEL_BLOCK_TYPE_IDS.map(id =>
    db.prepare('SELECT type_name, jita_buy_max FROM market_prices WHERE type_id = ?').get(id)
  );
  const foundFuel  = fuelRows.filter(r => r?.jita_buy_max > 0);
  const avgFuelP   = foundFuel.length
    ? foundFuel.reduce((s, r) => s + r.jita_buy_max, 0) / foundFuel.length
    : 0;

  const gasRow  = db.prepare('SELECT type_name, jita_buy_max FROM market_prices WHERE type_id = ?').get(MAGMATIC_GAS_TYPE_ID);
  const gasPrice = gasRow?.jita_buy_max || 0;

  const fuelCost = avgFuelP * FUEL_BLOCKS_PER_MONTH;
  const gasCost  = gasPrice * GAS_PER_MONTH;
  const usingFallback = !fuelCost && !gasCost;

  return {
    total: usingFallback ? FALLBACK_MONTHLY_COST : Math.round(fuelCost + gasCost),
    usingFallback,
    fuel: {
      avgUnitPrice:  Math.round(avgFuelP),
      pricesFound:   foundFuel.length,
      typeNames:     fuelRows.map((r, i) => r?.type_name || ['Caldari FB','Gallente FB','Amarr FB','Minmatar FB'][i]),
      qty:           FUEL_BLOCKS_PER_MONTH,
      subtotal:      Math.round(fuelCost),
    },
    gas: {
      typeId:    MAGMATIC_GAS_TYPE_ID,
      typeName:  gasRow?.type_name || `TypeID ${MAGMATIC_GAS_TYPE_ID}`,
      unitPrice: Math.round(gasPrice),
      qty:       GAS_PER_MONTH,
      subtotal:  Math.round(gasCost),
    },
  };
}

// Refined moon MATERIAL type IDs for the manual-entry dropdown.
// Sorted by R tier (4,8,16,32,64) then alphabetically by name. Labels include R for display.
const MOON_MATERIAL_TIERS = [
  { tier: 4,  label: 'R4 Moon Materials (Ubiquitous)',  materials: [
    { type_id: 16634, type_name: 'Atmospheric Gases' },
    { type_id: 16633, type_name: 'Evaporite Deposits' },
    { type_id: 16636, type_name: 'Hydrocarbons' },
    { type_id: 16635, type_name: 'Silicates' },
  ]},
  { tier: 8,  label: 'R8 Moon Materials (Common)',      materials: [
    { type_id: 16643, type_name: 'Cobalt' },
    { type_id: 16647, type_name: 'Scandium' },
    { type_id: 16638, type_name: 'Titanium' },
    { type_id: 16637, type_name: 'Tungsten' },
  ]},
  { tier: 16, label: 'R16 Moon Materials (Uncommon)',   materials: [
    { type_id: 16641, type_name: 'Cadmium' },
    { type_id: 16646, type_name: 'Chromium' },
    { type_id: 16644, type_name: 'Platinum' },
    { type_id: 16640, type_name: 'Vanadium' },
  ]},
  { tier: 32, label: 'R32 Moon Materials (Rare)',       materials: [
    { type_id: 16662, type_name: 'Caesium' },
    { type_id: 16663, type_name: 'Hafnium' },
    { type_id: 16660, type_name: 'Mercury' },
    { type_id: 16649, type_name: 'Technetium' },
  ]},
  { tier: 64, label: 'R64 Moon Materials (Exceptional)', materials: [
    { type_id: 16650, type_name: 'Dysprosium' },
    { type_id: 16651, type_name: 'Neodymium' },
    { type_id: 16652, type_name: 'Promethium' },
    { type_id: 16653, type_name: 'Thulium' },
  ]},
];

// Flat list with tier and groupLabel for dropdown (sorted R4→R64, alpha within tier)
function getMoonMaterialTypes() {
  const out = [];
  for (const group of MOON_MATERIAL_TIERS) {
    const sorted = [...group.materials].sort((a, b) => a.type_name.localeCompare(b.type_name));
    for (const m of sorted) {
      out.push({ ...m, tier: group.tier, groupLabel: group.label });
    }
  }
  return out;
}

// GET /api/metenox — profitability per Metenox structure
router.get('/', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  const structures = db.prepare(
    'SELECT * FROM structures WHERE type_id = ? AND corporation_id = ? ORDER BY name'
  ).all(METENOX_TYPE_ID, corpId);

  const costDetails = getCostDetails();   // compute once for all structures
  const monthlyCost = costDetails.total;

  const result = structures.map(s => {
    // Primary: ESI mining observer data
    let mined = db.prepare(`
      SELECT type_id, type_name, SUM(quantity) AS qty
      FROM mining_observers
      WHERE observer_id = ?
      GROUP BY type_id
    `).all(s.structure_id);

    // Fallback: manual material input
    const hasObserverData = mined.length > 0;
    if (!hasObserverData) {
      const manual = db.prepare(`
        SELECT type_id, type_name, qty_per_hour * 720 AS qty
        FROM metenox_manual_materials WHERE structure_id = ?
      `).all(s.structure_id);
      mined = manual;
    }

    let monthlyRevenue = 0;
    const materials = mined.map(m => {
      const price     = db.prepare('SELECT jita_buy_max, average_price FROM market_prices WHERE type_id = ?').get(m.type_id);
      const unitPrice = price?.jita_buy_max || price?.average_price || 0;
      const lineRevenue = m.qty * unitPrice;
      monthlyRevenue += lineRevenue;
      return { typeId: m.type_id, typeName: m.type_name, qty: m.qty, unitPrice, lineRevenue };
    });

    const fuelExpires  = s.fuel_expires ? new Date(s.fuel_expires) : null;
    const fuelDaysLeft = fuelExpires
      ? Math.max(0, (fuelExpires - Date.now()) / 86400000)
      : null;

    return {
      structureId:     s.structure_id,
      name:            s.name,
      systemName:      s.system_name,
      fuelDaysLeft:    fuelDaysLeft ? parseFloat(fuelDaysLeft.toFixed(1)) : null,
      materials,
      hasObserverData,
      monthlyRevenue:  Math.round(monthlyRevenue),
      monthlyCost:     monthlyCost,
      monthlyProfit:   Math.round(monthlyRevenue - monthlyCost),
      profitable:      monthlyRevenue > monthlyCost,
    };
  });

  const totals = {
    totalRevenue: result.reduce((a, b) => a + b.monthlyRevenue, 0),
    totalCost:    result.reduce((a, b) => a + b.monthlyCost,    0),
    totalProfit:  result.reduce((a, b) => a + b.monthlyProfit,  0),
  };

  const priceRow = db.prepare('SELECT MIN(updated_at) AS oldest FROM market_prices WHERE jita_buy_max IS NOT NULL').get();
  const pricesUpdatedAt = priceRow?.oldest
    ? new Date(priceRow.oldest * 1000).toISOString()
    : null;

  res.json({ structures: result, totals, pricesUpdatedAt, costDetails });
});

// GET /api/metenox/manual/:structureId — get manual materials
router.get('/manual/:structureId', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM metenox_manual_materials WHERE structure_id = ?')
    .all(parseInt(req.params.structureId, 10));
  res.json(rows);
});

// POST /api/metenox/manual/:structureId — set manual material
router.post('/manual/:structureId', requireAuth, (req, res) => {
  const structureId = parseInt(req.params.structureId, 10);
  const { typeId, typeName, qtyPerHour } = req.body;
  if (!typeId || qtyPerHour == null) return res.status(400).json({ error: 'typeId and qtyPerHour required' });
  db.prepare(`
    INSERT INTO metenox_manual_materials (structure_id, type_id, type_name, qty_per_hour)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(structure_id, type_id) DO UPDATE SET type_name = excluded.type_name, qty_per_hour = excluded.qty_per_hour
  `).run(structureId, typeId, typeName || `Type ${typeId}`, qtyPerHour);
  res.json({ ok: true });
});

// GET /api/metenox/materials/types — type list for the manual-entry dropdown
// Returns flat list sorted by R tier (4→64) then alphabetically; each item has tier and groupLabel for optgroup.
router.get('/materials/types', requireAuth, (req, res) => {
  res.json(getMoonMaterialTypes());
});

// DELETE /api/metenox/manual/:structureId/:typeId
router.delete('/manual/:structureId/:typeId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM metenox_manual_materials WHERE structure_id = ? AND type_id = ?')
    .run(parseInt(req.params.structureId, 10), parseInt(req.params.typeId, 10));
  res.json({ ok: true });
});

module.exports = router;
