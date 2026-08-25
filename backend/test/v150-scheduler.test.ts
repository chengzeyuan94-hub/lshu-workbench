import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSettings, countFetchRunsByTriggerPrefix, runHotspotSync, isSyncing } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  countFetchRunsByTriggerPrefix: vi.fn(),
  runHotspotSync: vi.fn(),
  isSyncing: vi.fn(),
}));

vi.mock('../src/db', () => ({ getSettings, countFetchRunsByTriggerPrefix }));
vi.mock('../src/hotspotSync', () => ({ runHotspotSync, isSyncing }));

import {
  _parseTimes,
  _schedulerTriggerKey,
  _shanghaiWallClock,
  _tick,
} from '../src/scheduler';

describe('V1.5 上海时区热点调度', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T11:00:00.000Z')); // 上海 19:00
    getSettings.mockReset();
    countFetchRunsByTriggerPrefix.mockReset();
    runHotspotSync.mockReset();
    isSyncing.mockReset();
    getSettings.mockReturnValue({ hotspotAutoEnabled: true, hotspotScheduleTimes: ['13:30', '20:30'] });
    countFetchRunsByTriggerPrefix.mockReturnValue(0);
    isSyncing.mockReturnValue(false);
    runHotspotSync.mockResolvedValue({ syncStarted: true, total: 0, sources: [] });
  });

  it('使用 Asia/Shanghai 日期并生成包含日期的持久化防重键', () => {
    expect(_shanghaiWallClock()).toEqual({ dateStr: '2026-08-23', hh: '19', mm: '00' });
    expect(_schedulerTriggerKey('2026-08-23', { h: 13, m: 30 })).toBe('scheduler:2026-08-23:13:30');
  });

  it('启动时只补抓已经错过且当天没有运行记录的档位', async () => {
    _tick();
    await Promise.resolve();
    expect(countFetchRunsByTriggerPrefix).toHaveBeenCalledWith('scheduler:2026-08-23:13:30');
    expect(runHotspotSync).toHaveBeenCalledTimes(1);
    expect(runHotspotSync).toHaveBeenCalledWith('scheduler:2026-08-23:13:30');
  });

  it('已有运行记录、未来档位或关闭自动抓取时不会重复触发', async () => {
    countFetchRunsByTriggerPrefix.mockReturnValue(1);
    _tick();
    await Promise.resolve();
    expect(runHotspotSync).not.toHaveBeenCalled();

    getSettings.mockReturnValue({ hotspotAutoEnabled: false, hotspotScheduleTimes: ['13:30'] });
    _tick();
    expect(runHotspotSync).not.toHaveBeenCalled();
  });

  it('过滤非法时间配置', () => {
    expect(_parseTimes(['13:30', '7:05', '25:00', 'bad'])).toEqual([{ h: 13, m: 30 }, { h: 7, m: 5 }]);
  });
});
