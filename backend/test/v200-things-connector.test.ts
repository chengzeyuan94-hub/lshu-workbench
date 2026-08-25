import { describe, expect, it } from 'vitest';
import {
  classifyThingsFailure,
  mapThingsStatus,
  parseThingsJson,
  toThingsItems,
  toThingsItemsCompat,
  readThings,
} from '../src/connectors/things';
import { PRODUCTIVITY_ERROR_CODES } from '../src/connectors/errors';

const sample = {
  ok: true,
  lists: {
    inbox: [{ id: 'a1', title: 'Inbox task', status: 'open', list: 'inbox', notes: 'n' }],
    today: [{ id: 'a2', title: 'Today task', status: 'open', list: 'today', project: '丝路' }],
    upcoming: [{ id: 'a3', title: 'Later', status: 'open', list: 'upcoming', dueAt: '2026-08-26T00:00:00.000Z' }],
  },
  logbook: [
    { id: 'a2', title: 'dup', status: 'completed', list: 'logbook', completedAt: '2026-08-24T00:00:00.000Z' },
    { id: 'c1', title: 'Done', status: 'completed', list: 'logbook', completedAt: '2026-08-24T00:00:00.000Z' },
    { id: 'x1', title: 'Nope', status: 'canceled', list: 'logbook' },
  ],
};

describe('Things JSON 解析与状态映射', () => {
  it('解析严格 JSON 并映射 open/completed/canceled', () => {
    const parsed = parseThingsJson(JSON.stringify(sample));
    const items = toThingsItemsCompat(parsed);
    expect(items.find((i) => i.sourceExternalId === 'a2')?.status).toBe('completed');
    expect(items.find((i) => i.sourceExternalId === 'c1')?.status).toBe('completed');
    expect(items.find((i) => i.sourceExternalId === 'x1')?.status).toBe('canceled');
    expect(items.filter((i) => i.sourceExternalId === 'a2')).toHaveLength(1);
    expect(mapThingsStatus('completed')).toBe('completed');
    expect(mapThingsStatus('canceled')).toBe('canceled');
  });

  it('今日列表 1:1，不含收件箱/日志簿', () => {
    const items = toThingsItems({
      ok: true,
      lists: {
        today: [
          { id: 't1', title: 'Today A', status: 'open', list: 'today', project: 'P' },
          { id: 't2', title: 'Today B', status: 'open', list: 'today' },
        ],
      },
    });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.payload.list === 'today')).toBe(true);
    expect(items.map((i) => i.sourceExternalId).sort()).toEqual(['t1', 't2']);
  });

  it('解析失败返回结构化错误，不暴露原始异常', () => {
    expect(() => parseThingsJson('not-json <<< AppleScript error -1743')).toThrowError(/解析失败/);
    try {
      parseThingsJson('');
    } catch (e) {
      expect(String(e)).not.toContain('AppleScript');
    }
  });

  it('超时与权限拒绝映射错误码', () => {
    expect(classifyThingsFailure('', true).code).toBe(PRODUCTIVITY_ERROR_CODES.THINGS_UNAVAILABLE);
    expect(classifyThingsFailure('oserror -1743 not authorized', false).code).toBe(PRODUCTIVITY_ERROR_CODES.THINGS_PERMISSION_DENIED);
  });

  it('runner 超时不会调用真实 Things', async () => {
    const result = await readThings({
      runner: async () => ({ stdout: '', stderr: 'timeout', code: null, timedOut: true, truncated: false }),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(PRODUCTIVITY_ERROR_CODES.THINGS_UNAVAILABLE);
    expect(result.items).toEqual([]);
  });
});
