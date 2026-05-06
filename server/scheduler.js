'use strict';
const cron   = require('node-cron');
const { esiGet, esiGetAll, resolveNames, resolveStructureName, resolveSystemName, resolveTypeName } = require('./esi');
const { db, setSyncStatus, getToken, getCachedName, cacheName, setSetting } = require('./db');

const METENOX_TYPE_ID   = 81826;
const JITA_REGION_ID    = 10000002;
const MONTHLY_FUEL_COST = 285_772_000;

// ── Main sync orchestrator ────────────────────────────────────────────────────
async function runFullSync(characterId) {
  if (!characterId) return;
  const token = getToken(characterId);
  if (!token) return;
  const corpId = token.corporation_id;
  if (!corpId) return;

  console.log(`[Sync] Starting full sync for corp ${corpId}`);
  await Promise.allSettled([
    syncStructures(characterId, corpId),
    syncWallet(characterId, corpId),
    syncAssets(characterId, corpId),
    syncMarketPrices(),
    syncMemberTracking(characterId, corpId),
    syncMiningObservers(characterId, corpId),
    syncContracts(characterId, corpId),
    // Always sync Jita buy prices: fuel blocks + magmatic gas + all R4–R64 moon MATERIALS
    syncJitaBuyPrices([
      4051, 4246, 4247, 4312,     // Caldari / Gallente / Amarr / Minmatar Fuel Blocks
      81143,                       // Magmatic Gas
      // R4 moon materials
      16634, 16633, 16636, 16635, // Atmospheric Gases, Evaporite Deposits, Hydrocarbons, Silicates
      // R8 moon materials
      16643, 16647, 16638, 16637, // Cobalt, Scandium, Titanium, Tungsten
      // R16 moon materials
      16641, 16646, 16644, 16640, // Cadmium, Chromium, Platinum, Vanadium
      // R32 moon materials
      16662, 16663, 16660, 16649, // Caesium, Hafnium, Mercury, Technetium
      // R64 moon materials
      16650, 16651, 16652, 16653, // Dysprosium, Neodymium, Promethium, Thulium
    ]),
  ]);
  // Kills + losses use external API — run after main sync
  await syncKills(corpId).catch(e => console.error('[Sync] Kills error:', e.message));
  await syncLosses(corpId).catch(e => console.error('[Sync] Losses error:', e.message));

  // Check fuel/gas thresholds after every sync (notification_log deduplicates within 24h)
  const { checkAndNotify } = require('./notifications');
  await checkAndNotify().catch(e => console.error('[Notifications] checkAndNotify error:', e.message));

  // Push to cloud sync if enabled (fire-and-forget, non-fatal)
  require('./cloud-sync').backgroundUpload();

  console.log('[Sync] Full sync complete');
}

// ── Structures ────────────────────────────────────────────────────────────────
async function syncStructures(characterId, corpId) {
  try {
    const data = await esiGetAll(`/corporations/${corpId}/structures/`, { characterId });

    for (const s of data) {
      const systemName = await resolveSystemName(s.system_id);
      const typeName   = await resolveTypeName(s.type_id);
      const name = s.name || await resolveStructureName(s.structure_id, characterId);

      db.prepare(`
        INSERT INTO structures (structure_id, name, type_id, type_name, system_id, system_name, fuel_expires, services, state, corporation_id, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(structure_id) DO UPDATE SET
          name = excluded.name, type_id = excluded.type_id, type_name = excluded.type_name,
          system_id = excluded.system_id, system_name = excluded.system_name,
          fuel_expires = excluded.fuel_expires, services = excluded.services,
          state = excluded.state, corporation_id = excluded.corporation_id, synced_at = excluded.synced_at
      `).run(s.structure_id, name, s.type_id, typeName, s.system_id, systemName,
             s.fuel_expires || null, JSON.stringify(s.services || []),
             s.state || null, corpId, Math.floor(Date.now() / 1000));

      // Ensure gas row exists for Metenox
      if (s.type_id === METENOX_TYPE_ID) {
        db.prepare(`
          INSERT OR IGNORE INTO structure_gas (structure_id, daily_consumption)
          VALUES (?, 4800)
        `).run(s.structure_id);
      }
    }
    setSyncStatus('structures');
    console.log(`[Sync] Structures: ${data.length} synced`);
  } catch (err) {
    setSyncStatus('structures', err.message);
    console.error('[Sync] Structures error:', err.message);
  }
}

// ── Wallet Journal ────────────────────────────────────────────────────────────
async function syncWallet(characterId, corpId) {
  try {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO wallet_journal
        (journal_id, division, date, ref_type, first_party_id, second_party_id, amount, balance, description, corporation_id, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = db.transaction(entries => {
      for (const e of entries) insert.run(e);
    });

    let totalInserted = 0;
    for (let div = 1; div <= 7; div++) {
      try {
        const entries = await esiGetAll(`/corporations/${corpId}/wallets/${div}/journal/`, { characterId });
        const rows = entries.map(e => [
          e.id, div, e.date, e.ref_type, e.first_party_id ?? null,
          e.second_party_id ?? null, e.amount, e.balance ?? null,
          e.description ?? null, corpId, Math.floor(Date.now() / 1000),
        ]);
        insertMany(rows);
        totalInserted += rows.length;
        if (entries.length > 0) console.log(`[Sync] Wallet div ${div}: ${entries.length} entries from ESI`);
      } catch (divErr) {
        console.error(`[Sync] Wallet div ${div} error: ${divErr.message}`);
      }
    }

    // Sync current wallet balances from the dedicated endpoint.
    // /corporations/{id}/wallets/ returns the ACTUAL live balance per division — far more
    // reliable than reading the running balance column from the journal (which can be null
    // or stale for divisions with infrequent activity).
    const walletBalances = await esiGet(`/corporations/${corpId}/wallets/`, { characterId }).catch(() => []);
    for (const b of walletBalances) {
      setSetting(`wallet_balance_${corpId}_${b.division}`, String(b.balance));
    }
    // Record monthly division balance history for trend chart
    if (walletBalances.length) {
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
      for (const b of walletBalances) {
        db.prepare('INSERT OR REPLACE INTO wallet_division_history (corporation_id, month, division, balance) VALUES (?,?,?,?)')
          .run(corpId, currentMonth, b.division, b.balance);
      }
    }
    if (walletBalances.length) {
      console.log(`[Sync] Wallet balances: ${walletBalances.map(b => `Div${b.division}=${(b.balance/1e9).toFixed(2)}B`).join(' | ')}`);
    }

    // Resolve names for external corp/character IDs in corp_account_withdrawal entries.
    // /universe/names/ handles corps, characters, alliances — no extra scope needed.
    // This caches names so P&L shows "Transfer Out To Invidia Administrative" not "Corp 12345".
    const externalIds = db.prepare(`
      SELECT DISTINCT second_party_id FROM wallet_journal
      WHERE ref_type = 'corporation_account_withdrawal'
        AND second_party_id IS NOT NULL
        AND second_party_id != ?
    `).all(corpId).map(r => r.second_party_id);
    const uncached = externalIds.filter(id => !getCachedName(id));
    if (uncached.length) {
      await resolveNames(uncached).catch(() => {});
      console.log(`[Sync] Wallet: resolved ${uncached.length} external corp/char name(s)`);
    }

    // Rebuild tax summary for current period
    await rebuildTaxSummary(characterId, corpId);
    setSyncStatus('wallet');
    console.log(`[Sync] Wallet: ${totalInserted} entries`);
  } catch (err) {
    setSyncStatus('wallet', err.message);
    console.error('[Sync] Wallet error:', err.message);
  }
}

async function rebuildTaxSummary(characterId, corpId) {
  const TAX_TYPES = [
    'bounty_prizes',        // NPC bounty tax + ESS regular payouts
    'ess_escrow_transfer',  // ESS reserve bank payouts
    'agent_mission_reward', // mission runner tax
    'industry_job_tax',     // manufacturing / research job tax
    'daily_goal_payouts',   // AIR Daily Goals (500k ISK reward × corp tax rate)
  ];
  const period = new Date().toISOString().slice(0, 7);

  const rows = db.prepare(`
    SELECT second_party_id, SUM(amount) AS total
    FROM wallet_journal
    WHERE date LIKE ? || '%'
      AND division = 1
      AND second_party_id IS NOT NULL
      AND ref_type IN (${TAX_TYPES.map(() => '?').join(',')})
      AND amount > 0
      AND corporation_id = ?
    GROUP BY second_party_id
  `).all(period, ...TAX_TYPES, corpId);

  const ids = rows.map(r => r.second_party_id).filter(Boolean);
  const nameMap = ids.length ? await resolveNames(ids) : {};

  const upsert = db.prepare(`
    INSERT INTO tax_summary (period, character_id, character_name, main_name, total_amount, corporation_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(period, character_id) DO UPDATE SET
      character_name = excluded.character_name,
      main_name      = excluded.main_name,
      total_amount   = excluded.total_amount,
      corporation_id = excluded.corporation_id
  `);
  const doUpsert = db.transaction(list => { for (const x of list) upsert.run(...x); });

  const list = rows.map(r => {
    const name    = nameMap[r.second_party_id] || `ID:${r.second_party_id}`;
    const mapping = db.prepare('SELECT main_name FROM alt_mappings WHERE character_id = ? AND corporation_id = ?').get(r.second_party_id, corpId);
    return [period, r.second_party_id, name, mapping?.main_name || name, r.total, corpId];
  });
  doUpsert(list);
}

// ── Assets ────────────────────────────────────────────────────────────────────
async function syncAssets(characterId, corpId) {
  try {
    const data = await esiGetAll(`/corporations/${corpId}/assets/`, { characterId });

    // ── Resolve location names ─────────────────────────────────────────────
    // ESI assets carry a location_type field:
    //   'station'  → NPC station  → batch-resolve via /universe/names/ (1 call for all)
    //   'other'    → player structure → look up in our structures table (no ESI call!)
    //   'item'     → inside a container/ship → location_id is a game item ID, unresolvable
    //   'solar_system' → floating in space
    // This avoids the old bug where we called resolveStructureName for every asset location
    // (including hundreds of container IDs), burning through ESI's 100-errors/60s limit.
    const locNames = {};

    // Player structure names already synced — use DB, zero ESI calls
    const knownStructures = {};
    db.prepare('SELECT structure_id, name FROM structures').all()
      .forEach(s => { knownStructures[s.structure_id] = s.name; });

    // Categorise location IDs by type
    const stationLocIds       = new Set();
    const unknownStructureIds = new Set(); // alliance / other-corp structures (dockable)

    for (const a of data) {
      if (a.location_type === 'station' || a.location_type === 'solar_system') {
        stationLocIds.add(a.location_id);
      } else if (a.location_type === 'other') {
        if (knownStructures[a.location_id]) {
          locNames[a.location_id] = knownStructures[a.location_id];
        } else {
          unknownStructureIds.add(a.location_id);
        }
      }
      // 'item' → office/container item_id, not a structure — locLabel() walks the parent
      //          chain at display time instead; no ESI call needed or appropriate here.
    }

    // Batch-resolve NPC station names (one POST for all, no auth needed)
    if (stationLocIds.size > 0) {
      const names = await resolveNames([...stationLocIds]).catch(() => ({}));
      Object.assign(locNames, names);
    }

    // Resolve alliance / other-corp structure names one at a time.
    // resolveStructureName checks name_cache first (no ESI hit if already cached),
    // then tries /universe/structures/{id}/ with auth (works if char has docking access).
    // Returns 'Structure XXXX' silently on 401 — no error budget waste after esi.js fix.
    if (unknownStructureIds.size > 0) {
      console.log(`[Sync] Assets: resolving ${unknownStructureIds.size} external structure name(s)…`);
      for (const id of unknownStructureIds) {
        locNames[id] = await resolveStructureName(id, characterId);
      }
    }

    // ── Resolve type names ─────────────────────────────────────────────────
    // One batch POST to /universe/names/ covers all item type IDs at once
    const typeIds   = [...new Set(data.map(a => a.type_id))];
    const typeNames = {};
    const typeNameResolved = await resolveNames(typeIds).catch(() => ({}));
    Object.assign(typeNames, typeNameResolved);

    const insert = db.prepare(`
      INSERT OR REPLACE INTO assets
        (item_id, type_id, type_name, quantity, location_id, location_name, location_type,
         location_flag, category, group_name, est_value, corporation_id, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAll = db.transaction(items => { for (const i of items) insert.run(...i); });

    const now = Math.floor(Date.now() / 1000);
    const rows = data.map(a => {
      const price = db.prepare('SELECT jita_sell_min FROM market_prices WHERE type_id = ?').get(a.type_id);
      const estValue = (price?.jita_sell_min || 0) * a.quantity;
      return [a.item_id, a.type_id, typeNames[a.type_id] || `Type ${a.type_id}`,
              a.quantity, a.location_id, locNames[a.location_id] || `Loc ${a.location_id}`,
              a.location_type || null, a.location_flag || null, null, null, estValue, corpId, now];
    });
    insertAll(rows);

    setSyncStatus('assets');
    console.log(`[Sync] Assets: ${data.length} items`);
  } catch (err) {
    setSyncStatus('assets', err.message);
    console.error('[Sync] Assets error:', err.message);
  }
}

// ── Market Prices ─────────────────────────────────────────────────────────────
async function syncMarketPrices() {
  try {
    const prices = await esiGet('/markets/prices/');
    const now    = Math.floor(Date.now() / 1000);
    const insert = db.prepare(`
      INSERT INTO market_prices (type_id, adjusted_price, average_price, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(type_id) DO UPDATE SET
        adjusted_price = excluded.adjusted_price,
        average_price  = excluded.average_price,
        updated_at     = excluded.updated_at
    `);
    const insertAll = db.transaction(list => { for (const p of list) insert.run(...p); });
    insertAll(prices.map(p => [p.type_id, p.adjusted_price || null, p.average_price || null, now]));
    setSyncStatus('market_prices');
    console.log(`[Sync] Market prices: ${prices.length} types`);
  } catch (err) {
    setSyncStatus('market_prices', err.message);
    console.error('[Sync] Market prices error:', err.message);
  }
}

// ── Member Tracking ───────────────────────────────────────────────────────────
async function syncMemberTracking(characterId, corpId) {
  try {
    const data = await esiGet(`/corporations/${corpId}/membertracking/`, { characterId });
    const charIds = data.map(m => m.character_id).filter(Boolean);
    const nameMap = charIds.length ? await resolveNames(charIds) : {};

    const upsert = db.prepare(`
      INSERT INTO member_tracking
        (character_id, character_name, logon_date, logoff_date, ship_type_id, location_id, corporation_id, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        character_name = excluded.character_name,
        logon_date     = excluded.logon_date,
        logoff_date    = excluded.logoff_date,
        ship_type_id   = excluded.ship_type_id,
        location_id    = excluded.location_id,
        corporation_id = excluded.corporation_id,
        synced_at      = excluded.synced_at
    `);
    const doUpsert = db.transaction(list => { for (const r of list) upsert.run(...r); });
    const now = Math.floor(Date.now() / 1000);
    doUpsert(data.map(m => [
      m.character_id,
      nameMap[m.character_id] || `ID:${m.character_id}`,
      m.logon_date  || null,
      m.logoff_date || null,
      m.ship_type_id || null,
      m.base_id      || null,
      corpId,
      now,
    ]));

    // Remove members who are no longer in the corp (ESI returned the full current list)
    const currentIds = data.map(m => m.character_id).filter(Boolean);
    if (currentIds.length > 0) {
      const placeholders = currentIds.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM member_tracking WHERE corporation_id = ? AND character_id NOT IN (${placeholders})`
      ).run(corpId, ...currentIds);
    }

    setSyncStatus('members');
    console.log(`[Sync] Member tracking: ${data.length} members`);
  } catch (err) {
    setSyncStatus('members', err.message);
    console.error('[Sync] Member tracking error:', err.message);
  }
}

// ── Mining Observers (Athanor, Tatara, Metenox, etc. — all Upwell refineries with observers) ─
// CCP: "Refineries with no mining events will not be shown on this list." List is cached 1h.
// So empty list can mean: no mining recorded yet, or cache from before first mining, or backend delay.
async function syncMiningObservers(characterId, corpId) {
  try {
    const observers = await esiGetAll(`/corporations/${corpId}/mining/observers/`, { characterId });
    console.log(`[Sync] Mining observers list: ${observers.length} structure(s)`, observers.map(o => `${o.observer_id} (${o.observer_type})`));
    const upsert = db.prepare(`
      INSERT INTO mining_observers
        (observer_id, character_id, type_id, type_name, quantity, last_updated, corporation_id, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observer_id, character_id, type_id, last_updated) DO UPDATE SET
        quantity       = excluded.quantity,
        corporation_id = excluded.corporation_id,
        synced_at      = excluded.synced_at
    `);
    const doUpsert = db.transaction(list => { for (const r of list) upsert.run(...r); });
    const now = Math.floor(Date.now() / 1000);
    const allTypeIds = new Set();

    for (const obs of observers) {
      const entries = await esiGetAll(
        `/corporations/${corpId}/mining/observers/${obs.observer_id}/`,
        { characterId }
      );
      const rows = entries.map(e => {
        allTypeIds.add(e.type_id);
        const typeName = getCachedName(e.type_id)?.name || `Type ${e.type_id}`;
        return [obs.observer_id, e.character_id, e.type_id, typeName, e.quantity, e.last_updated, corpId, now];
      });
      doUpsert(rows);
    }

    // Sync Jita buy prices for all mined material type IDs
    await syncJitaBuyPrices([...allTypeIds]);

    setSyncStatus('observers');
    console.log(`[Sync] Mining observers: ${observers.length} structure(s) synced (Athanor/Tatara/Metenox etc.)`);
  } catch (err) {
    setSyncStatus('observers', err.message);
    console.error('[Sync] Mining observers error:', err.message);
  }
}

// ── Jita Buy Prices (for specific type IDs) ───────────────────────────────────
async function syncJitaBuyPrices(typeIds) {
  const now = Math.floor(Date.now() / 1000);
  for (const typeId of typeIds) {
    try {
      const orders = await esiGet(`/markets/${JITA_REGION_ID}/orders/`, {
        params: { type_id: typeId, order_type: 'buy' },
      });
      if (!orders || !orders.length) continue;
      // 99th percentile buy price (more stable than pure max which can be outliers)
      const prices  = orders.map(o => o.price).sort((a, b) => a - b);
      const p99idx  = Math.max(0, Math.ceil(prices.length * 0.99) - 1);
      const p99Buy  = prices[p99idx];
      const typeName = await resolveTypeName(typeId);
      db.prepare(`
        INSERT INTO market_prices (type_id, type_name, jita_buy_max, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(type_id) DO UPDATE SET
          type_name    = excluded.type_name,
          jita_buy_max = excluded.jita_buy_max,
          updated_at   = excluded.updated_at
      `).run(typeId, typeName, p99Buy, now);
    } catch (err) {
      console.error(`[Sync] Jita price for typeId ${typeId}: ${err.message}`);
    }
  }
  console.log(`[Sync] Jita buy prices: ${typeIds.length} types`);
}

// ── Corp Contracts ────────────────────────────────────────────────────────────
async function syncContracts(characterId, corpId) {
  try {
    const data = await esiGetAll(`/corporations/${corpId}/contracts/`, { characterId });

    // Resolve issuer names in bulk
    const issuerIds = [...new Set(data.map(c => c.issuer_id).filter(Boolean))];
    const issuerNames = issuerIds.length ? await resolveNames(issuerIds) : {};

    const now = Math.floor(Date.now() / 1000);
    const newForCorp = [];

    const upsert = db.prepare(`
      INSERT INTO corp_contracts
        (contract_id, issuer_id, issuer_name, issuer_corp_id, assignee_id,
         type, status, title, for_corporation, availability,
         date_issued, date_expired, date_accepted, date_completed,
         price, reward, collateral, volume, start_location_id, end_location_id,
         notified, corporation_id, synced_at)
      VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?)
      ON CONFLICT(contract_id) DO UPDATE SET
        status         = excluded.status,
        date_accepted  = excluded.date_accepted,
        date_completed = excluded.date_completed,
        corporation_id = excluded.corporation_id,
        synced_at      = excluded.synced_at
    `);
    const doUpsert = db.transaction(list => { for (const r of list) upsert.run(...r); });

    const rows = [];
    for (const c of data) {
      const existing  = db.prepare('SELECT notified FROM corp_contracts WHERE contract_id = ?').get(c.contract_id);
      const isNew     = !existing;
      const isForCorp = isNew && c.assignee_id === corpId && c.status === 'outstanding';

      if (isForCorp) {
        newForCorp.push({
          contractId: c.contract_id,
          type:       c.type || 'unknown',
          title:      c.title || '(no title)',
          issuerName: issuerNames[c.issuer_id] || `ID:${c.issuer_id}`,
          price:      c.price  || 0,
          reward:     c.reward || 0,
          dateExpired: c.date_expired || null,
        });
      }

      rows.push([
        c.contract_id,
        c.issuer_id          || null,
        issuerNames[c.issuer_id] || null,
        c.issuer_corporation_id || null,
        c.assignee_id        || null,
        c.type               || null,
        c.status             || null,
        c.title              || null,
        c.for_corporation    ? 1 : 0,
        c.availability       || null,
        c.date_issued        || null,
        c.date_expired       || null,
        c.date_accepted      || null,
        c.date_completed     || null,
        c.price      || 0,
        c.reward     || 0,
        c.collateral || 0,
        c.volume     || 0,
        c.start_location_id || null,
        c.end_location_id   || null,
        isForCorp ? 0 : 1, // notified=0 means "new, unseen"
        corpId,
        now,
      ]);
    }
    doUpsert(rows);

    // Resolve location names for all unique start_location_ids not yet cached
    const locationIds = [...new Set(data.map(c => c.start_location_id).filter(Boolean))];
    for (const id of locationIds) {
      if (getCachedName(id)) continue;
      try {
        if (id < 100_000_000) {
          // NPC station — public endpoint, no auth needed
          const res = await esiGet(`/universe/stations/${id}/`);
          if (res?.name) cacheName(id, res.name, 'station');
        } else {
          // Player-owned structure — may return 403 if corp disallows ESI access
          await resolveStructureName(id, characterId);
        }
      } catch { /* best effort */ }
    }

    // Send notifications for new contracts assigned to corp
    if (newForCorp.length > 0) {
      const { sendContractAlerts } = require('./notifications');
      try {
        await sendContractAlerts(newForCorp);
        for (const c of newForCorp) {
          db.prepare('UPDATE corp_contracts SET notified = 1 WHERE contract_id = ?').run(c.contractId);
        }
      } catch (e) {
        console.error('[Sync] Contract notification error:', e.message);
      }
    }

    setSyncStatus('contracts');
    console.log(`[Sync] Contracts: ${data.length} total, ${newForCorp.length} new for corp`);
  } catch (err) {
    setSyncStatus('contracts', err.message);
    console.error('[Sync] Contracts error:', err.message);
  }
}

// ── Corp Kills (zKillboard + ESI killmails) ───────────────────────────────────
async function syncKills(corpId) {
  try {
    const zkbRes = await fetch(
      `https://zkillboard.com/api/kills/corporationID/${corpId}/`,
      { headers: { 'User-Agent': 'EVE-Corp-Dashboard/1.0' } }
    );
    const zkbData = await zkbRes.json();
    const kills = zkbData || [];

    const insert = db.prepare(`
      INSERT OR IGNORE INTO corp_kills
        (kill_id, kill_time, victim_corp_id, victim_ship_id, victim_ship_name,
         solar_system_id, solar_system_name, total_value, attackers_json, corporation_id, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAll = db.transaction(list => { for (const r of list) insert.run(...r); });
    const now = Math.floor(Date.now() / 1000);

    const newKills = kills.filter(k =>
      !db.prepare('SELECT kill_id FROM corp_kills WHERE kill_id = ?').get(k.killmail_id)
    );

    const rows = [];
    const allAttackerIds = new Set(); // collect for bulk name resolution

    for (const k of newKills.slice(0, 50)) {
      try {
        const hash = k.zkb?.hash;
        if (!hash) continue;
        const km         = await esiGet(`/killmails/${k.killmail_id}/${hash}/`);
        const systemName = await resolveSystemName(km.solar_system_id);
        const shipName   = km.victim?.ship_type_id ? await resolveTypeName(km.victim.ship_type_id) : null;

        // Collect attacker + victim character IDs for name resolution
        for (const a of (km.attackers || [])) {
          if (a.character_id) allAttackerIds.add(a.character_id);
        }
        if (km.victim?.character_id) allAttackerIds.add(km.victim.character_id);

        rows.push([
          km.killmail_id,
          km.killmail_time,
          km.victim?.corporation_id || null,
          km.victim?.ship_type_id   || null,
          shipName,
          km.solar_system_id || null,
          systemName,
          k.zkb?.totalValue || 0,
          JSON.stringify(km.attackers || []),
          corpId,
          now,
        ]);
      } catch { /* skip individual kill errors */ }
    }
    if (rows.length) insertAll(rows);

    // Bulk-resolve all character names and cache them (so the route can show names not IDs)
    if (allAttackerIds.size > 0) {
      await resolveNames([...allAttackerIds]).catch(() => {});
    }

    setSyncStatus('kills');
    console.log(`[Sync] Kills: ${rows.length} new kills synced, ${allAttackerIds.size} names resolved`);
  } catch (err) {
    setSyncStatus('kills', err.message);
    console.error('[Sync] Kills error:', err.message);
  }
}

// ── Corp Losses (zKillboard + ESI killmails) ──────────────────────────────────
async function syncLosses(corpId) {
  try {
    const zkbRes = await fetch(
      `https://zkillboard.com/api/losses/corporationID/${corpId}/`,
      { headers: { 'User-Agent': 'EVE-Corp-Dashboard/1.0' } }
    );
    const zkbData = await zkbRes.json();
    const losses = zkbData || [];

    const insert = db.prepare(`
      INSERT OR IGNORE INTO corp_losses
        (kill_id, kill_time, victim_char_id, victim_char_name,
         victim_ship_id, victim_ship_name, solar_system_id, solar_system_name,
         total_value, corporation_id, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAll = db.transaction(list => { for (const r of list) insert.run(...r); });
    const now = Math.floor(Date.now() / 1000);

    const newLosses = losses.filter(k =>
      !db.prepare('SELECT kill_id FROM corp_losses WHERE kill_id = ?').get(k.killmail_id)
    );

    const rows = [];
    const charIds = new Set();

    for (const k of newLosses.slice(0, 50)) {
      try {
        const hash = k.zkb?.hash;
        if (!hash) continue;
        const km         = await esiGet(`/killmails/${k.killmail_id}/${hash}/`);
        const systemName = await resolveSystemName(km.solar_system_id);
        const shipName   = km.victim?.ship_type_id ? await resolveTypeName(km.victim.ship_type_id) : null;

        if (km.victim?.character_id) charIds.add(km.victim.character_id);

        rows.push([
          km.killmail_id,
          km.killmail_time,
          km.victim?.character_id    || null,
          null, // resolved in bulk below
          km.victim?.ship_type_id    || null,
          shipName,
          km.solar_system_id         || null,
          systemName,
          k.zkb?.totalValue          || 0,
          corpId,
          now,
        ]);
      } catch { /* skip individual kill errors */ }
    }
    if (rows.length) insertAll(rows);

    // Bulk-resolve victim character names
    if (charIds.size > 0) {
      await resolveNames([...charIds]).catch(() => {});
      // Backfill victim_char_name from name_cache
      for (const cid of charIds) {
        const nc = db.prepare('SELECT name FROM name_cache WHERE id = ?').get(cid);
        if (nc?.name) {
          db.prepare('UPDATE corp_losses SET victim_char_name = ? WHERE victim_char_id = ? AND victim_char_name IS NULL')
            .run(nc.name, cid);
        }
      }
    }

    setSyncStatus('losses');
    console.log(`[Sync] Losses: ${rows.length} new losses synced`);
  } catch (err) {
    setSyncStatus('losses', err.message);
    console.error('[Sync] Losses error:', err.message);
  }
}

// ── Monthly Snapshot ──────────────────────────────────────────────────────────
async function createMonthlySnapshot(characterId) {
  const month  = new Date().toISOString().slice(0, 7);
  const now    = Math.floor(Date.now() / 1000);
  const token  = getToken(characterId);
  const corpId = token?.corporation_id;
  if (!corpId) return;

  // Use the balance from the most recent journal entry per division (MAX journal_id = newest)
  const walletRow = db.prepare(`
    SELECT SUM(balance) AS total FROM wallet_journal
    WHERE corporation_id = ? AND journal_id IN (
      SELECT MAX(journal_id) FROM wallet_journal WHERE balance IS NOT NULL AND corporation_id = ? GROUP BY division
    )
  `).get(corpId, corpId);

  const topTax = db.prepare(`
    SELECT main_name, SUM(total_amount) AS t FROM tax_summary
    WHERE period = ? AND corporation_id = ? GROUP BY main_name ORDER BY t DESC LIMIT 1
  `).get(month, corpId);

  const structCount  = db.prepare('SELECT COUNT(*) AS c FROM structures WHERE corporation_id = ?').get(corpId)?.c || 0;
  const metenoxCount = db.prepare('SELECT COUNT(*) AS c FROM structures WHERE type_id = ? AND corporation_id = ?').get(METENOX_TYPE_ID, corpId)?.c || 0;

  db.prepare(`
    INSERT INTO monthly_snapshots
      (month, wallet_balance, corp_equity, active_members, metenox_monthly_profit, total_mining_isk, top_taxpayer, snapshot_json, corporation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(month) DO UPDATE SET
      wallet_balance = excluded.wallet_balance,
      top_taxpayer   = excluded.top_taxpayer,
      snapshot_json  = excluded.snapshot_json,
      corporation_id = excluded.corporation_id,
      created_at     = excluded.created_at
  `).run(month, walletRow?.total || 0, 0, 0,
         metenoxCount * MONTHLY_FUEL_COST, 0,
         topTax?.main_name || null,
         JSON.stringify({ structCount, metenoxCount }), corpId, now);

  console.log(`[Snapshot] Created snapshot for ${month}`);
}

// ── Cron Jobs ─────────────────────────────────────────────────────────────────
let _characterId = null;

function startScheduler(characterId) {
  _characterId = characterId;

  // Structures — every hour
  cron.schedule('0 * * * *', () => {
    const t = getToken(_characterId);
    if (t) syncStructures(_characterId, t.corporation_id);
  });

  // Wallet — hourly (offset 5 min)
  cron.schedule('5 * * * *', () => {
    const t = getToken(_characterId);
    if (t) syncWallet(_characterId, t.corporation_id);
  });

  // Market prices — every 5 min
  cron.schedule('*/5 * * * *', () => syncMarketPrices());

  // Assets — every hour (offset 10 min)
  cron.schedule('10 * * * *', () => {
    const t = getToken(_characterId);
    if (t) syncAssets(_characterId, t.corporation_id);
  });

  // Notifications check — daily 08:00 UTC
  cron.schedule('0 8 * * *', () => {
    const { checkAndNotify } = require('./notifications');
    checkAndNotify();
  });

  // Monthly snapshot — 1st of month at 00:05 UTC
  cron.schedule('5 0 1 * *', () => createMonthlySnapshot(_characterId));

  // Member tracking — every 30 min
  cron.schedule('*/30 * * * *', () => {
    const t = getToken(_characterId);
    if (t) syncMemberTracking(_characterId, t.corporation_id);
  });

  // Mining observers (Athanor/Tatara/Metenox) — every 3 hours
  cron.schedule('0 */3 * * *', () => {
    const t = getToken(_characterId);
    if (t) syncMiningObservers(_characterId, t.corporation_id);
  });

  // Corp kills — every 6 hours
  cron.schedule('0 */6 * * *', () => {
    const t = getToken(_characterId);
    if (t) syncKills(t.corporation_id);
  });

  // Contracts — every 15 min
  cron.schedule('*/15 * * * *', () => {
    const t = getToken(_characterId);
    if (t) syncContracts(_characterId, t.corporation_id);
  });

  console.log('[Scheduler] Cron jobs started');
}

function updateSchedulerCharacter(characterId) { _characterId = characterId; }

module.exports = { startScheduler, updateSchedulerCharacter, runFullSync, createMonthlySnapshot, syncKills, syncLosses, syncContracts };
