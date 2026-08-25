import { useCallback, useEffect, useMemo, useState } from 'react';
import { Wallet } from 'pixelarticons/react';
import { api } from '../api/client';
import ActionProgress from '../components/ActionProgress';
import LieflatChunkyBars from '../components/charts/LieflatChunkyBars';
import { useActionProgress } from '../lib/actionProgress';
import type {
  FinanceOverview,
  FinancePeriodSummary,
  FinanceStatusResponse,
} from '../types';
import {
  FINANCE_TREND_LABELS,
  buildFinanceTrend,
  financeFreshness,
  financeMonthAuxiliary,
  financeTopFive,
  financeTrendMax,
  formatFinanceDate,
  formatFinanceMoney,
  formatPeriodRange,
  formatTrendMoney,
  type FinanceTrendMetric,
} from '../features/finance/financePresentation';

const PERIOD_CARDS: Array<{
  key: 'week' | 'month' | 'year';
  code: string;
  title: string;
}> = [
  { key: 'week', code: 'W-08', title: '本周收支' },
  { key: 'month', code: 'M-08', title: '本月收支' },
  { key: 'year', code: 'Y-08', title: '本年度收支' },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '财务数据读取失败';
}

function PeriodCard({ code, title, period }: { code: string; title: string; period: FinancePeriodSummary }) {
  return (
    <section className="ui-module finance-period-card" aria-label={title}>
      <div className="ui-module-head">
        <h2 className="ui-module-title"><span className="ui-code">{code}</span>{title}</h2>
        <span className="finance-period-count">{period.transactionCount} 笔</span>
      </div>
      <div className="finance-period-net">
        <span className="finance-period-label"><i aria-hidden="true" />结余</span>
        <strong>{formatFinanceMoney(period.netMinor)}</strong>
      </div>
      <div className="finance-period-flows">
        <div className="finance-flow finance-flow--income">
          <span>收入</span>
          <strong>{formatFinanceMoney(period.incomeMinor)}</strong>
          <small>{period.incomeCount} 笔</small>
        </div>
        <div className="finance-flow finance-flow--expense">
          <span>支出</span>
          <strong>{formatFinanceMoney(period.expenseMinor)}</strong>
          <small>{period.expenseCount} 笔</small>
        </div>
      </div>
      <div className="finance-period-range">
        <span>统计区间</span>
        <strong>{formatPeriodRange(period)}</strong>
      </div>
    </section>
  );
}

export default function FinancePage() {
  const [overview, setOverview] = useState<FinanceOverview | null>(null);
  const [status, setStatus] = useState<FinanceStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [trendMetric, setTrendMetric] = useState<FinanceTrendMetric>('expenseMinor');
  const syncProgress = useActionProgress(1600);

  const loadFinance = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const [overviewResult, statusResult] = await Promise.allSettled([
      api.getFinanceOverview(),
      api.getFinanceStatus(),
    ]);

    if (overviewResult.status === 'fulfilled') {
      setOverview(overviewResult.value);
      setLoadError(null);
    } else {
      setLoadError(errorMessage(overviewResult.reason));
    }

    if (statusResult.status === 'fulfilled') setStatus(statusResult.value);
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => {
    void loadFinance();
  }, [loadFinance]);

  useEffect(() => {
    if (!status?.syncing) return undefined;
    const timer = window.setInterval(() => {
      void loadFinance(true);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [loadFinance, status?.syncing]);

  const syncLedger = useCallback(async () => {
    try {
      const result = await syncProgress.run(api.syncFinance, {
        label: '检查备份 → 建立快照 → 校验 → 汇总 → 完成',
        successMessage: '本地账本已更新',
      });
      setOverview(result.overview);
      setLoadError(null);
      const nextStatus = await api.getFinanceStatus().catch(() => null);
      if (nextStatus) setStatus(nextStatus);
    } catch (error) {
      setLoadError(errorMessage(error));
      const nextStatus = await api.getFinanceStatus().catch(() => null);
      if (nextStatus) setStatus(nextStatus);
    }
  }, [syncProgress]);

  const trendData = useMemo(
    () => buildFinanceTrend(overview?.currentMonthDaily ?? [], trendMetric),
    [overview?.currentMonthDaily, trendMetric],
  );
  const trendMax = useMemo(() => financeTrendMax(trendData), [trendData]);
  const expenseTop = useMemo(
    () => financeTopFive(overview?.currentMonthExpenseTop ?? []),
    [overview?.currentMonthExpenseTop],
  );
  const freshness = financeFreshness(overview, status);
  const syncing = syncProgress.running || Boolean(status?.syncing);
  const lastRunAt = status?.lastRunAt ?? overview?.runtimeStatus.lastRunAt ?? overview?.generatedAt;
  const nextScheduledAt = status?.nextScheduledAt ?? overview?.runtimeStatus.nextScheduledAt;
  const auxiliary = overview ? financeMonthAuxiliary(overview) : null;
  const maxCategoryExpense = Math.max(1, ...expenseTop.map((item) => item.expenseMinor));

  return (
    <div className="ui-page finance-page">
      <div className="ui-page-head">
        <div>
          <div className="ui-page-kicker">F-08 · MONEY LEDGER</div>
          <h1 className="finance-page-title">财务分析</h1>
        </div>
        <button
          type="button"
          className="nb-btn nb-btn--primary"
          disabled={syncing}
          onClick={() => void syncLedger()}
        >
          {syncing ? '正在更新…' : '更新账本'}
        </button>
      </div>

      <section className={`finance-source-strip finance-source-strip--${freshness.tone}`} aria-live="polite">
        <div className="finance-source-icon" aria-hidden="true"><Wallet width={24} height={24} /></div>
        <div className="finance-source-main">
          <strong>{overview?.source.label ?? 'MoneyCats 本地备份'}</strong>
          <span className="finance-source-state">{freshness.label}</span>
        </div>
        <dl className="finance-source-meta">
          <div><dt>数据截至</dt><dd>{overview?.asOf ?? '—'}</dd></div>
          <div><dt>最近更新</dt><dd>{formatFinanceDate(lastRunAt, true)}</dd></div>
          <div><dt>下次更新</dt><dd>{formatFinanceDate(nextScheduledAt, true)}</dd></div>
          <div><dt>有效流水</dt><dd>{overview ? `${overview.source.includedRows.toLocaleString('zh-CN')} 笔` : '—'}</dd></div>
        </dl>
      </section>

      <ActionProgress progress={syncProgress.progress} onRetry={() => void syncLedger()} />

      {loadError && overview ? (
        <div className="ui-alert ui-alert--warn finance-stale-alert" role="status">
          本次更新失败，继续显示 {overview.asOf} 的上次成功数据。{loadError}
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="ui-module finance-loading" role="status">正在读取本地账本…</div>
      ) : !overview ? (
        <div className="ui-module finance-empty">
          <Wallet width={48} height={48} aria-hidden="true" />
          <h2>尚未导入 MoneyCats 账本</h2>
          <p>{loadError ?? '请确认本地备份存在，然后执行一次只读解析。'}</p>
          <button type="button" className="nb-btn nb-btn--primary" disabled={syncing} onClick={() => void syncLedger()}>
            {syncing ? '正在更新…' : '更新账本'}
          </button>
        </div>
      ) : (
        <>
          <div className="finance-period-grid">
            {PERIOD_CARDS.map((card) => (
              <PeriodCard
                key={card.key}
                code={card.code}
                title={card.title}
                period={overview.periods[card.key]}
              />
            ))}
          </div>

          <div className="finance-analysis-grid">
            <section className="ui-module finance-trend-module">
              <div className="ui-module-head">
                <h2 className="ui-module-title"><span className="ui-code">T-08</span>本月每日趋势</h2>
                <span className="finance-module-meta">截至 {overview.asOf}</span>
              </div>
              <div className="ui-tabs finance-trend-tabs" aria-label="趋势指标">
                {(Object.keys(FINANCE_TREND_LABELS) as FinanceTrendMetric[]).map((metric) => (
                  <button
                    key={metric}
                    type="button"
                    className={`ui-tab ${trendMetric === metric ? 'ui-tab--active' : ''}`}
                    aria-pressed={trendMetric === metric}
                    onClick={() => setTrendMetric(metric)}
                  >
                    {FINANCE_TREND_LABELS[metric]}
                  </button>
                ))}
              </div>
              {trendData.length === 0 ? (
                <div className="empty-state"><p>本月暂无可展示的每日收支。</p></div>
              ) : (
                <div className="trend-scroll finance-trend-scroll">
                  <LieflatChunkyBars
                    data={trendData}
                    maxValue={trendMax}
                    height={286}
                    valueFormatter={formatTrendMoney}
                    ariaLabel={`本月每日${FINANCE_TREND_LABELS[trendMetric]}趋势`}
                    signed={trendMetric === 'netMinor'}
                  />
                </div>
              )}
            </section>

            <section className="ui-module finance-category-module">
              <div className="ui-module-head">
                <h2 className="ui-module-title"><span className="ui-code">C-08</span>本月支出分类 Top 5</h2>
                <span className="finance-module-meta">{overview.periods.month.expenseCount} 笔支出</span>
              </div>
              {expenseTop.length === 0 ? (
                <div className="empty-state"><p>本月暂无支出分类。</p></div>
              ) : (
                <ol className="finance-category-list" data-chart-template="F5-tick-rows">
                  {expenseTop.map((item, index) => (
                    <li key={`${item.category}-${index}`}>
                      <div className="finance-category-copy">
                        <span className="finance-category-rank">{String(index + 1).padStart(2, '0')}</span>
                        <strong title={item.category}>{item.category}</strong>
                        <span>{item.transactionCount} 笔</span>
                        <b>{formatFinanceMoney(item.expenseMinor)}</b>
                      </div>
                      <div className="finance-category-track" aria-hidden="true">
                        {Array.from({ length: 20 }, (_, tick) => (
                          <i
                            key={tick}
                            className={tick < Math.max(1, Math.ceil((item.expenseMinor / maxCategoryExpense) * 20)) ? 'is-active' : ''}
                          />
                        ))}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {auxiliary ? (
                <dl className="finance-aux-grid">
                  <div><dt>退款到账</dt><dd>{formatFinanceMoney(auxiliary.refundIncomeMinor)}</dd></div>
                  <div><dt>净消费</dt><dd>{formatFinanceMoney(auxiliary.netSpendingMinor)}</dd></div>
                  <div><dt>日均支出</dt><dd>{formatFinanceMoney(auxiliary.averageDailyExpenseMinor)}</dd></div>
                  <div><dt>最大分类</dt><dd title={auxiliary.largestCategory}>{auxiliary.largestCategory}</dd></div>
                </dl>
              ) : null}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
