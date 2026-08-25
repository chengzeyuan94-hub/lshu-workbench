import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', () => ({
  api: {
    getTodayTodos: vi.fn(),
  },
}));

import { api } from '../../api/client';
import {
  getTodayTodosSnapshot,
  invalidateTodayTodos,
  resetTodayTodosStore,
  subscribeTodayTodos,
} from './useTodayTodos';

const getTodayTodos = api.getTodayTodos as unknown as ReturnType<typeof vi.fn>;

function payload(titles: string[], total = titles.length) {
  return {
    items: titles.map((title, i) => ({
      id: i + 1,
      title,
      cluster: 'c',
      priority: 'medium' as const,
      reason: '',
      status: 'confirmed' as const,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    })),
    total,
    asOf: '2026-08-24T00:00:00.000Z',
    revision: 'rev-1',
  };
}

describe('useTodayTodos store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTodayTodosStore();
    getTodayTodos.mockReset();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    resetTodayTodosStore();
    vi.useRealTimers();
  });

  it('首次订阅立即 GET，失败时保留上次成功数据', async () => {
    getTodayTodos.mockResolvedValueOnce(payload(['a', 'b', 'c', 'd', 'e'], 10));
    const unsub = subscribeTodayTodos(5, () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(getTodayTodos).toHaveBeenCalledTimes(1);
    expect(getTodayTodos.mock.calls[0][0]).toBe(5);
    expect(getTodayTodosSnapshot().total).toBe(10);
    expect(getTodayTodosSnapshot().items.map((t) => t.title)).toEqual(['a', 'b', 'c', 'd', 'e']);

    getTodayTodos.mockRejectedValueOnce(new Error('network'));
    invalidateTodayTodos();
    await Promise.resolve();
    await Promise.resolve();
    expect(getTodayTodosSnapshot().items.map((t) => t.title)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(getTodayTodosSnapshot().stale).toBe(true);
    expect(getTodayTodosSnapshot().total).toBe(10);
    unsub();
  });

  it('页面可见时每 5 秒只发 GET，hidden 停止轮询，focus 立即刷新', async () => {
    getTodayTodos.mockResolvedValue(payload(['a'], 1));
    const unsub = subscribeTodayTodos(undefined, () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(getTodayTodos).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(getTodayTodos).toHaveBeenCalledTimes(2);
    expect(getTodayTodos.mock.calls.every((call) => call.length <= 2)).toBe(true);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const hiddenCount = getTodayTodos.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(getTodayTodos).toHaveBeenCalledTimes(hiddenCount);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(getTodayTodos.mock.calls.length).toBeGreaterThan(hiddenCount);

    const beforeFocus = getTodayTodos.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    await Promise.resolve();
    expect(getTodayTodos.mock.calls.length).toBeGreaterThanOrEqual(beforeFocus);
    unsub();
  });

  it('完成/同步后 invalidate 立即刷新，且不去重成空列表', async () => {
    getTodayTodos.mockResolvedValueOnce(payload(['old'], 8));
    const unsub = subscribeTodayTodos(undefined, () => {});
    await Promise.resolve();
    await Promise.resolve();
    getTodayTodos.mockResolvedValueOnce(payload(['new'], 7));
    invalidateTodayTodos();
    await Promise.resolve();
    await Promise.resolve();
    expect(getTodayTodosSnapshot().items[0]?.title).toBe('new');
    expect(getTodayTodosSnapshot().total).toBe(7);
    unsub();
  });
});
