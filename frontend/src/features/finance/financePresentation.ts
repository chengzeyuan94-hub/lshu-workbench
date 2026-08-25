import type {
  FinanceDailyPoint,
  FinanceExpenseCategory,
  FinanceOverview,
  FinancePeriodSummary,
  FinanceStatusResponse,
} from '../../types';

export type FinanceTrendMetric = 'incomeMinor' | 'expenseMinor' | 'netMinor';

export const FINANCE_TREND_LABELS: Record<FinanceTrendMetric, string> = {
  incomeMinor: '收入',
  expenseMinor: '支出',
  netMinor: '结余',
};

export function formatFinanceMoney(minor: number): string {
  if (!Number.isFinite(minor)) return '—';
  const sign = minor < 0 ? '-' : '';
  const yuan = Math.abs(minor) / 100;
  return `${sign}¥${yuan.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatTrendMoney(minor: number): string {
  if (!Number.isFinite(minor)) return '—';
  const sign = minor < 0 ? '-' : '';
  const yuan = Math.abs(minor) / 100;
  if (yuan >= 10_000) return `${sign}¥${(yuan / 10_000).toFixed(yuan >= 100_000 ? 0 : 1)}万`;
  if (yuan >= 1_000) return `${sign}¥${(yuan / 1_000).toFixed(yuan >= 10_000 ? 0 : 1)}k`;
  if (yuan >= 100) return `${sign}¥${Math.round(yuan)}`;
  return `${sign}¥${yuan.toFixed(yuan < 10 ? 1 : 0)}`;
}

export function formatFinanceDate(value?: string | null, withTime = false): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(date);
}

export function formatPeriodRange(period: FinancePeriodSummary): string {
  return `${period.from.replace(/-/g, '.')} — ${period.to.replace(/-/g, '.')}`;
}

export function buildFinanceTrend(
  daily: FinanceDailyPoint[],
  metric: FinanceTrendMetric,
): Array<{ label: string; value: number }> {
  return daily.map((point) => ({
    label: point.date.slice(5).replace('-', '/'),
    value: point[metric],
  }));
}

export function financeTrendMax(data: Array<{ value: number }>): number {
  return Math.max(1, ...data.map((point) => Math.abs(point.value)));
}

export function financeTopFive(categories: FinanceExpenseCategory[]): FinanceExpenseCategory[] {
  return [...categories]
    .sort((left, right) => right.expenseMinor - left.expenseMinor)
    .slice(0, 5);
}

export function financeFreshness(
  overview: FinanceOverview | null,
  status: FinanceStatusResponse | null,
): { tone: 'fresh' | 'stale' | 'syncing' | 'error'; label: string } {
  if (status?.syncing) return { tone: 'syncing', label: '正在更新' };
  if (status?.errorCode || overview?.runtimeStatus.errorCode) {
    return { tone: overview ? 'stale' : 'error', label: overview ? '更新失败 · 保留旧数据' : '读取失败' };
  }
  if (status?.isStale || overview?.runtimeStatus.isStale) return { tone: 'stale', label: '数据已过期' };
  return { tone: 'fresh', label: overview ? '数据可用' : '尚未导入' };
}

export function financeMonthAuxiliary(overview: FinanceOverview): {
  refundIncomeMinor: number;
  netSpendingMinor: number;
  averageDailyExpenseMinor: number;
  largestCategory: string;
} {
  const month = overview.periods.month;
  const days = Math.max(1, overview.currentMonthDaily.length);
  const largestCategory = financeTopFive(overview.currentMonthExpenseTop)[0]?.category ?? '—';
  return {
    refundIncomeMinor: month.refundIncomeMinor,
    netSpendingMinor: month.netSpendingMinor,
    averageDailyExpenseMinor: Math.round(month.expenseMinor / days),
    largestCategory,
  };
}
