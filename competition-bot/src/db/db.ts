import initSqlJs, { type Database as SqlJsDb, type SqlValue } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'competition-bot.db');

let db: SqlJsDb | null = null;
let initialized = false;

/**
 * Thin wrapper around sql.js that mimics better-sqlite3's sync convenience API.
 * sql.js itself is synchronous once the WASM module is loaded.
 * Only supports positional (?) parameters — no named (@name) params.
 */

export interface DbResult {
  changes: number;
  lastInsertRowid: number;
}

export interface DbRow {
  [key: string]: unknown;
}

class DbWrapper {
  constructor(private inner: SqlJsDb) {}

  run(sql: string, params?: readonly unknown[]): DbResult {
    if (params) {
      const stmt = this.inner.prepare(sql);
      stmt.bind(params as SqlValue[]);
      stmt.step();
      stmt.free();
    } else {
      this.inner.run(sql);
    }
    return { changes: 0, lastInsertRowid: 0 };
  }

  all<T = DbRow>(sql: string, params?: readonly unknown[]): T[] {
    const results: T[] = [];
    const stmt = this.inner.prepare(sql);
    if (params) stmt.bind(params as SqlValue[]);
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }

  get<T = DbRow>(sql: string, params?: readonly unknown[]): T | null {
    const rows = this.all<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  transaction(fn: () => void): void {
    this.inner.run('BEGIN');
    try {
      fn();
      this.inner.run('COMMIT');
    } catch (e) {
      this.inner.run('ROLLBACK');
      throw e;
    }
  }

  exec(sql: string): void {
    this.inner.run(sql);
  }

  save(): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = this.inner.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
}

export async function initDb(): Promise<void> {
  if (initialized) return;
  const SQL = await initSqlJs();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');
  migrate();
  initialized = true;
}

function migrate(): void {
  if (!db) throw new Error('DB not initialized');

  db.run(`
    CREATE TABLE IF NOT EXISTS llm_providers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      base_url    TEXT    NOT NULL,
      api_key     TEXT    NOT NULL DEFAULT '',
      model       TEXT    NOT NULL,
      rpm_limit   INTEGER NOT NULL DEFAULT 10,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS competition_pages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      url         TEXT    NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS exclusion_keywords (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword     TEXT    NOT NULL UNIQUE,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS competitions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id             INTEGER NOT NULL,
      title               TEXT    NOT NULL,
      url                 TEXT    NOT NULL,
      source_page_url     TEXT    NOT NULL DEFAULT '',
      description         TEXT    NOT NULL DEFAULT '',
      requires_questions  INTEGER NOT NULL DEFAULT 0,
      status              TEXT    NOT NULL DEFAULT 'found'
                          CHECK (status IN ('found','entered','failed','excluded','skipped')),
      exclusion_reason    TEXT    NOT NULL DEFAULT '',
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (page_id) REFERENCES competition_pages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS entries (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      competition_id      INTEGER NOT NULL,
      competition_title   TEXT    NOT NULL DEFAULT '',
      status              TEXT    NOT NULL DEFAULT 'success'
                          CHECK (status IN ('success','failed')),
      response_data       TEXT    NOT NULL DEFAULT '',
      error_message       TEXT    NOT NULL DEFAULT '',
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_fields (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      field_key   TEXT    NOT NULL UNIQUE,
      field_label TEXT    NOT NULL,
      field_value TEXT    NOT NULL DEFAULT '',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vpn_configs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT    NOT NULL,
      filename    TEXT    NOT NULL UNIQUE,
      country     TEXT    NOT NULL DEFAULT 'unknown',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate: add screenshot columns to entries (safe for existing DBs)
  try {
    db.run('ALTER TABLE entries ADD COLUMN screenshot_before TEXT NOT NULL DEFAULT \'\'');
  } catch { /* column already exists */ }
  try {
    db.run('ALTER TABLE entries ADD COLUMN screenshot_after TEXT NOT NULL DEFAULT \'\'');
  } catch { /* column already exists */ }

  // Seed default settings (INSERT OR IGNORE ensures existing values are preserved)
  const defaultSettings: Array<[string, string]> = [
    ['scan_interval_minutes', '60'],
    ['headless_mode', 'true'],
    ['max_concurrent_entries', '3'],
    ['default_email', ''],
    ['default_name', ''],
    ['llm_verification_enabled', 'false'],
    ['verification_provider_id', ''],
    ['entry_interval_seconds', '30'],
    ['captcha_service', 'none'],
    ['captcha_api_key', ''],
    ['vpn_enabled', 'false'],
    ['vpn_auto_rotate', 'true'],
  ];
  for (const [key, value] of defaultSettings) {
    get().run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
  }

  // Seed default profile fields if table is empty
  const hasFields = get().get('SELECT COUNT(*) as c FROM profile_fields') as { c: number } | null;
  if (!hasFields || hasFields.c === 0) {
    const defaults: Array<{ key: string; label: string }> = [
      { key: 'email',        label: 'Email Address' },
      { key: 'full_name',    label: 'Full Name' },
      { key: 'first_name',   label: 'First Name' },
      { key: 'last_name',    label: 'Last Name' },
      { key: 'phone',        label: 'Phone Number' },
      { key: 'address',      label: 'Street Address' },
      { key: 'address2',     label: 'Address Line 2' },
      { key: 'city',         label: 'City' },
      { key: 'state',        label: 'State / County' },
      { key: 'postcode',     label: 'Postcode / ZIP' },
      { key: 'country',      label: 'Country' },
      { key: 'date_of_birth',label: 'Date of Birth' },
      { key: 'occupation',   label: 'Occupation' },
      { key: 'company',      label: 'Company Name' },
      { key: 'website',      label: 'Personal Website / URL' },
    ];
    const insert = get().run.bind(get());
    for (const f of defaults) {
      insert('INSERT OR IGNORE INTO profile_fields (field_key, field_label, field_value) VALUES (?, ?, ?)',
        [f.key, f.label, '']);
    }
  }

  get().save();
}

export function get(): DbWrapper {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return new DbWrapper(db);
}
