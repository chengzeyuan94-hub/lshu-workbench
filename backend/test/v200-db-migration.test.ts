import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateProductivityV2 } from '../src/productivitySchema';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-v200-mig-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SQLite 幂等迁移与旧待办兼容', () => {
  it('重复 migrate 不报错，旧 pending/confirmed/ignored 映射 lifecycle', () => {
    const db = new Database(join(dir, 'old.db'));
    db.exec(`
      CREATE TABLE todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        source_path TEXT NOT NULL,
        cluster TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium',
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO todos (title, source_path, cluster, priority, reason, status, created_at, updated_at)
       VALUES (?, ?, '簇', 'high', '', ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`
    ).run('旧候选', '/Users/example/Desktop/a.md', 'pending');
    db.prepare(
      `INSERT INTO todos (title, source_path, cluster, priority, reason, status, created_at, updated_at)
       VALUES (?, ?, '热点雷达·文章#1', 'medium', '', ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`
    ).run('热点旧待办', 'https://mp.weixin.qq.com/s/abc', 'confirmed');
    db.prepare(
      `INSERT INTO todos (title, source_path, cluster, priority, reason, status, created_at, updated_at)
       VALUES (?, ?, '簇', 'low', '', ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`
    ).run('已忽略', '/tmp/b.md', 'ignored');

    migrateProductivityV2(db);
    migrateProductivityV2(db);

    const cols = (db.prepare('PRAGMA table_info(todos)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('source_fingerprint');
    expect(cols).toContain('lifecycle_status');
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['todo_source_evidence', 'productivity_sync_runs', 'calendar_mappings', 'connector_checkpoints']));

    const rows = db.prepare('SELECT title, source_type, lifecycle_status, source_fingerprint FROM todos ORDER BY id').all() as Array<{
      title: string;
      source_type: string;
      lifecycle_status: string;
      source_fingerprint: string;
    }>;
    expect(rows[0]).toMatchObject({ source_type: 'desktop', lifecycle_status: 'candidate' });
    expect(rows[1]).toMatchObject({ source_type: 'hotspot', lifecycle_status: 'confirmed' });
    expect(rows[2]).toMatchObject({ source_type: 'desktop', lifecycle_status: 'ignored' });
    expect(rows.every((r) => r.source_fingerprint && r.source_fingerprint.length > 8)).toBe(true);
    db.close();
  });
});
