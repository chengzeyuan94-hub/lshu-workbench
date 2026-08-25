import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { XhsPeriod, XhsPeriodView } from '../types';
import { formatNumber } from '../components/widgets';
import { IconScanBtn, IconRefresh } from '../components/icons';
import ActionProgress from '../components/ActionProgress';
import { useActionProgress } from '../lib/actionProgress';
import { useTodayTodos, invalidateTodayTodos } from '../features/todos/useTodayTodos';
import { HOME_TODAY_LIMIT } from '../features/todos/todoSelectors';
import {
  resolveHomeTrendMetric,
  selectHomeCoreMetrics,
  type HomeCoreMetricKey,
} from '../features/home/homeMetrics';
import { HomeContextRow, HomeInsightRow, HomeWorkRow } from '../features/home/HomeDashboard';

const SOURCE_LABEL: Record<string, string> = {
  live: '实时',
  stale: '已过期',
  demo: '演示数据',
  error: '同步失败',
};

function buildDateLabels(count: number, syncedAt: string): string[] {
  const base = new Date(syncedAt);
  const labels: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
  }
  return labels;
}

export default function HomePage() {
  const [view, setView] = useState<XhsPeriodView | null>(null);
  const today = useTodayTodos(HOME_TODAY_LIMIT);
  const scanProgress = useActionProgress();
  const syncProgress = useActionProgress();
  const [period, setPeriod] = useState<XhsPeriod>('seven');
  const [activeMetric, setActiveMetric] = useState<string>('views');

  const load = useCallback(async (p: XhsPeriod) => {
    try {
      const s = await api.getXhsSnapshot(p);
      setView((s as XhsPeriodView) ?? null);
    } catch {
      setView(null);
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [period, load]);

  const runSync = async () => {
    try {
      await syncProgress.run(async () => {
        await api.syncXhs();
        await load(period);
      }, { label: '正在同步小红书数据', successMessage: '同步完成' });
    } catch {
      await load(period);
    }
  };

  const runScan = async () => {
    try {
      await scanProgress.run(async () => {
        await api.scanDesktop();
        invalidateTodayTodos();
      }, { label: '正在扫描桌面', successMessage: '扫描完成' });
    } catch {
      /* error surfaced by ActionProgress */
    }
  };

  const slots = selectHomeCoreMetrics(view?.metrics ?? []);
  const notes = view?.notes ?? [];
  const syncedAt = view?.syncedAt ?? '';
  const source = view?.source ?? 'error';
  const trendMetricKey = resolveHomeTrendMetric(activeMetric);
  const trendMetric: { trend: number[] } | null = useMemo(() => {
    const slot = slots.find((item) => item.key === trendMetricKey);
    return slot?.metric ?? null;
  }, [slots, trendMetricKey]);
  const trendData = (() => {
    if (!trendMetric) return [];
    const labels = buildDateLabels(trendMetric.trend.length, syncedAt);
    return trendMetric.trend.map((v, i) => ({ label: labels[i], value: v }));
  })();
  const maxTrend = Math.max(1, ...trendData.map((d) => d.value));

  return (
    <div className="ui-page">
      <div className="ui-status-head">
        <div className="ui-status-copy">
          <div className="ui-page-kicker">H-01 · TODAY</div>
          <h1>今日状态</h1>
          <p className="nb-muted" style={{ marginTop: 8, fontSize: 15 }}>
            {view
              ? `账号「${view.profile?.name ?? '—'}」 · 关注 ${formatNumber(view.profile?.followers ?? 0)}`
              : '同步小红书数据并扫描桌面，确认今天要推进的工作。'}
          </p>
        </div>
        <div className="ui-status-actions">
          <button className="nb-btn nb-btn--primary" onClick={runScan} disabled={scanProgress.running}>
            <IconScanBtn /> {scanProgress.running ? '扫描中…' : '扫描桌面'}
          </button>
          <button className="nb-btn nb-btn--ghost" onClick={runSync} disabled={syncProgress.running}>
            <IconRefresh /> {syncProgress.running ? '同步中…' : '同步小红书数据'}
          </button>
        </div>
      </div>

      <ActionProgress progress={scanProgress.progress} onRetry={runScan} />
      <ActionProgress progress={syncProgress.progress} onRetry={runSync} />

      {(syncProgress.progress.state === 'error' || scanProgress.progress.state === 'error') && (
        <div className="ui-alert ui-alert--error">
          <strong>同步或扫描失败：</strong> {syncProgress.progress.state === 'error' ? syncProgress.progress.errorMessage : scanProgress.progress.errorMessage}
          <div className="nb-muted" style={{ fontSize: 13, marginTop: 8 }}>
            如果同步小红书失败，可能是浏览器桥接未连接或登录态失效。你可以到「设置」页查看修复指引。
          </div>
        </div>
      )}

      <div className="home-dashboard">
        <HomeContextRow />
        <HomeInsightRow
          sourceLabel={SOURCE_LABEL[source] ?? '未同步'}
          source={source}
          period={period}
          onPeriod={setPeriod}
          slots={slots}
          trendMetricKey={trendMetricKey}
          onTrendMetric={(key: HomeCoreMetricKey) => setActiveMetric(key)}
          trendData={trendData}
          maxTrend={maxTrend}
        />
        <HomeWorkRow
          notes={notes}
          todos={today.items}
          todoTotal={today.total}
          todoStale={today.stale}
        />
      </div>
    </div>
  );
}
