'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const { encryptValue, decryptValue } = require('./secure-storage');

// DB_PATH can be overridden by Electron (or any launcher) via environment variable
// so the database lives in the user's data folder, not the install directory.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'corp.db');

// Ensure the directory exists (important for first run and Electron userData paths)
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
  character_id    INTEGER PRIMARY KEY,
  character_name  TEXT NOT NULL,
  corporation_id  INTEGER,
  corporation_name TEXT,
  access_token    TEXT,
  refresh_token   TEXT,
  expires_at      INTEGER,
  scopes          TEXT
);

CREATE TABLE IF NOT EXISTS structures (
  structure_id  INTEGER PRIMARY KEY,
  name          TEXT,
  type_id       INTEGER,
  type_name     TEXT,
  system_id     INTEGER,
  system_name   TEXT,
  fuel_expires  TEXT,
  services      TEXT,
  state         TEXT,
  synced_at     INTEGER
);

CREATE TABLE IF NOT EXISTS structure_gas (
  structure_id       INTEGER PRIMARY KEY,
  last_refill_date   TEXT,
  quantity_refilled  INTEGER DEFAULT 0,
  daily_consumption  INTEGER DEFAULT 4800,
  notes              TEXT
);

CREATE TABLE IF NOT EXISTS wallet_journal (
  journal_id       INTEGER NOT NULL,
  division         INTEGER NOT NULL,
  date             TEXT,
  ref_type         TEXT,
  first_party_id   INTEGER,
  second_party_id  INTEGER,
  amount           REAL,
  balance          REAL,
  description      TEXT,
  synced_at        INTEGER,
  PRIMARY KEY (journal_id, division)
);

CREATE INDEX IF NOT EXISTS idx_wj_date        ON wallet_journal(date);
CREATE INDEX IF NOT EXISTS idx_wj_second_party ON wallet_journal(second_party_id);
CREATE INDEX IF NOT EXISTS idx_wj_ref_type     ON wallet_journal(ref_type);

CREATE TABLE IF NOT EXISTS alt_mappings (
  character_id    INTEGER PRIMARY KEY,
  character_name  TEXT NOT NULL,
  main_name       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tax_summary (
  period          TEXT,
  character_id    INTEGER,
  character_name  TEXT,
  main_name       TEXT,
  total_amount    REAL,
  PRIMARY KEY (period, character_id)
);

CREATE TABLE IF NOT EXISTS market_prices (
  type_id        INTEGER PRIMARY KEY,
  type_name      TEXT,
  adjusted_price REAL,
  average_price  REAL,
  jita_sell_min  REAL,
  updated_at     INTEGER
);

CREATE TABLE IF NOT EXISTS assets (
  item_id        INTEGER PRIMARY KEY,
  type_id        INTEGER,
  type_name      TEXT,
  quantity       INTEGER,
  location_id    INTEGER,
  location_name  TEXT,
  location_type  TEXT,
  category       TEXT,
  group_name     TEXT,
  est_value      REAL DEFAULT 0,
  synced_at      INTEGER
);

CREATE TABLE IF NOT EXISTS notification_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS notification_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  structure_id  INTEGER,
  alert_type    TEXT,
  days_remaining REAL,
  sent_at       INTEGER
);

CREATE TABLE IF NOT EXISTS monthly_snapshots (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  month                  TEXT UNIQUE,
  wallet_balance         REAL,
  corp_equity            REAL,
  active_members         INTEGER,
  metenox_monthly_profit REAL,
  total_mining_isk       REAL,
  top_taxpayer           TEXT,
  snapshot_json          TEXT,
  created_at             INTEGER
);

CREATE TABLE IF NOT EXISTS sync_status (
  key        TEXT PRIMARY KEY,
  last_sync  INTEGER,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS name_cache (
  id    INTEGER PRIMARY KEY,
  name  TEXT,
  type  TEXT
);

CREATE TABLE IF NOT EXISTS member_tracking (
  character_id   INTEGER PRIMARY KEY,
  character_name TEXT,
  logon_date     TEXT,
  logoff_date    TEXT,
  ship_type_id   INTEGER,
  location_id    INTEGER,
  synced_at      INTEGER
);

CREATE TABLE IF NOT EXISTS mining_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id   INTEGER,
  character_name TEXT,
  main_name      TEXT,
  type_id        INTEGER,
  type_name      TEXT,
  quantity       INTEGER,
  date           TEXT,
  synced_at      INTEGER,
  UNIQUE(character_id, type_id, date)
);

CREATE INDEX IF NOT EXISTS idx_ml_date ON mining_ledger(date);
CREATE INDEX IF NOT EXISTS idx_ml_char ON mining_ledger(character_id);

CREATE TABLE IF NOT EXISTS mining_observers (
  observer_id    INTEGER,
  character_id   INTEGER,
  type_id        INTEGER,
  type_name      TEXT,
  quantity       INTEGER,
  last_updated   TEXT,
  synced_at      INTEGER,
  PRIMARY KEY (observer_id, character_id, type_id, last_updated)
);

CREATE TABLE IF NOT EXISTS corp_kills (
  kill_id           INTEGER PRIMARY KEY,
  kill_time         TEXT,
  victim_corp_id    INTEGER,
  victim_ship_id    INTEGER,
  victim_ship_name  TEXT,
  solar_system_id   INTEGER,
  solar_system_name TEXT,
  total_value       REAL,
  attackers_json    TEXT,
  synced_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ck_time ON corp_kills(kill_time);

CREATE TABLE IF NOT EXISTS corp_losses (
  kill_id           INTEGER PRIMARY KEY,
  kill_time         TEXT,
  victim_char_id    INTEGER,
  victim_char_name  TEXT,
  victim_ship_id    INTEGER,
  victim_ship_name  TEXT,
  solar_system_id   INTEGER,
  solar_system_name TEXT,
  total_value       REAL,
  synced_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cl_time ON corp_losses(kill_time);

CREATE TABLE IF NOT EXISTS metenox_manual_materials (
  structure_id  INTEGER,
  type_id       INTEGER,
  type_name     TEXT,
  qty_per_hour  REAL,
  PRIMARY KEY (structure_id, type_id)
);

CREATE TABLE IF NOT EXISTS moon_extractions (
  structure_id          INTEGER,
  corporation_id        INTEGER DEFAULT 0,
  moon_id               INTEGER,
  extraction_start_time TEXT,
  chunk_arrival_time    TEXT,
  natural_decay_time    TEXT,
  synced_at             INTEGER,
  PRIMARY KEY (structure_id, corporation_id)
);

CREATE TABLE IF NOT EXISTS wallet_division_history (
  corporation_id INTEGER,
  month          TEXT,
  division       INTEGER,
  balance        REAL,
  PRIMARY KEY (corporation_id, month, division)
);

CREATE TABLE IF NOT EXISTS corp_contracts (
  contract_id        INTEGER PRIMARY KEY,
  issuer_id          INTEGER,
  issuer_name        TEXT,
  issuer_corp_id     INTEGER,
  assignee_id        INTEGER,
  type               TEXT,
  status             TEXT,
  title              TEXT,
  for_corporation    INTEGER DEFAULT 0,
  availability       TEXT,
  date_issued        TEXT,
  date_expired       TEXT,
  date_accepted      TEXT,
  date_completed     TEXT,
  price              REAL DEFAULT 0,
  reward             REAL DEFAULT 0,
  collateral         REAL DEFAULT 0,
  volume             REAL DEFAULT 0,
  start_location_id  INTEGER,
  end_location_id    INTEGER,
  notified           INTEGER DEFAULT 0,
  synced_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cc_status  ON corp_contracts(status);
CREATE INDEX IF NOT EXISTS idx_cc_issued  ON corp_contracts(date_issued);
`);

// Schema migrations (add columns added after initial deploy)
try { db.exec('ALTER TABLE market_prices ADD COLUMN jita_buy_max REAL'); } catch {}
try { db.exec('ALTER TABLE assets ADD COLUMN location_flag TEXT'); } catch {}

// Corp isolation: tag every data row with the owning corporation_id
try { db.exec('ALTER TABLE structures ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE wallet_journal ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE assets ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE member_tracking ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE mining_observers ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE corp_kills ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE corp_losses ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE tax_summary ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE monthly_snapshots ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE corp_contracts ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE mining_ledger ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE alt_mappings ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE notification_log ADD COLUMN corporation_id INTEGER DEFAULT 0'); } catch {}

// Migrate wallet_journal PRIMARY KEY: journal_id → (journal_id, division)
// EVE uses the same journal_id for BOTH sides of an inter-division transfer
// (debit in source division, credit in destination). The old single-column PK
// caused INSERT OR IGNORE to silently drop the credit side, so destination
// division journals appeared empty even after a full sync.
{
  const wjCols = db.prepare('PRAGMA table_info(wallet_journal)').all();
  const divisionPkPos = wjCols.find(c => c.name === 'division')?.pk || 0;
  if (divisionPkPos === 0) {
    console.log('[DB] Migrating wallet_journal to composite PRIMARY KEY (journal_id, division)…');
    db.exec(`
      BEGIN;
      CREATE TABLE wallet_journal_new (
        journal_id       INTEGER NOT NULL,
        division         INTEGER NOT NULL,
        date             TEXT,
        ref_type         TEXT,
        first_party_id   INTEGER,
        second_party_id  INTEGER,
        amount           REAL,
        balance          REAL,
        description      TEXT,
        synced_at        INTEGER,
        PRIMARY KEY (journal_id, division)
      );
      INSERT OR IGNORE INTO wallet_journal_new SELECT * FROM wallet_journal;
      DROP TABLE wallet_journal;
      ALTER TABLE wallet_journal_new RENAME TO wallet_journal;
      COMMIT;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_wj_date        ON wallet_journal(date);
      CREATE INDEX IF NOT EXISTS idx_wj_second_party ON wallet_journal(second_party_id);
      CREATE INDEX IF NOT EXISTS idx_wj_ref_type     ON wallet_journal(ref_type);
      CREATE INDEX IF NOT EXISTS idx_wj_division     ON wallet_journal(division);
    `);
    console.log('[DB] wallet_journal migration complete — run a Full Sync to backfill missing inter-division entries.');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Upsert a token row */
function saveToken(data) {
  const payload = {
    ...data,
    access_token:  encryptValue(data.access_token),
    refresh_token: encryptValue(data.refresh_token),
  };
  db.prepare(`
    INSERT INTO tokens (character_id, character_name, corporation_id, corporation_name,
                        access_token, refresh_token, expires_at, scopes)
    VALUES (@character_id, @character_name, @corporation_id, @corporation_name,
            @access_token, @refresh_token, @expires_at, @scopes)
    ON CONFLICT(character_id) DO UPDATE SET
      character_name   = excluded.character_name,
      corporation_id   = excluded.corporation_id,
      corporation_name = excluded.corporation_name,
      access_token     = excluded.access_token,
      refresh_token    = excluded.refresh_token,
      expires_at       = excluded.expires_at,
      scopes           = excluded.scopes
  `).run(payload);
}

function getToken(characterId) {
  const row = db.prepare('SELECT * FROM tokens WHERE character_id = ?').get(characterId);
  if (!row) return undefined;
  row.access_token = decryptValue(row.access_token);
  row.refresh_token = decryptValue(row.refresh_token);
  return row;
}

function updateAccessToken(characterId, accessToken, expiresAt, refreshToken = null) {
  const encrypted = encryptValue(accessToken);
  if (refreshToken != null) {
    const encRefresh = encryptValue(refreshToken);
    db.prepare('UPDATE tokens SET access_token = ?, expires_at = ?, refresh_token = ? WHERE character_id = ?')
      .run(encrypted, expiresAt, encRefresh, characterId);
  } else {
    db.prepare('UPDATE tokens SET access_token = ?, expires_at = ? WHERE character_id = ?')
      .run(encrypted, expiresAt, characterId);
  }
}

function getSetting(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM notification_settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO notification_settings (key, value) VALUES (?, ?)')
    .run(key, String(value));
}


function getSyncStatus(key) {
  return db.prepare('SELECT * FROM sync_status WHERE key = ?').get(key);
}

function setSyncStatus(key, error = null) {
  db.prepare('INSERT OR REPLACE INTO sync_status (key, last_sync, last_error) VALUES (?, ?, ?)')
    .run(key, Math.floor(Date.now() / 1000), error);
}

function cacheName(id, name, type = 'character') {
  db.prepare('INSERT OR REPLACE INTO name_cache (id, name, type) VALUES (?, ?, ?)')
    .run(id, name, type);
}

function getCachedName(id) {
  return db.prepare('SELECT name FROM name_cache WHERE id = ?').get(id);
}

module.exports = {
  db,
  DB_PATH,
  saveToken, getToken, updateAccessToken,
  getSetting, setSetting,
  getSyncStatus, setSyncStatus,
  cacheName, getCachedName,
};
