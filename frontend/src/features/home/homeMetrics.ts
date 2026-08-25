import type { CreatorMetric } from '../../types';

export const HOME_CORE_METRIC_KEYS = ['views', 'likes', 'collects', 'new_followers'] as const;

export type HomeCoreMetricKey = (typeof HOME_CORE_METRIC_KEYS)[number];

export const HOME_CORE_METRIC_LABELS: Record<HomeCoreMetricKey, string> = {
  views: '观看数',
  likes: '点赞数',
  collects: '收藏数',
  new_followers: '涨粉数',
};

export const HOME_NOTES_LIMIT = 5;

export interface HomeCoreMetricSlot {
  key: HomeCoreMetricKey;
  label: string;
  metric: CreatorMetric | null;
  missing: boolean;
}

export function isHomeCoreMetricKey(key: string): key is HomeCoreMetricKey {
  return (HOME_CORE_METRIC_KEYS as readonly string[]).includes(key);
}

export function selectHomeCoreMetrics(metrics: CreatorMetric[]): HomeCoreMetricSlot[] {
  const byKey = new Map(metrics.map((metric) => [metric.key, metric]));
  return HOME_CORE_METRIC_KEYS.map((key) => {
    const metric = byKey.get(key) ?? null;
    return {
      key,
      label: HOME_CORE_METRIC_LABELS[key],
      metric,
      missing: !metric,
    };
  });
}

export function resolveHomeTrendMetric(activeMetric: string): HomeCoreMetricKey {
  return isHomeCoreMetricKey(activeMetric) ? activeMetric : 'views';
}

/** @deprecated 首页已改为四项核心指标；保留别名避免旧测试引用丢失 */
export function filterHomeMetrics(metrics: CreatorMetric[]): CreatorMetric[] {
  return selectHomeCoreMetrics(metrics)
    .filter((slot) => !slot.missing && slot.metric)
    .map((slot) => slot.metric as CreatorMetric);
}
