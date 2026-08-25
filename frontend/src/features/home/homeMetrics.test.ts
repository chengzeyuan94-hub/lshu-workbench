import { describe, expect, it } from 'vitest';
import {
  HOME_CORE_METRIC_KEYS,
  filterHomeMetrics,
  resolveHomeTrendMetric,
  selectHomeCoreMetrics,
} from './homeMetrics';
import type { CreatorMetric } from '../../types';

function metric(key: string, label = key): CreatorMetric {
  return { key, label, total: 1, trend: [1, 2] };
}

describe('selectHomeCoreMetrics', () => {
  it('按固定顺序只保留四项核心指标，忽略接口返回顺序', () => {
    const input = [
      'comments',
      'new_followers',
      'shares',
      'likes',
      'avg_view_time',
      'home_views',
      'collects',
      'views',
      'danmaku',
    ].map(metric);
    expect(selectHomeCoreMetrics(input).map((slot) => slot.key)).toEqual([...HOME_CORE_METRIC_KEYS]);
    expect(selectHomeCoreMetrics(input).every((slot) => !slot.missing)).toBe(true);
  });

  it('缺失项显示占位，不伪造 0', () => {
    const slots = selectHomeCoreMetrics([metric('likes', '点赞')]);
    expect(slots).toHaveLength(4);
    expect(slots[0]).toMatchObject({ key: 'views', missing: true, metric: null, label: '观看数' });
    expect(slots[1]).toMatchObject({ key: 'likes', missing: false });
    expect(slots[1].metric?.total).toBe(1);
    expect(slots[2].missing).toBe(true);
    expect(slots[3].missing).toBe(true);
  });

  it('不在核心四项内的指标不会进入首页', () => {
    const home = filterHomeMetrics([
      metric('avg_view_time'),
      metric('home_views'),
      metric('comments'),
      metric('shares'),
      metric('danmaku'),
      metric('views'),
    ]);
    expect(home.map((m) => m.key)).toEqual(['views']);
  });
});

describe('resolveHomeTrendMetric', () => {
  it('默认与合法值使用观看数/自身，非法值回退 views', () => {
    expect(resolveHomeTrendMetric('views')).toBe('views');
    expect(resolveHomeTrendMetric('likes')).toBe('likes');
    expect(resolveHomeTrendMetric('avg_view_time')).toBe('views');
    expect(resolveHomeTrendMetric('danmaku')).toBe('views');
  });
});
