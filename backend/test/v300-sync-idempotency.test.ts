import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'wb-v300-sync-'));
process.env.WORKBENCH_DATA_DIR = dbDir;
process.env.DEEPSEEK_API_KEY = 'test-key-not-real';

const { productivity, updateSettings } = await import('../src/db');
const { previewSync, commitSync } = await import('../src/services/productivitySync');
const { fingerprintSource } = await import('../src/services/hash');

afterAll(() => rmSync(dbDir, { recursive: true, force: true }));

const thingsRunner = async () => ({
  stdout: JSON.stringify({
    ok: true,
    truncated: false,
    lists: {
      today: [
        { id: 'th-a', title: 'Today A', status: 'open', list: 'today', project: 'P1' },
        { id: 'th-b', title: 'Today B', status: 'open', list: 'today', project: 'P1' },
        { id: 'th-c', title: 'Today C', status: 'open', list: 'today' },
      ],
    },
    logbook: [],
  }),
  stderr: '',
  code: 0,
  timedOut: false,
  truncated: false,
});

describe('幂等与同步', () => {
  beforeAll(() => {
    updateSettings({ aiAnalysisEnabled: false, thingsEnabled: true, feishuEnabled: false, desktopEnabled: false, calendarEnabled: false });
  });

  it('同一项目两个无 due Things 保持两条', async () => {
    const r = await commitSync({ thingsRunner, includeAi: false, persistAgenda: false });
    expect(r.created).toBeGreaterThanOrEqual(2);
    const mirrors = productivity.listThingsMirrors();
    expect(mirrors.filter((m) => m.source_external_id === 'th-a' || m.source_external_id === 'th-b')).toHaveLength(2);
  });

  it('preview 零写入', async () => {
    const before = productivity.snapshotCounts();
    await previewSync({ thingsRunner, persistAgenda: false });
    expect(productivity.snapshotCounts()).toEqual(before);
  });

  it('连续同步第二次不新增 Things 镜像', async () => {
    const before = productivity.snapshotCounts();
    await commitSync({ thingsRunner, includeAi: false, persistAgenda: false });
    expect(productivity.snapshotCounts().todos).toBe(before.todos);
  });

  it('Things due 清空会覆盖', async () => {
    await commitSync({
      includeAi: false,
      persistAgenda: false,
      thingsRunner: async () => ({
        stdout: JSON.stringify({
          ok: true,
          lists: { today: [{ id: 'th-a', title: 'Inbox A renamed', status: 'open', list: 'today', dueAt: null, project: 'P2' }] },
          logbook: [],
        }),
        stderr: '',
        code: 0,
        timedOut: false,
        truncated: false,
      }),
    });
    const row = productivity.findByExternal('things', 'th-a') as { title: string; due_at: string | null; cluster: string };
    expect(row.title).toBe('Inbox A renamed');
    expect(row.due_at).toBeNull();
    expect(row.cluster).toBe('P2');
  });

  it('completed/canceled 精确同步', async () => {
    await commitSync({
      includeAi: false,
      persistAgenda: false,
      thingsRunner: async () => ({
        stdout: JSON.stringify({
          ok: true,
          lists: {
            today: [
              { id: 'th-b', title: 'Today B', status: 'completed', list: 'today' },
              { id: 'th-c', title: 'Today C', status: 'canceled', list: 'today' },
            ],
          },
          logbook: [],
        }),
        stderr: '',
        code: 0,
        timedOut: false,
        truncated: false,
      }),
    });
    const b = productivity.findByExternal('things', 'th-b') as { lifecycle_status: string; source_status: string };
    const c = productivity.findByExternal('things', 'th-c') as { lifecycle_status: string; visibility: string };
    expect(b.source_status).toBe('completed');
    expect(b.lifecycle_status).toBe('completed');
    expect(c.lifecycle_status).toBe('canceled');
    expect(c.visibility).toBe('archived');
  });

  it('不完整快照不累加 missing', async () => {
    const before = productivity.findByExternal('things', 'th-a') as { consecutive_missing_count: number };
    await commitSync({
      includeAi: false,
      persistAgenda: false,
      thingsRunner: async () => ({ stdout: '', stderr: 'timeout', code: null, timedOut: true, truncated: false }),
    });
    const after = productivity.findByExternal('things', 'th-a') as { consecutive_missing_count: number; source_freshness: string };
    expect(after.consecutive_missing_count).toBe(before.consecutive_missing_count);
  });
});

describe('980 合成消息不会生成 980 条待办', () => {
  it('AI 关闭时全部 deferred', async () => {
    updateSettings({ aiAnalysisEnabled: false, feishuEnabled: false, thingsEnabled: false, desktopEnabled: false });
    const items = Array.from({ length: 980 }, (_, i) => ({
      sourceType: 'feishu_message' as const,
      sourceExternalId: `syn-${i}`,
      sourceFingerprint: fingerprintSource('feishu_message', `syn-${i}`),
      title: i % 50 === 0 ? '请准备材料' : '收到谢谢',
      summary: i % 50 === 0 ? '请准备材料' : '收到谢谢',
      status: 'open' as const,
      payload: { chat_hash: 'syn' },
    }));
    const { analyzeUnstructuredSources } = await import('../src/services/actionIntentAnalyzer');
    const before = productivity.snapshotCounts().todos;
    const stats = await analyzeUnstructuredSources(items.slice(0, 20));
    expect(stats.waitingForAi).toBe(true);
    expect(productivity.snapshotCounts().todos - before).toBe(0);
  });
});
