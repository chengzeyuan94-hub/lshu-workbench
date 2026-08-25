import type Database from 'better-sqlite3';

export const PRODUCTIVITY_SCHEMA_V4 = 'v4';

function addColumnIfMissing(db: Database.Database, table: string, name: string, ddl: string): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
  if (columns.includes(name)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (error) {
    if (!String((error as Error).message || error).toLowerCase().includes('duplicate column name')) throw error;
  }
}

export function migrateProductivityV4(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS day_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      overview_revision TEXT NOT NULL,
      busy_revision TEXT NOT NULL,
      warning TEXT,
      unverified INTEGER NOT NULL DEFAULT 0,
      strategy TEXT NOT NULL DEFAULT 'manual',
      planner_meta_json TEXT NOT NULL DEFAULT '{}',
      unscheduled_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_day_plans_date_tz
      ON day_plans (local_date, timezone);

    CREATE TABLE IF NOT EXISTS day_plan_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      stable_key TEXT NOT NULL,
      todo_id INTEGER,
      title TEXT NOT NULL,
      start_at TEXT,
      end_at TEXT,
      source_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      fixed INTEGER NOT NULL DEFAULT 0,
      schedulable INTEGER NOT NULL DEFAULT 1,
      minutes INTEGER NOT NULL DEFAULT 0,
      unscheduled INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      UNIQUE (plan_id, stable_key, start_at)
    );

    CREATE TABLE IF NOT EXISTS ai_unit_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      opaque_hash TEXT NOT NULL,
      local_date TEXT NOT NULL,
      occurred_at TEXT,
      decision TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (opaque_hash, schema_version, prompt_version)
    );
  `);

  const todoCols = (db.prepare(`PRAGMA table_info(todos)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!todoCols.includes('source_occurred_at')) {
    db.exec(`ALTER TABLE todos ADD COLUMN source_occurred_at TEXT`);
  }
  if (!todoCols.includes('action_owner')) {
    db.exec(`ALTER TABLE todos ADD COLUMN action_owner TEXT`);
  }
  const suggCols = (db.prepare(`PRAGMA table_info(ai_action_suggestions)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!suggCols.includes('source_occurred_at')) {
    db.exec(`ALTER TABLE ai_action_suggestions ADD COLUMN source_occurred_at TEXT`);
  }
  addColumnIfMissing(db, 'day_plans', 'strategy', "strategy TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing(db, 'day_plans', 'planner_meta_json', "planner_meta_json TEXT NOT NULL DEFAULT '{}'");
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('productivitySchemaVersion', ?)`).run(
    JSON.stringify(PRODUCTIVITY_SCHEMA_V4)
  );
}

export function ensureProductivityV4(db: Database.Database): void {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((t) => t.name);
  if (!tables.includes('day_plans') || !tables.includes('ai_unit_outcomes')) {
    migrateProductivityV4(db);
    return;
  }
  migrateProductivityV4(db);
}
