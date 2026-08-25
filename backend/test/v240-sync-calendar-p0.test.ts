import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'wb-v240-sync-cal-'));
process.env.WORKBENCH_DATA_DIR = dbDir;
process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
process.env.VITEST = '1';

const { default: db, productivity, updateSettings } = await import('../src/db');
const { commitSync, getConnectorStatuses, getSyncRunPublic, startCommitSync } = await import('../src/services/productivitySync');
const { serverBusyIntervals } = await import('../src/services/agendaService');
const {
  CALENDAR_READER_IDENTITY,
  CALENDAR_READER_PATH,
  CALENDAR_READER_SOURCE,
  CALENDAR_READER_VERSION,
} = await import('../src/connectors/eventKit');
const { PRODUCTIVITY_ERROR_CODES } = await import('../src/connectors/errors');

afterAll(() => rmSync(dbDir, { recursive: true, force: true }));

function thingsRunnerOf(ids: string[]) {
  return async () => ({
    stdout: JSON.stringify({
      ok: true,
      truncated: false,
      lists: {
        today: ids.map((id) => ({ id, title: `Task ${id}`, status: 'open', list: 'today' })),
      },
      logbook: [],
    }),
    stderr: '',
    code: 0,
    timedOut: false,
    truncated: false,
  });
}

function calendarEnvelopeRunner(envelope: Record<string, unknown>) {
  return async () => ({
    stdout: JSON.stringify(envelope),
    stderr: '',
    code: 0,
    timedOut: false,
    truncated: false,
  });
}

describe('P0 同步进程与 Calendar 可读', () => {
  beforeAll(() => {
    updateSettings({
      aiAnalysisEnabled: false,
      thingsEnabled: true,
      feishuEnabled: false,
      desktopEnabled: false,
      calendarEnabled: true,
    });
  });

  it('孤儿 running 记录在重启时标记为 interrupted', () => {
    const id = productivity.startSyncRun('all');
    expect(productivity.getSyncRun(id)?.status).toBe('running');
    const n = productivity.interruptOrphanRunningRuns();
    expect(n).toBeGreaterThanOrEqual(1);
    const row = productivity.getSyncRun(id);
    expect(row?.status).toBe('interrupted');
    expect(row?.error_code).toBe('PROCESS_RESTARTED');
    expect(row?.finished_at).toBeTruthy();
  });

  it('startCommitSync 返回 running，重复点击同一 runId', async () => {
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const thingsRunner = async () => {
      await gate;
      return thingsRunnerOf(['slow-1'])();
    };
    const first = startCommitSync({ thingsRunner, includeAi: false, persistAgenda: false });
    expect(first.status).toBe('running');
    expect(first.runId).toBeGreaterThan(0);
    const second = startCommitSync({ thingsRunner, includeAi: false, persistAgenda: false });
    expect(second.runId).toBe(first.runId);
    const publicRunning = getSyncRunPublic(first.runId);
    expect(publicRunning?.status).toBe('running');
    const done = commitSync({ thingsRunner, includeAi: false, persistAgenda: false });
    released?.();
    const result = await done;
    expect(result.runId).toBe(first.runId);
    expect(result.status === 'ok' || result.status === 'partial').toBe(true);
  });

  it('writeOnly 不得显示可读', async () => {
    const result = await commitSync({
      includeAi: false,
      persistAgenda: true,
      thingsRunner: thingsRunnerOf(['cal-wo-1']),
      calendarRunner: calendarEnvelopeRunner({
        ok: false,
        version: '2',
        permission: 'writeOnly',
        requestedAccess: false,
        truncated: false,
        errorCode: PRODUCTIVITY_ERROR_CODES.CALENDAR_WRITE_ONLY,
        errorMessage: '仅有写入权限',
        events: [],
      }),
    });
    expect(result.receipt).not.toMatch(/Apple 0 场/);
    expect(result.receipt).toContain('Apple Calendar 未同步：需要完整访问权限');
    expect(result.receipt).not.toContain('同步成功');
    const calendar = (await getConnectorStatuses()).find((c) => c.id === 'calendar');
    expect(calendar?.available).toBe(false);
    expect(calendar?.statusLabel).toBe('仅有写入权限');
    expect(calendar?.statusLabel).not.toBe('可读');
    expect(calendar?.permission).toBe('writeOnly');
    expect(calendar).toMatchObject({
      itemsRead: 0,
      roundCount: 0,
      lastSuccessCount: 0,
      lastRoundOk: false,
      usingStaleSnapshot: false,
    });
  });

  it('完整当前窗口的 Calendar DTO 统一本轮与成功计数，窗口陈旧后不伪造成功', async () => {
    const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await commitSync({
      includeAi: false,
      persistAgenda: true,
      thingsRunner: thingsRunnerOf(['cal-ok-1']),
      calendarRunner: calendarEnvelopeRunner({
        ok: true,
        version: '2',
        permission: 'fullAccess',
        requestedAccess: false,
        truncated: false,
        events: [{
          calendarIdentifier: 'cal-status',
          calendarName: '工作',
          eventIdentifier: 'event-status-1',
          occurrenceStartAt: start,
          startAt: start,
          endAt: end,
          title: '状态口径验收',
          allDay: false,
          availability: 'busy',
        }],
      }),
    });
    const current = (await getConnectorStatuses()).find((c) => c.id === 'calendar')!;
    expect(current).toMatchObject({
      available: true,
      itemsRead: 1,
      roundCount: 1,
      lastSuccessCount: 1,
      lastRoundOk: true,
      usingStaleSnapshot: false,
    });

    db.prepare(
      `UPDATE agenda_sync_windows SET stale_after=? WHERE id=(SELECT MAX(id) FROM agenda_sync_windows WHERE provider='apple')`
    ).run(new Date(Date.now() - 60_000).toISOString());
    const stale = (await getConnectorStatuses()).find((c) => c.id === 'calendar')!;
    expect(stale).toMatchObject({
      available: false,
      itemsRead: 0,
      roundCount: 0,
      lastSuccessCount: 1,
      lastRoundOk: false,
      usingStaleSnapshot: true,
    });
  });

  it('VALIDATION_ERROR 会浮到 connectorErrors 与回执', async () => {
    const result = await commitSync({
      includeAi: false,
      persistAgenda: true,
      thingsRunner: thingsRunnerOf(['cal-val-1']),
      calendarRunner: calendarEnvelopeRunner({
        ok: false,
        version: '2',
        permission: 'unknown',
        requestedAccess: false,
        truncated: false,
        errorCode: PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR,
        errorMessage: 'from: invalid ISO8601',
        events: [],
      }),
    });
    expect(result.connectorErrors.some((e) => e.connector === 'calendar' && e.code === PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR)).toBe(true);
    expect(result.receipt).toContain('Apple Calendar 未同步：参数协议错误');
    const calendar = (await getConnectorStatuses()).find((c) => c.id === 'calendar');
    expect(calendar?.available).toBe(false);
    expect(calendar?.statusLabel).toBe('参数协议错误');
  });

  it('Calendar 失败不丢 Things 结果', async () => {
    const result = await commitSync({
      includeAi: false,
      persistAgenda: true,
      thingsRunner: thingsRunnerOf(['keep-things-1', 'keep-things-2']),
      calendarRunner: calendarEnvelopeRunner({
        ok: false,
        version: '2',
        permission: 'denied',
        requestedAccess: false,
        truncated: false,
        errorCode: PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED,
        events: [],
      }),
    });
    const mirrors = productivity.listThingsMirrors().filter((m) => String(m.source_external_id || '').startsWith('keep-things-'));
    expect(mirrors.length).toBe(2);
    expect(result.connectorErrors.some((e) => e.connector === 'calendar')).toBe(true);
    expect(result.receipt).not.toMatch(/Apple 0 场，同步成功/);
  });

  it('busyStatus unknown/blocked 禁止自动排程', () => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 7 * 86400000).toISOString();
    const { busyStatus, coverageError } = serverBusyIntervals(from, to, 'Asia/Shanghai');
    expect(busyStatus).toBe('blocked');
    expect(coverageError).toBeTruthy();
  });

  it.skipIf(process.platform !== 'darwin')('正式 helper --self-test-dates 与 --version，不编译旁路 binary', () => {
    expect(existsSync(CALENDAR_READER_PATH)).toBe(true);
    expect(existsSync(CALENDAR_READER_SOURCE)).toBe(true);
    expect(statSync(CALENDAR_READER_PATH).mtimeMs + 500).toBeGreaterThanOrEqual(statSync(CALENDAR_READER_SOURCE).mtimeMs);
    const dates = spawnSync(CALENDAR_READER_PATH, ['--self-test-dates'], { encoding: 'utf8' });
    expect(dates.status).toBe(0);
    const payload = JSON.parse(dates.stdout || '{}') as { ok?: boolean; version?: string; identity?: string; results?: Array<{ input: string; ok: boolean }> };
    expect(payload.ok).toBe(true);
    expect(payload.version).toBe(CALENDAR_READER_VERSION);
    expect(payload.identity).toBe(CALENDAR_READER_IDENTITY);
    const ms = payload.results?.find((r) => r.input.includes('.000Z'));
    expect(ms?.ok).toBe(true);
    const version = spawnSync(CALENDAR_READER_PATH, ['--version'], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    const env = JSON.parse(version.stdout || '{}') as { version?: string; identity?: string };
    expect(env.version).toBe('2');
    expect(env.identity).toBe(CALENDAR_READER_IDENTITY);
  });
});
