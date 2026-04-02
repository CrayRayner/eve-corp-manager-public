'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../auth');
const { db, getSetting, setSetting } = require('../db');
const { resolveStructureName } = require('../esi');
const { computeStructureFuel } = require('../structure-fuel-data');

const METENOX_TYPE_ID  = 81826;

// ESI uses CorpSAG1–CorpSAG7 for the 7 corp hangar divisions.
// In-game hangar names are set by the CEO but are NOT exposed via the ESI scope we hold.
// We scan ALL CorpSAG hangars so this works out-of-the-box for any corp regardless of
// which hangar they use for fuel/gas storage.

// GET /api/structures — return all synced structures with fuel/gas calculations
router.get('/', requireAuth, (req, res) => {
  const corpId = req.session.corporationId;
  const structures = db.prepare('SELECT * FROM structures WHERE corporation_id = ? ORDER BY name').all(corpId);
  const gasConsumptionPerMonth = parseInt(getSetting('gas_consumption_per_month', '144000'), 10) || 144000;
  const fuelMonthHours = Math.max(1, parseInt(getSetting('structure_fuel_month_hours', '720'), 10) || 720);

  const result = structures.map(s => {
    // Fuel block days remaining
    const fuelExpires   = s.fuel_expires ? new Date(s.fuel_expires) : null;
    const fuelDaysLeft  = fuelExpires
      ? Math.max(0, (fuelExpires - Date.now()) / 86400000)
      : null;

    // Magmatic gas (manual data)
    const isMetenox = s.type_id === METENOX_TYPE_ID;
    let gas = null;
    if (isMetenox) {
      const g = db.prepare('SELECT * FROM structure_gas WHERE structure_id = ?').get(s.structure_id);
      if (g && g.last_refill_date && g.quantity_refilled > 0) {
        const refillMs    = new Date(g.last_refill_date).getTime();
        const msElapsed   = Date.now() - refillMs;
        const daysElapsed = msElapsed / 86400000;
        const remaining   = g.quantity_refilled - (daysElapsed * g.daily_consumption);
        const gasDaysLeft = remaining > 0 ? remaining / g.daily_consumption : 0;
        const gasExpires  = new Date(refillMs + (g.quantity_refilled / g.daily_consumption) * 86400000);

        gas = {
          lastRefillDate:  g.last_refill_date,
          quantityRefilled: g.quantity_refilled,
          dailyConsumption: g.daily_consumption,
          estimatedRemaining: Math.max(0, Math.round(remaining)),
          daysLeft:        parseFloat(gasDaysLeft.toFixed(1)),
          estimatedExpires: gasExpires.toISOString(),
          notes:           g.notes,
        };
      } else {
        gas = { lastRefillDate: null, quantityRefilled: 0, dailyConsumption: g?.daily_consumption || 4800,
                estimatedRemaining: null, daysLeft: null, estimatedExpires: null, notes: g?.notes || null };
      }
    }

    const services = tryParse(s.services);
    const { fuelPerHour: computedFuelPerHour, fuelPerMonth: computedFuelPerMonth } = computeStructureFuel(services, s.type_id);
    const overrideKey = `structure_fuel_override_${s.structure_id}`;
    const overrideRaw = getSetting(overrideKey);
    const hasOverride = overrideRaw != null && String(overrideRaw).trim() !== '';
    // If automatic: use fuelMonthHours (default 720). Set to 360 in Settings if in-game shows half our value (EVE may use 15-day period).
    const fuelPerMonth = hasOverride ? Math.max(0, parseInt(overrideRaw, 10) || 0) : Math.round(computedFuelPerHour * fuelMonthHours);
    const fuelPerHour = hasOverride ? Math.round(fuelPerMonth / 720) : computedFuelPerHour;

    return {
      structureId:  s.structure_id,
      name:         s.name,
      typeId:       s.type_id,
      typeName:     s.type_name,
      systemName:   s.system_name,
      services,
      fuelExpires:  s.fuel_expires,
      fuelDaysLeft: fuelDaysLeft !== null ? parseFloat(fuelDaysLeft.toFixed(1)) : null,
      fuelPerHour,
      fuelPerMonth,
      fuelOverride: hasOverride,
      isMetenox,
      gas,
      syncedAt:     s.synced_at,
    };
  });

  res.json({ structures: result, gasConsumptionPerMonth });
});

// GET /api/structures/expiries — items expiring within 30 days, sorted soonest first
router.get('/expiries', requireAuth, (req, res) => {
  const THRESHOLD_DAYS = 30;
  const items = [];
  const corpId = req.session.corporationId;

  const structures = db.prepare('SELECT * FROM structures WHERE corporation_id = ? ORDER BY name').all(corpId);

  for (const s of structures) {
    // Fuel blocks
    if (s.fuel_expires) {
      const daysLeft = (new Date(s.fuel_expires) - Date.now()) / 86400000;
      if (daysLeft <= THRESHOLD_DAYS) {
        items.push({
          name:       s.name,
          systemName: s.system_name,
          type:       'fuel',
          daysLeft:   parseFloat(daysLeft.toFixed(1)),
          expiresAt:  s.fuel_expires,
        });
      }
    }

    // Magmatic gas (Metenox only, manual data)
    if (s.type_id === METENOX_TYPE_ID) {
      const g = db.prepare('SELECT * FROM structure_gas WHERE structure_id = ?').get(s.structure_id);
      if (g && g.last_refill_date && g.quantity_refilled > 0) {
        const refillMs  = new Date(g.last_refill_date).getTime();
        const elapsed   = Date.now() - refillMs;
        const remaining = g.quantity_refilled - (elapsed / 86400000) * g.daily_consumption;
        const daysLeft  = remaining > 0 ? remaining / g.daily_consumption : 0;
        const expires   = new Date(refillMs + (g.quantity_refilled / g.daily_consumption) * 86400000);
        if (daysLeft <= THRESHOLD_DAYS) {
          items.push({
            name:       s.name,
            systemName: s.system_name,
            type:       'gas',
            daysLeft:   parseFloat(daysLeft.toFixed(1)),
            expiresAt:  expires.toISOString(),
          });
        }
      }
    }
  }

  items.sort((a, b) => a.daysLeft - b.daysLeft);
  res.json(items);
});

// PUT /api/structures/:id/fuel-override — set or clear manual fuel/mo for a structure (null/empty = use automatic)
router.put('/:id/fuel-override', requireAuth, (req, res) => {
  const structureId = req.params.id;
  const key = `structure_fuel_override_${structureId}`;
  const { fuelPerMonth } = req.body;
  if (fuelPerMonth === null || fuelPerMonth === undefined || String(fuelPerMonth).trim() === '') {
    db.prepare('DELETE FROM notification_settings WHERE key = ?').run(key);
    return res.json({ ok: true, fuelPerMonth: null });
  }
  const value = Math.max(0, parseInt(fuelPerMonth, 10) || 0);
  setSetting(key, String(value));
  res.json({ ok: true, fuelPerMonth: value });
});

// PUT /api/structures/:id/gas — update manual gas data
router.put('/:id/gas', requireAuth, (req, res) => {
  const structureId = parseInt(req.params.id, 10);
  const { lastRefillDate, quantityRefilled, dailyConsumption, notes } = req.body;

  db.prepare(`
    INSERT INTO structure_gas (structure_id, last_refill_date, quantity_refilled, daily_consumption, notes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(structure_id) DO UPDATE SET
      last_refill_date  = excluded.last_refill_date,
      quantity_refilled = excluded.quantity_refilled,
      daily_consumption = excluded.daily_consumption,
      notes             = excluded.notes
  `).run(structureId, lastRefillDate, quantityRefilled || 0, dailyConsumption || 4800, notes || null);

  res.json({ ok: true });
});

// GET /api/structures/inventory — gas + fuel block stocks across all corp hangars
router.get('/inventory', requireAuth, async (req, res) => {
  const FUEL_IDS        = [4051, 4246, 4247, 4312]; // Caldari/Gallente/Amarr/Minmatar Fuel Blocks
  const GAS_TYPE_ID     = 81143; // Magmatic Gas
  const corpId          = req.session.corporationId;
  const metenoxCount    = db.prepare('SELECT COUNT(*) AS c FROM structures WHERE type_id = ? AND corporation_id = ?').get(METENOX_TYPE_ID, corpId).c;
  const structureRows   = db.prepare('SELECT structure_id, type_id, services FROM structures WHERE corporation_id = ?').all(corpId);
  const gasConsumptionPerMonth = parseInt(getSetting('gas_consumption_per_month', '144000'), 10) || 144000;
  const gasConsumPerHour = metenoxCount * (gasConsumptionPerMonth / 720);
  const totalFuelPerHour = structureRows.reduce((sum, row) => {
    const overrideKey = `structure_fuel_override_${row.structure_id}`;
    const overrideRaw = getSetting(overrideKey);
    const hasOverride = overrideRaw != null && String(overrideRaw).trim() !== '';
    if (hasOverride) {
      const fuelPerMonth = Math.max(0, parseInt(overrideRaw, 10) || 0);
      return sum + Math.round(fuelPerMonth / 720);
    }
    const services = tryParse(row.services);
    const { fuelPerHour } = computeStructureFuel(services, row.type_id);
    return sum + fuelPerHour;
  }, 0);
  const structureCount  = structureRows.length;

  // Build a JS-side lookup map for structure names.
  // We avoid a SQL JOIN here because location_id in the assets table was added via ALTER TABLE
  // (INTEGER affinity migration), which can cause type-mismatch silences in SQLite JOINs.
  // String-keyed JS map is reliable regardless of integer storage nuances.
  const structureMap = {};
  db.prepare('SELECT structure_id, name, system_name FROM structures WHERE corporation_id = ?').all(corpId)
    .forEach(s => {
      structureMap[String(s.structure_id)] = {
        name:        s.name        || `Loc ${s.structure_id}`,
        system_name: s.system_name || '',
      };
    });

  function locLabel(locationId) {
    const key = String(locationId);

    // 0. Manual name override (user-defined via the ✏️ button) — always wins
    const override = db.prepare('SELECT value FROM notification_settings WHERE key = ?')
      .get(`loc_name_${locationId}`);
    if (override?.value) return { structure_name: override.value, system_name: '' };

    // 1. Corp-owned structure (best: has system name too)
    if (structureMap[key]) {
      return {
        structure_name: structureMap[key].name,
        system_name:    structureMap[key].system_name,
      };
    }

    // 2. Alliance / other-corp structure — check name_cache (populated by resolveStructureName)
    const cached = db.prepare('SELECT name FROM name_cache WHERE id = ?').get(locationId);
    if (cached?.name) {
      return { structure_name: cached.name, system_name: '' };
    }

    // 2.5. This ID may be a rented office or container sitting inside an actual structure.
    // Walk up one level by looking it up as an item_id in assets.
    const parentAsset = db.prepare('SELECT location_id FROM assets WHERE item_id = ? AND corporation_id = ? LIMIT 1').get(locationId, corpId);
    if (parentAsset) {
      return locLabel(parentAsset.location_id);
    }

    // 3. Try the location_name stored in the assets table during the last sync
    const assetLoc = db.prepare(
      `SELECT MAX(location_name) AS ln FROM assets WHERE location_id = ? AND corporation_id = ?`
    ).get(locationId, corpId);
    if (assetLoc?.ln && !assetLoc.ln.startsWith('Loc ')) {
      return { structure_name: assetLoc.ln, system_name: '' };
    }

    // 4. Completely unknown — will resolve on next asset sync
    return { structure_name: `Loc ${locationId}`, system_name: '' };
  }

  // Configured corp fuel/gas hangar (default CorpSAG3; user-configurable in Settings)
  const fuelHangar = getSetting('fuel_hangar', 'CorpSAG3');

  // Gas in the configured corp hangar
  const gasRaw = db.prepare(`
    SELECT location_id, SUM(quantity) AS qty
    FROM assets
    WHERE type_id = ?
      AND location_flag = ?
      AND corporation_id = ?
    GROUP BY location_id
  `).all(GAS_TYPE_ID, fuelHangar, corpId);

  // Fuel blocks in the configured corp hangar
  const ph      = FUEL_IDS.map(() => '?').join(',');
  const fuelRaw = db.prepare(`
    SELECT type_id, type_name, location_id, SUM(quantity) AS qty
    FROM assets
    WHERE type_id IN (${ph})
      AND location_flag = ?
      AND corporation_id = ?
    GROUP BY type_id, location_id
  `).all(...FUEL_IDS, fuelHangar, corpId);

  // Resolve names for any alliance/other-corp structures not yet in name_cache.
  // resolveStructureName checks the DB cache first — only hits ESI for truly unknown IDs.
  // This runs at request time so the UI is up-to-date even if the scheduled sync hasn't run yet.
  const characterId = req.session.characterId;
  const allLocIds = [...new Set([
    ...gasRaw.map(r => r.location_id),
    ...fuelRaw.map(r => r.location_id),
  ])];
  for (const locId of allLocIds) {
    if (!structureMap[String(locId)]) {
      const cached = db.prepare('SELECT name FROM name_cache WHERE id = ?').get(locId);
      // Only attempt ESI resolution if never tried before — skip 'failed' entries (empty name)
      // to avoid burning error budget on every page load. Retries happen in the sync scheduler.
      if (!cached) {
        await resolveStructureName(locId, characterId).catch(() => {});
      }
    }
  }

  const gasRows = gasRaw
    .map(r => ({ location_id: r.location_id, qty: r.qty, ...locLabel(r.location_id) }))
    .sort((a, b) => a.system_name.localeCompare(b.system_name) || a.structure_name.localeCompare(b.structure_name));

  const totalGas         = gasRows.reduce((s, r) => s + r.qty, 0);
  const gasHoursLeft     = gasConsumPerHour > 0 && totalGas > 0 ? totalGas / gasConsumPerHour : null;

  const fuelRows = fuelRaw
    .map(r => ({
      type_id:   r.type_id,
      type_name: r.type_name || `Type ${r.type_id}`,
      qty:       r.qty,
      location_id: r.location_id,
      ...locLabel(r.location_id),
    }))
    .sort((a, b) => a.system_name.localeCompare(b.system_name) || a.structure_name.localeCompare(b.structure_name) || a.type_name.localeCompare(b.type_name));

  const totalFuel         = fuelRows.reduce((s, r) => s + r.qty, 0);
  const fuelConsumPerHour = totalFuelPerHour;
  const fuelHoursLeft     = fuelConsumPerHour > 0 && totalFuel > 0 ? totalFuel / fuelConsumPerHour : null;

  res.json({
    fuelHangar,
    gas: {
      rows:              gasRows,
      total:             totalGas,
      metenoxCount,
      consumptionPerMonth: gasConsumptionPerMonth,
      consumptionPerHour: gasConsumPerHour,
      hoursLeft:         gasHoursLeft ? Math.round(gasHoursLeft) : null,
      daysLeft:          gasHoursLeft ? parseFloat((gasHoursLeft / 24).toFixed(1)) : null,
    },
    fuel: {
      rows:              fuelRows,
      total:             totalFuel,
      structureCount,
      consumptionPerHour: fuelConsumPerHour,
      hoursLeft:         fuelHoursLeft ? Math.round(fuelHoursLeft) : null,
      daysLeft:          fuelHoursLeft ? parseFloat((fuelHoursLeft / 24).toFixed(1)) : null,
    },
  });
});

// PUT /api/structures/location-name — save (or clear) a manual name override for a location ID
router.put('/location-name', requireAuth, (req, res) => {
  const { locationId, name } = req.body;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });

  const key = `loc_name_${locationId}`;
  if (name && name.trim()) {
    db.prepare('INSERT OR REPLACE INTO notification_settings (key, value) VALUES (?, ?)')
      .run(key, name.trim());
  } else {
    // Empty/null name = clear the override (fall back to auto-resolved name)
    db.prepare('DELETE FROM notification_settings WHERE key = ?').run(key);
  }
  res.json({ ok: true });
});

// GET /api/structures/resupply?target=30
router.get('/resupply', requireAuth, (req, res) => {
  const corpId     = req.session.corporationId;
  const FUEL_IDS   = [4051, 4246, 4247, 4312];
  const GAS_TYPE   = 81143;
  const fuelHangar = getSetting('fuel_hangar', 'CorpSAG3');

  let target = parseInt(req.query.target || '30', 10);
  if (isNaN(target)) target = 30;
  target = Math.max(7, Math.min(180, target));

  const structureRows = db.prepare(
    'SELECT structure_id, name, type_id, services FROM structures WHERE corporation_id = ?'
  ).all(corpId);

  // Compute total fuel consumption per day across all structures
  let fuelConsumptionPerDay = 0;
  const structuresOut = structureRows.map(row => {
    const services = tryParse(row.services);
    const { fuelPerHour: computedFuelPerHour } = computeStructureFuel(services, row.type_id);
    const overrideRaw = getSetting(`structure_fuel_override_${row.structure_id}`);
    const hasOverride = overrideRaw != null && String(overrideRaw).trim() !== '';
    const fuelPerMonth = hasOverride ? Math.max(0, parseInt(overrideRaw, 10) || 0) : Math.round(computedFuelPerHour * 720);
    const fuelPerHour  = hasOverride ? Math.round(fuelPerMonth / 720) : computedFuelPerHour;
    const fuelPerDay   = fuelPerHour * 24;
    fuelConsumptionPerDay += fuelPerDay;
    return { structure_id: row.structure_id, name: row.name, type_id: row.type_id, fuelPerHour, fuelPerDay };
  });

  // Total fuel stock in corp hangar (all 4 fuel block types, configured hangar, excludes StructureFuel)
  const ph          = FUEL_IDS.map(() => '?').join(',');
  const fuelStockRow = db.prepare(`
    SELECT SUM(quantity) AS total FROM assets
    WHERE type_id IN (${ph}) AND location_flag = ? AND corporation_id = ?
  `).get(...FUEL_IDS, fuelHangar, corpId);
  const totalFuelStock = fuelStockRow?.total || 0;

  const daysOfFuelRemaining = fuelConsumptionPerDay > 0
    ? parseFloat((totalFuelStock / fuelConsumptionPerDay).toFixed(1))
    : null;
  const fuelNeeded = Math.max(0, Math.round(target * fuelConsumptionPerDay - totalFuelStock));

  // Cheapest fuel block price (min jita_buy_max among the 4 types)
  const fuelPriceRow = db.prepare(
    `SELECT MIN(jita_buy_max) AS price FROM market_prices WHERE type_id IN (${ph}) AND jita_buy_max IS NOT NULL`
  ).get(...FUEL_IDS);
  const fuelPriceEach = fuelPriceRow?.price || 0;
  const fuelTotalCost = fuelNeeded * fuelPriceEach;

  // Gas resupply (Metenox count drives consumption)
  const metenoxCount = structureRows.filter(r => r.type_id === METENOX_TYPE_ID).length;
  const gasConsumptionPerDay = metenoxCount * 200 * 24; // 200 gas/hr × 24hr

  const gasStockRow = db.prepare(
    'SELECT SUM(quantity) AS total FROM assets WHERE type_id = ? AND location_flag = ? AND corporation_id = ?'
  ).get(GAS_TYPE, fuelHangar, corpId);
  const totalGasStock = gasStockRow?.total || 0;

  const daysOfGasRemaining = gasConsumptionPerDay > 0
    ? parseFloat((totalGasStock / gasConsumptionPerDay).toFixed(1))
    : null;
  const gasNeeded = Math.max(0, Math.round(target * gasConsumptionPerDay - totalGasStock));

  const gasPriceRow = db.prepare(
    'SELECT jita_buy_max FROM market_prices WHERE type_id = ? AND jita_buy_max IS NOT NULL'
  ).get(GAS_TYPE);
  const gasPriceEach = gasPriceRow?.jita_buy_max || 0;
  const gasTotalCost = gasNeeded * gasPriceEach;

  res.json({
    target,
    totalFuelStock,
    fuelConsumptionPerDay,
    daysOfFuelRemaining,
    fuelNeeded,
    fuelPriceEach,
    fuelTotalCost,
    totalGasStock,
    gasConsumptionPerDay,
    daysOfGasRemaining,
    gasNeeded,
    gasPriceEach,
    gasTotalCost,
    grandTotalCost: fuelTotalCost + gasTotalCost,
    structures: structuresOut,
  });
});

function tryParse(s) { try { return JSON.parse(s); } catch { return []; } }

module.exports = router;
