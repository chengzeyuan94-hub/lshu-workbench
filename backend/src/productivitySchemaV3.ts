import { copyFileSync, existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { ensurePrivateFile } from './config/filePermissions';
import { sha256 } from './services/hash';
import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from './connectors/errors';

export const PRODUCTIVITY_SCHEMA_V3 = 'v3';

const TODO_V3_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: 'origin_mode', ddl: "origin_mode TEXT NOT NULL DEFAULT 'legacy'" },
  { name: 'source_status', ddl: "source_status TEXT NOT NULL DEFAULT 'open'" },
  { name: 'source_freshness', ddl: "source_freshness TEXT NOT NULL DEFAULT 'unknown'" },
  { name: 'consecutive_missing_count', ddl: 'consecutive_missing_count INTEGER NOT NULL DEFAULT 0' },
  { name: 'last_full_seen_at', ddl: 'last_full_seen_at TEXT' },
  { name: 'inference_confidence', ddl: 'inference_confidence REAL' },
  { name: 'inference_reason_code', ddl: 'inference_reason_code TEXT' },
  { name: 'ai_analysis_id', ddl: 'ai_analysis_id INTEGER' },
  { name: 'action_identity', ddl: 'action_identity TEXT' },
  { name: 'source_readonly', ddl: 'source_readonly INTEGER NOT NULL DEFAULT 0' },
  { name: 'user_edited_at', ddl: 'user_edited_at TEXT' },
  { name: 'visibility', ddl: "visibility TEXT NOT NULL DEFAULT 'visible'" },
  { name: 'archived_at', ddl: 'archived_at TEXT' },
  { name: 'archive_reason', ddl: 'archive_reason TEXT' },
];

export interface MigrationAuditCounts {
  duplicateEvidence: number;
  sourceFingerprintConflicts: number;
  statusDriftFixed: number;
}

export function currentProductivitySchemaVersion(db: Database.Database): string {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'productivitySchemaVersion'`).get() as { value: string } | undefined;
    if (!row) return 'v2';
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  } catch {
    return 'v2';
  }
}

export function evidenceKey(input: {
  todoId: number;
  sourceType: string;
  externalId?: string | null;
  fingerprint?: string | null;
  evidenceType: string;
  discriminator?: string;
}): string {
  return sha256(
    String(input.todoId),
    input.sourceType,
    input.externalId || '',
    input.fingerprint || '',
    input.evidenceType,
    input.discriminator || ''
  );
}

export function backupSqliteThenVerify(db: Database.Database, destPath: string): void {
  db.pragma('wal_checkpoint(FULL)');
  const src = typeof db.name === 'string' && db.name && db.name !== ':memory:' ? db.name : '';
  if (!src) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.SCHEMA_MIGRATION_FAILED, '无法备份内存数据库');
  }
  copyFileSync(src, destPath);
  ensurePrivateFile(destPath);
  const Database = (db.constructor as unknown as { new (path: string, opts: { readonly: boolean; fileMustExist: boolean }): Database.Database });
  const check = new Database(destPath, { readonly: true, fileMustExist: true });
  try {
    check.prepare('SELECT 1 AS ok').get();
  } finally {
    check.close();
  }
}

function addColumns(db: Database.Database, table: string, cols: Array<{ name: string; ddl: string }>): void {
  const existing = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  for (const col of cols) {
    if (!existing.includes(col.name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.ddl}`);
    }
  }
}

function backfillOriginAndDrift(db: Database.Database): number {
  db.exec(`UPDATE todos SET origin_mode = 'legacy' WHERE origin_mode IS NULL OR origin_mode = ''`);
  const drift = db.prepare(
    `UPDATE todos SET lifecycle_status = 'confirmed', updated_at = updated_at
     WHERE status = 'confirmed'
       AND lifecycle_status = 'candidate'
       AND COALESCE(lifecycle_status, '') NOT IN ('completed','ignored')
       AND status NOT IN ('ignored')`
  ).run();
  return Number(drift.changes || 0);
}

function migrateEvidenceKeys(db: Database.Database): number {
  const evCols = (db.prepare(`PRAGMA table_info(todo_source_evidence)`).all() as { name: string }[]).map((c) => c.name);
  if (!evCols.includes('evidence_key')) {
    db.exec(`ALTER TABLE todo_source_evidence ADD COLUMN evidence_key TEXT NOT NULL DEFAULT ''`);
  }
  const rows = db.prepare(`SELECT id, todo_id, source_type, external_id, fingerprint, evidence_type FROM todo_source_evidence`).all() as Array<{
    id: number;
    todo_id: number;
    source_type: string;
    external_id: string | null;
    fingerprint: string | null;
    evidence_type: string;
  }>;
  const seen = new Map<string, number>();
  let dupes = 0;
  const upd = db.prepare(`UPDATE todo_source_evidence SET evidence_key = ? WHERE id = ?`);
  for (const row of rows) {
    const base = evidenceKey({
      todoId: row.todo_id,
      sourceType: row.source_type,
      externalId: row.external_id,
      fingerprint: row.fingerprint,
      evidenceType: row.evidence_type,
    });
    if (!seen.has(base)) {
      seen.set(base, row.id);
      upd.run(base, row.id);
    } else {
      dupes += 1;
      upd.run(`${base}:legacy:${row.id}`, row.id);
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_evidence_key ON todo_source_evidence (todo_id, evidence_key)`);
  return dupes;
}

function createV3Tables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_source_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL,
      action_identity TEXT NOT NULL DEFAULT '',
      relation_type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_external_id TEXT NOT NULL DEFAULT '',
      source_fingerprint TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES todos (id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_source_links_multi
      ON todo_source_links (todo_id, action_identity, source_type, source_external_id, relation_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_things_primary_mirror
      ON todo_source_links (source_external_id)
      WHERE source_type = 'things' AND relation_type = 'primary_mirror';

    CREATE TABLE IF NOT EXISTS ai_analysis_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opaque_stable_source_hash TEXT NOT NULL,
      canonical_projection_hash TEXT NOT NULL,
      source_type TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      external_text_policy_version TEXT NOT NULL,
      result_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_cache_key ON ai_analysis_cache (
      model, prompt_version, schema_version, external_text_policy_version, source_type, opaque_stable_source_hash, canonical_projection_hash
    );

    CREATE TABLE IF NOT EXISTS ai_analysis_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      calls INTEGER NOT NULL DEFAULT 0,
      retries INTEGER NOT NULL DEFAULT 0,
      input_units INTEGER NOT NULL DEFAULT 0,
      actionable INTEGER NOT NULL DEFAULT 0,
      review INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      deferred INTEGER NOT NULL DEFAULT 0,
      cache_hits INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      error_code TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_action_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_identity TEXT,
      source_type TEXT NOT NULL,
      owner TEXT NOT NULL,
      intent TEXT NOT NULL,
      title TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      priority TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agenda_event_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      canonical_event_key TEXT NOT NULL UNIQUE,
      calendar_identifier TEXT NOT NULL,
      event_identifier TEXT NOT NULL,
      occurrence_start_at TEXT NOT NULL,
      calendar_name TEXT,
      title TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      original_timezone TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      all_day_local_start TEXT,
      all_day_local_end TEXT,
      availability TEXT NOT NULL DEFAULT 'busy',
      readonly INTEGER NOT NULL DEFAULT 1,
      owned_by_workbench INTEGER NOT NULL DEFAULT 0,
      calendar_type TEXT,
      last_seen_at TEXT NOT NULL,
      stale_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agenda_sync_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      from_at TEXT NOT NULL,
      to_at TEXT NOT NULL,
      timezone TEXT NOT NULL,
      snapshot_complete INTEGER NOT NULL DEFAULT 0,
      last_success_at TEXT,
      stale_after TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      error_code TEXT
    );

    CREATE TABLE IF NOT EXISTS productivity_migration_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL,
      conflict_type TEXT NOT NULL,
      affected_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_budget_days (
      day_key TEXT PRIMARY KEY,
      reserved_input INTEGER NOT NULL DEFAULT 0,
      reserved_output INTEGER NOT NULL DEFAULT 0,
      used_input INTEGER NOT NULL DEFAULT 0,
      used_output INTEGER NOT NULL DEFAULT 0,
      estimated_usd REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS feishu_chat_cursors (
      chat_hash TEXT PRIMARY KEY,
      watermark TEXT,
      last_success_at TEXT,
      status TEXT NOT NULL DEFAULT 'ok'
    );
  `);
}

function writeAudit(db: Database.Database, conflictType: string, count: number, status: string): void {
  db.prepare(
    `INSERT INTO productivity_migration_audit (version, conflict_type, affected_count, started_at, finished_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(PRODUCTIVITY_SCHEMA_V3, conflictType, count, new Date().toISOString(), new Date().toISOString(), status);
}

export function migrateProductivityV3(db: Database.Database): MigrationAuditCounts {
  addColumns(db, 'todos', TODO_V3_COLUMNS);
  createV3Tables(db);
  const statusDriftFixed = backfillOriginAndDrift(db);
  const duplicateEvidence = migrateEvidenceKeys(db);

  const fpConflicts = db
    .prepare(
      `SELECT source_fingerprint AS fp, COUNT(*) AS n FROM todos
       WHERE source_fingerprint IS NOT NULL AND source_fingerprint != ''
       GROUP BY source_fingerprint HAVING n > 1`
    )
    .all() as Array<{ fp: string; n: number }>;

  writeAudit(db, 'duplicate_evidence', duplicateEvidence, 'ok');
  writeAudit(db, 'source_fingerprint_conflicts', fpConflicts.length, fpConflicts.length ? 'isolated' : 'ok');
  writeAudit(db, 'status_drift', statusDriftFixed, 'ok');

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('productivitySchemaVersion', ?)`).run(
    JSON.stringify(PRODUCTIVITY_SCHEMA_V3)
  );
  const migratedAt = db.prepare(`SELECT value FROM settings WHERE key='productivityV3MigratedAt'`).get() as { value: string } | undefined;
  if (!migratedAt) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('productivityV3MigratedAt', ?)`).run(JSON.stringify(new Date().toISOString()));
  }
  return {
    duplicateEvidence,
    sourceFingerprintConflicts: fpConflicts.length,
    statusDriftFixed,
  };
}

export function ensureProductivityV3(
  db: Database.Database,
  options: { backupPath?: string; skipBackup?: boolean } = {}
): MigrationAuditCounts {
  const currentVersion = currentProductivitySchemaVersion(db);
  if ([PRODUCTIVITY_SCHEMA_V3, 'v3.1', 'v4'].includes(currentVersion)) {
    const evCols = (db.prepare(`PRAGMA table_info(todo_source_evidence)`).all() as { name: string }[]).map((c) => c.name);
    if (evCols.includes('evidence_key')) return { duplicateEvidence: 0, sourceFingerprintConflicts: 0, statusDriftFixed: 0 };
  }
  if (!options.skipBackup && options.backupPath) {
    try {
      backupSqliteThenVerify(db, options.backupPath);
    } catch (e) {
      throw new ProductivityError(
        PRODUCTIVITY_ERROR_CODES.SCHEMA_MIGRATION_FAILED,
        'V3 迁移前备份失败，服务保持未启动'
      );
    }
  }
  try {
    return migrateProductivityV3(db);
  } catch (e) {
    throw new ProductivityError(
      PRODUCTIVITY_ERROR_CODES.SCHEMA_MIGRATION_FAILED,
      'V3 数据库迁移失败，服务保持未启动'
    );
  }
}

export function canonicalEventKey(parts: {
  provider: string;
  calendarIdentifier: string;
  eventIdentifier: string;
  occurrenceStartAt: string;
}): string {
  const provider = String(parts.provider || '').trim();
  const calendarIdentifier = String(parts.calendarIdentifier || '').trim();
  const eventIdentifier = String(parts.eventIdentifier || '').trim();
  const occurrenceStartAt = String(parts.occurrenceStartAt || '').trim();
  if (!provider || !calendarIdentifier || !eventIdentifier || !occurrenceStartAt) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR, '日历事件缺少稳定标识，已跳过');
  }
  return [provider, calendarIdentifier, eventIdentifier, occurrenceStartAt].join('::');
}

export { existsSync };
