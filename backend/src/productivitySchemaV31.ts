import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { ensurePrivateFile } from './config/filePermissions';
import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from './connectors/errors';

export const PRODUCTIVITY_SCHEMA_V31 = 'v3.1';

function integrityOk(db: Database.Database): boolean {
  const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | string;
  const value = typeof row === 'string' ? row : row?.integrity_check;
  return value === 'ok';
}

export function v31BackupPath(dbPath: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(4).toString('hex');
  return `${dbPath}.v31-${stamp}-${suffix}.bak`;
}

export function onlineSqliteBackup(src: Database.Database, destPath: string): void {
  if (existsSync(destPath)) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.SCHEMA_MIGRATION_FAILED, '备份目标已存在');
  }
  if (!integrityOk(src)) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.SCHEMA_MIGRATION_FAILED, '源库 integrity_check 失败');
  }
  const escaped = destPath.replace(/'/g, "''");
  src.exec(`VACUUM INTO '${escaped}'`);
  ensurePrivateFile(destPath);
  const DatabaseCtor = src.constructor as unknown as { new (path: string, opts: { readonly: boolean; fileMustExist: boolean }): Database.Database };
  const check = new DatabaseCtor(destPath, { readonly: true, fileMustExist: true });
  try {
    if (!integrityOk(check)) {
      throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.SCHEMA_MIGRATION_FAILED, '备份 integrity_check 失败');
    }
  } finally {
    check.close();
  }
}

export function migrateProductivityV31(db: Database.Database): void {
  const tx = db.transaction(() => {
    const cols = (db.prepare(`PRAGMA table_info(todos)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('source_scope')) {
      db.exec(`ALTER TABLE todos ADD COLUMN source_scope TEXT`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS analysis_cursors (
        cursor_key TEXT PRIMARY KEY,
        high_water TEXT,
        last_success_at TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        partial INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_sugg_active
        ON ai_action_suggestions(action_identity, source_type, status)
        WHERE status='open' AND action_identity IS NOT NULL;
    `);
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('productivitySchemaVersion', ?)`).run(JSON.stringify(PRODUCTIVITY_SCHEMA_V31));
    const migratedAt = db.prepare(`SELECT value FROM settings WHERE key='productivityV31MigratedAt'`).get() as { value: string } | undefined;
    if (!migratedAt) {
      db.prepare(`INSERT INTO settings (key, value) VALUES ('productivityV31MigratedAt', ?)`).run(JSON.stringify(new Date().toISOString()));
    }
  });
  tx();
}

export function ensureProductivityV31(
  db: Database.Database,
  opts: { skipBackup?: boolean; dbPath?: string } = {}
): void {
  const versionRow = db.prepare(`SELECT value FROM settings WHERE key = 'productivitySchemaVersion'`).get() as { value: string } | undefined;
  let version = 'v2';
  if (versionRow) {
    try {
      version = JSON.parse(versionRow.value);
    } catch {
      version = versionRow.value;
    }
  }
  if (version === PRODUCTIVITY_SCHEMA_V31 || version === 'v4') {
    const hasCursorTable = Boolean(
      db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='analysis_cursors'`).get()
    );
    const hasSuggestionIndex = Boolean(
      db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='index' AND name='idx_ai_sugg_active'`).get()
    );
    if (hasCursorTable && hasSuggestionIndex) return;
  }
  if (!opts.skipBackup && opts.dbPath) {
    onlineSqliteBackup(db, v31BackupPath(opts.dbPath));
  }
  migrateProductivityV31(db);
}
