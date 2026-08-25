import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getTodo, productivity, getSettings } from '../db';
import { backupSqliteThenVerify } from '../productivitySchemaV3';
import type Database from 'better-sqlite3';
import db from '../db';

interface CleanupToken {
  token: string;
  expiresAt: number;
  ids: number[];
  hashes: Record<number, string>;
}

const tokens = new Map<string, CleanupToken>();

function rowHash(row: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({
    id: row.id,
    title: row.title,
    status: row.status,
    lifecycle: row.lifecycle_status,
    origin: row.origin_mode,
    updated: row.updated_at,
  })).digest('hex');
}

function v3Cutoff(): string {
  const raw = getSettings().productivityV3MigratedAt;
  return typeof raw === 'string' && raw ? raw : '9999-01-01T00:00:00.000Z';
}

export function previewLegacyAiCleanup(): {
  write: false;
  archiveCount: number;
  keepCount: number;
  reanalyzable: number;
  confirmToken: string;
  expiresAt: string;
} {
  const cutoff = v3Cutoff();
  const rows = (db.prepare(
    `SELECT * FROM todos WHERE source_type='feishu_message' AND status='pending'
       AND COALESCE(lifecycle_status,'candidate')='candidate'
       AND COALESCE(origin_mode,'legacy') IN ('legacy','')`
  ).all() as Array<Record<string, unknown>>);
  const archive: Array<Record<string, unknown>> = [];
  let keep = 0;
  for (const row of rows) {
    const id = Number(row.id);
    const mapping = productivity.getCalendarMapping(id);
    const evidence = productivity.getEvidence(id);
    const hasManual = evidence.some((e) => e.evidence_type === 'user_complete' || e.evidence_type === 'user_reopen' || e.source_type === 'manual');
    const planned = Boolean(row.planned_start_at);
    const unknownEdit = !row.user_edited_at && String(row.created_at || '') < cutoff;
    if (mapping || hasManual || planned || unknownEdit) {
      keep += 1;
      continue;
    }
    archive.push(row);
  }
  const token = randomBytes(16).toString('hex');
  const hashes: Record<number, string> = {};
  for (const row of archive) hashes[Number(row.id)] = rowHash(row);
  tokens.set(token, {
    token,
    expiresAt: Date.now() + 30 * 60 * 1000,
    ids: archive.map((r) => Number(r.id)),
    hashes,
  });
  return {
    write: false,
    archiveCount: archive.length,
    keepCount: keep,
    reanalyzable: archive.length,
    confirmToken: token,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
}

export function commitLegacyAiCleanup(input: { confirmToken: string; confirmed: boolean; backupPath: string }): { archived: number } {
  if (input.confirmed !== true) throw new Error('需要 confirmed=true');
  const rec = tokens.get(input.confirmToken);
  if (!rec || rec.expiresAt < Date.now()) throw new Error('确认令牌无效或已过期');
  const a = Buffer.from(rec.token);
  const b = Buffer.from(input.confirmToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('确认令牌无效');
  backupSqliteThenVerify(db as unknown as Database.Database, input.backupPath);
  const now = new Date().toISOString();
  const tx = (db as unknown as Database.Database).transaction(() => {
    let archived = 0;
    for (const id of rec.ids) {
      const row = getTodo(id) as unknown as Record<string, unknown> | undefined;
      if (!row) throw new Error('行已变化，已停止');
      if (rowHash(row) !== rec.hashes[id]) throw new Error('行已变化，已停止');
      db.prepare(
        `UPDATE todos SET visibility='archived', archived_at=?, archive_reason='legacy_ai_cleanup', updated_at=? WHERE id=?`
      ).run(now, now, id);
      archived += 1;
    }
    productivity.writeMigrationCleanupAudit(archived, 'ok');
    return archived;
  });
  const archived = tx();
  tokens.delete(input.confirmToken);
  return { archived };
}
