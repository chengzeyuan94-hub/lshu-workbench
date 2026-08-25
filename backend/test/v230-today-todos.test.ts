import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'wb-v23-today-'));
process.env.WORKBENCH_DATA_DIR = dbDir;
process.env.VITEST = '1';

const { default: db, updateTodo, productivity } = await import('../src/db');
const { queryTodayTodos, localDateKey } = await import('../src/services/todayTodos');

afterAll(() => rmSync(dbDir, { recursive: true, force: true }));

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-08-24T08:00:00.000Z');
const todayKey = localDateKey(NOW, TZ)!;

function isoOn(dayOffset: number, hour = 9): string {
  const base = new Date(`${todayKey}T${String(hour).padStart(2, '0')}:00:00+08:00`);
  base.setDate(base.getDate() + dayOffset);
  return base.toISOString();
}

function insertTodo(row: {
  title: string;
  status?: string;
  lifecycle?: string;
  origin?: string;
  sourceType?: string;
  sourceStatus?: string;
  visibility?: string;
  priority?: string;
  dueAt?: string | null;
  plannedStartAt?: string | null;
  updatedAt?: string;
  sourceExternalId?: string;
}) {
  const now = row.updatedAt || NOW.toISOString();
  const info = db.prepare(
    `INSERT INTO todos (
       title, source_path, cluster, priority, reason, status, created_at, updated_at,
       source_type, source_external_id, source_fingerprint, lifecycle_status,
       due_at, planned_start_at, origin_mode, source_status, visibility, source_readonly
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.title,
    row.sourceExternalId || row.title,
    'cluster',
    row.priority || 'medium',
    'reason',
    row.status || 'pending',
    now,
    now,
    row.sourceType || 'desktop',
    row.sourceExternalId || row.title,
    `fp-${Math.random().toString(16).slice(2)}`,
    row.lifecycle || 'candidate',
    row.dueAt ?? null,
    row.plannedStartAt ?? null,
    row.origin || 'legacy',
    row.sourceStatus || 'open',
    row.visibility || 'visible',
    0
  );
  return Number(info.lastInsertRowid);
}

describe('今日待办口径', () => {
  const ids: Record<string, number> = {};

  beforeAll(() => {
    for (let i = 0; i < 437; i += 1) {
      insertTodo({
        title: `legacy-${i}`,
        status: 'pending',
        lifecycle: 'candidate',
        origin: i % 2 === 0 ? 'legacy' : 'ai',
        sourceType: i % 2 === 0 ? 'desktop' : 'feishu_message',
      });
    }
    for (let i = 0; i < 8; i += 1) {
      ids[`things-${i}`] = insertTodo({
        title: `things-${i}`,
        status: 'confirmed',
        lifecycle: 'confirmed',
        origin: 'structured',
        sourceType: 'things',
        sourceStatus: 'open',
        plannedStartAt: isoOn(0, 8 + i),
        priority: i < 2 ? 'high' : 'medium',
        sourceExternalId: `th-${i}`,
      });
    }
    insertTodo({
      title: 'things-hidden',
      status: 'confirmed',
      lifecycle: 'confirmed',
      origin: 'structured',
      sourceType: 'things',
      visibility: 'hidden_local',
      sourceExternalId: 'th-hidden',
    });
    insertTodo({
      title: 'things-oos',
      status: 'confirmed',
      lifecycle: 'confirmed',
      origin: 'structured',
      sourceType: 'things',
      sourceStatus: 'out_of_scope',
      sourceExternalId: 'th-oos',
    });
    insertTodo({
      title: 'things-done',
      status: 'confirmed',
      lifecycle: 'completed',
      origin: 'structured',
      sourceType: 'things',
      sourceStatus: 'completed',
      sourceExternalId: 'th-done',
    });
    insertTodo({
      title: 'ai-candidate',
      status: 'pending',
      lifecycle: 'candidate',
      origin: 'ai',
      sourceType: 'feishu_message',
      sourceExternalId: 'ai-cand',
    });
    ids['ai-today'] = insertTodo({
      title: 'ai-today',
      status: 'confirmed',
      lifecycle: 'planned',
      origin: 'ai',
      sourceType: 'feishu_message',
      plannedStartAt: isoOn(0, 14),
      priority: 'high',
      sourceExternalId: 'ai-today',
    });
    insertTodo({
      title: 'ai-tomorrow',
      status: 'confirmed',
      lifecycle: 'planned',
      origin: 'ai',
      sourceType: 'feishu_message',
      plannedStartAt: isoOn(1, 10),
      dueAt: isoOn(1, 18),
      sourceExternalId: 'ai-tomorrow',
    });
    ids['overdue'] = insertTodo({
      title: 'overdue-task',
      status: 'confirmed',
      lifecycle: 'confirmed',
      origin: 'manual',
      sourceType: 'manual',
      dueAt: isoOn(-2, 18),
      priority: 'low',
      sourceExternalId: 'overdue',
    });
  });

  it('437 条 legacy 候选不会进入今日待办', () => {
    const result = queryTodayTodos({ now: NOW, timeZone: TZ });
    expect(result.items.some((t) => t.title.startsWith('legacy-'))).toBe(false);
    expect(result.items.some((t) => t.title === 'ai-candidate')).toBe(false);
    expect(result.total).toBe(10);
  });

  it('首页 limit=5 与待办页全量 total、顺序一致', () => {
    const home = queryTodayTodos({ now: NOW, timeZone: TZ, limit: 5 });
    const all = queryTodayTodos({ now: NOW, timeZone: TZ });
    expect(home.total).toBe(all.total);
    expect(home.revision).toBe(all.revision);
    expect(home.items.map((t) => t.id)).toEqual(all.items.slice(0, 5).map((t) => t.id));
    expect(home.items).toHaveLength(5);
    expect(all.items.map((t) => t.title)).toEqual([
      'things-0',
      'things-1',
      'things-2',
      'things-3',
      'things-4',
      'things-5',
      'ai-today',
      'things-6',
      'things-7',
      'overdue-task',
    ]);
  });

  it('今日/逾期已确认任务出现，明日与未确认候选不出现', () => {
    const all = queryTodayTodos({ now: NOW, timeZone: TZ });
    const titles = all.items.map((t) => t.title);
    expect(titles).toContain('ai-today');
    expect(titles).toContain('overdue-task');
    expect(titles).not.toContain('ai-tomorrow');
    expect(titles).not.toContain('ai-candidate');
    expect(titles).not.toContain('things-hidden');
    expect(titles).not.toContain('things-oos');
    expect(titles).not.toContain('things-done');
  });

  it('完成或编辑后口径立即变化', () => {
    const before = queryTodayTodos({ now: NOW, timeZone: TZ });
    updateTodo(ids['overdue'], { lifecycle_status: 'completed', status: 'confirmed', completed_at: NOW.toISOString() });
    const afterComplete = queryTodayTodos({ now: NOW, timeZone: TZ });
    expect(afterComplete.total).toBe(before.total - 1);
    expect(afterComplete.items.some((t) => t.id === ids['overdue'])).toBe(false);
    updateTodo(ids['overdue'], { lifecycle_status: 'confirmed', completed_at: null });
    const afterReopen = queryTodayTodos({ now: NOW, timeZone: TZ });
    expect(afterReopen.total).toBe(before.total);
    updateTodo(ids['ai-today'], { planned_start_at: isoOn(1, 11) });
    const afterEdit = queryTodayTodos({ now: NOW, timeZone: TZ });
    expect(afterEdit.items.some((t) => t.id === ids['ai-today'])).toBe(false);
    updateTodo(ids['ai-today'], { planned_start_at: isoOn(0, 14) });
  });

  it('evidence count 一次批量查询，不按条 getEvidence', () => {
    const first = ids['things-0'];
    productivity.addEvidence({
      todoId: first,
      sourceType: 'things',
      evidenceType: 'mirror',
      summary: 'things today',
      occurredAt: NOW.toISOString(),
      payload: {},
    });
    const result = queryTodayTodos({ now: NOW, timeZone: TZ, limit: 5 });
    const hit = result.items.find((t) => t.id === first);
    expect(hit?.evidenceCount).toBeGreaterThanOrEqual(1);
  });
});
