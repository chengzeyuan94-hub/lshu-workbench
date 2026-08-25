import { describe, expect, it } from 'vitest';
import type { FinanceOverview } from '../../types';
import {
  buildFinanceTrend,
  financeFreshness,
  financeMonthAuxiliary,
  financeTopFive,
  financeTrendMax,
  formatFinanceMoney,
  formatPeriodRange,
} from './financePresentation';

const overview = {
  periods: {
    month: {
      from: '2026-08-01',
      to: '2026-08-25',
      incomeMinor: 1273314,
      expenseMinor: 472709,
      netMinor: 800605,
      refundIncomeMinor: 150170,
      netSpendingMinor: 322539,
      incomeCount: 7,
      expenseCount: 127,
      transactionCount: 134,
    },
  },
  currentMonthDaily: [
    { date: '2026-08-01', incomeMinor: 0, expenseMinor: 17312, netMinor: -17312 },
    { date: '2026-08-02', incomeMinor: 200000, expenseMinor: 990, netMinor: 199010 },
  ],
  currentMonthExpenseTop: [
    { category: '交通', expenseMinor: 118487, transactionCount: 26 },
    { category: '软件订阅', expenseMinor: 120354, transactionCount: 17 },
  ],
  runtimeStatus: { status: 'success', lastRunAt: null, nextScheduledAt: null, isStale: false },
} as unknown as FinanceOverview;

describe('financePresentation', () => {
  it('金额始终按整数分格式化且保留负号', () => {
    expect(formatFinanceMoney(1273314)).toBe('¥12,733.14');
    expect(formatFinanceMoney(-28588)).toBe('-¥285.88');
  });

  it('本月结余趋势保留负值，纵轴上限使用绝对值', () => {
    const data = buildFinanceTrend(overview.currentMonthDaily, 'netMinor');
    expect(data).toEqual([
      { label: '08/01', value: -17312 },
      { label: '08/02', value: 199010 },
    ]);
    expect(financeTrendMax(data)).toBe(199010);
  });

  it('分类按真实支出排序并只保留前五项', () => {
    expect(financeTopFive(overview.currentMonthExpenseTop)[0]?.category).toBe('软件订阅');
  });

  it('失败时保留已有数据并明确标记过期', () => {
    const state = financeFreshness(overview, {
      status: 'error',
      syncing: false,
      lastRunAt: null,
      nextScheduledAt: null,
      isStale: true,
      errorCode: 'SOURCE_UNAVAILABLE',
    });
    expect(state).toEqual({ tone: 'stale', label: '更新失败 · 保留旧数据' });
  });

  it('辅助指标全部从真实月度聚合推导', () => {
    expect(financeMonthAuxiliary(overview)).toEqual({
      refundIncomeMinor: 150170,
      netSpendingMinor: 322539,
      averageDailyExpenseMinor: 236355,
      largestCategory: '软件订阅',
    });
    expect(formatPeriodRange(overview.periods.month)).toBe('2026.08.01 — 2026.08.25');
  });
});
