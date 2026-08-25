import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { NotePerformance, XhsPeriod, XhsPeriodView, XhsAccountInfo } from '../types';
import { MetricCard, formatDuration, formatMetricValue, formatNumber } from '../components/widgets';
import NoteDetailDrawer from '../components/NoteDetailDrawer';
import ActionProgress from '../components/ActionProgress';
import LieflatChunkyBars from '../components/charts/LieflatChunkyBars';
import { useActionProgress } from '../lib/actionProgress';

const PERIOD_LABEL: Record<XhsPeriod, string> = {
  seven: '近 7 天',
  thirty: '近 30 天',
};

const SOURCE_LABEL: Record<string, string> = {
  live: '小红书创作中心账户数据',
  stale: '上次真实数据（已过期）',
  demo: '演示数据',
  error: '同步失败',
};

type Tab = 'trend' | 'notes';

// 收藏率计算
function calcCollectRate(n: NotePerformance): number {
  if (n.collectRate !== undefined) return n.collectRate;
  if (n.views > 0) return (n.collects / n.views) * 100;
  return 0;
}

export default function PerformancePage() {
  const [period, setPeriod] = useState<XhsPeriod>('seven');
  const [view, setView] = useState<XhsPeriodView | null>(null);
  const [activeMetric, setActiveMetric] = useState<string>('views');
  const [syncing, setSyncing] = useState(false);
  const syncProgress = useActionProgress();
  const verifyProgress = useActionProgress();
  const [tab, setTab] = useState<Tab>('notes');
  // 笔记表现子状态
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<keyof NotePerformance | 'collectRate'>('views');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // 单篇诊断抽屉
  const [drawerNote, setDrawerNote] = useState<NotePerformance | null>(null);
  // 账号验证状态（V1.2）
  const [account, setAccount] = useState<XhsAccountInfo | null>(null);

  const loadAccount = useCallback(async () => {
    try {
      const a = await api.getAccount();
      setAccount(a);
    } catch {
      setAccount(null);
    }
  }, []);

  const load = useCallback(async (p: XhsPeriod) => {
    try {
      const s = await api.getXhsSnapshot(p);
      setView((s as XhsPeriodView) ?? null);
    } catch {
      setView(null);
    }
  }, []);

  useEffect(() => {
    load(period);
    loadAccount();
  }, [period, load, loadAccount]);

  const metrics = view?.metrics ?? [];
  const notes = view?.notes ?? [];
  const syncedAt = view?.syncedAt ?? '';
  const source = view?.source ?? 'error';
  const periodData = view?.period ?? period;

  // 账户趋势：最近 N 天顺序趋势（不反推标注为真实日期）
  const trendData = useMemo(() => {
    const m = metrics.find((x) => x.key === activeMetric);
    if (!m || m.trend.length === 0) return [];
    const labels = m.trend.map((_, i) => `D-${m.trend.length - i}`);
    return m.trend.map((v, i) => ({ label: labels[i], value: v }));
  }, [metrics, activeMetric]);
  const maxTrend = Math.max(1, ...trendData.map((d) => d.value));

  // 笔记表现：搜索 + 排序
  const sortedNotes = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = notes.filter((n) => !q || n.title.toLowerCase().includes(q));
    const key = sortKey === 'collectRate' ? 'collectRate' : sortKey;
    list = [...list].sort((a, b) => {
      const av = key === 'collectRate' ? calcCollectRate(a) : (a as unknown as Record<string, number>)[key] ?? 0;
      const bv = key === 'collectRate' ? calcCollectRate(b) : (b as unknown as Record<string, number>)[key] ?? 0;
      if (av === bv) return 0;
      return sortDir === 'desc' ? (av < bv ? 1 : -1) : av > bv ? 1 : -1;
    });
    return list;
  }, [notes, search, sortKey, sortDir]);

  // 排行卡片：最佳收藏率 / 最高观看 / 最低观看
  const topCollect = [...notes].sort((a, b) => calcCollectRate(b) - calcCollectRate(a))[0];
  const topViews = [...notes].sort((a, b) => b.views - a.views)[0];
  const lowViews = [...notes].sort((a, b) => a.views - b.views)[0];

  const switchPeriod = (p: XhsPeriod) => setPeriod(p);

  const runSync = async () => {
    setSyncing(true);
    try {
      await syncProgress.run(async () => {
        await api.syncXhs();
        await load(period);
      }, { label: '正在同步小红书数据', successMessage: '同步完成' });
    } catch {
      await load(period);
    } finally {
      setSyncing(false);
    }
  };

  const verifyAccount = async () => {
    try {
      await verifyProgress.run(async () => {
        await api.verifyAndSync();
        await loadAccount();
        await load(period);
      }, { label: '正在验证并同步账号', successMessage: '账号已验证' });
    } catch {
      await loadAccount();
    }
  };

  const handleSort = (key: keyof NotePerformance | 'collectRate') => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortArrow = (key: keyof NotePerformance | 'collectRate') => {
    if (sortKey !== key) return '';
    return sortDir === 'desc' ? ' ↓' : ' ↑';
  };

  const sourceBadgeClass =
    source === 'live' ? 'nb-badge--olive' : source === 'stale' ? 'nb-badge--denim' : source === 'error' ? 'nb-badge--red' : 'nb-badge--blush';

  return (
    <div className="ui-page">
      <div className="ui-page-head">
        <div>
          <div className="ui-page-kicker">C-03 · CONTENT</div>
          <h1 className="nb-section-title" style={{ marginBottom: 0 }}>
            内容表现
            {account && account.verificationStatus === 'verified' && (
              <span className="nb-badge">
                {account.displayName} · 已验证
              </span>
            )}
            {account && account.verificationStatus === 'mismatch' && (
              <span className="nb-badge nb-badge--red">
                账号不匹配
              </span>
            )}
          </h1>
        </div>
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          <button className="nb-btn nb-btn--ghost" onClick={verifyAccount} disabled={verifyProgress.running}>
            {verifyProgress.running ? '验证中…' : '验证并同步账号'}
          </button>
          <button className="nb-btn nb-btn--primary" onClick={runSync} disabled={syncing || syncProgress.running}>
            {syncProgress.running ? '同步中…' : '重新同步'}
          </button>
        </div>
      </div>

      <ActionProgress progress={verifyProgress.progress} onRetry={verifyAccount} />
      <ActionProgress progress={syncProgress.progress} onRetry={runSync} />

      {/* 账号不匹配红色阻断（V1.2） */}
      {account && account.verificationStatus === 'mismatch' && (
        <div className="ui-alert ui-alert--error">
          <h3 style={{ fontSize: 17, marginBottom: 8 }}>小红书账号不匹配</h3>
          <p style={{ fontSize: 14, lineHeight: 1.7 }}>
            当前 OpenCLI 登录的账号是 <strong>「{account.loginDisplayName ?? '未知'}」</strong>，与工作台锁定的有效账号
            <strong>「{account.displayName}」</strong> 不一致。为避免把其他账号的数据误展示为当前账号，内容表现页已停止使用该数据，同步将被拒绝。
          </p>
          <p style={{ fontSize: 13, marginTop: 8 }}>
            请到「设置」页点击「验证并同步」，或把 OpenCLI 登录切换到 <code>{account.displayName}</code> 后重试。
          </p>
        </div>
      )}

      {/* 数据源说明条 */}
      {view ? (
        <div className="ui-receipt">
          <span className={`nb-badge ${sourceBadgeClass}`}>{SOURCE_LABEL[source]}</span>
          <span className="nb-muted" style={{ fontSize: 13 }}>
            {PERIOD_LABEL[periodData]} · 同步于 {syncedAt ? new Date(syncedAt).toLocaleString() : '—'}
          </span>
          {view.message && <span className="nb-muted" style={{ fontSize: 12 }}>{view.message}</span>}
        </div>
      ) : (
        <div className="ui-alert ui-alert--error">
          <span className="nb-badge nb-badge--red">暂无数据</span>
          <span className="nb-muted" style={{ fontSize: 13, marginLeft: 12 }}>
            还没有小红书数据，请先同步。若同步失败，可能是浏览器桥接未连接或登录态失效，请到「设置」页查看修复指引。
          </span>
        </div>
      )}

      {/* 页签切换 */}
      <div className="nb-tabs mb-4">
        <button className={`nb-tab ${tab === 'trend' ? 'nb-tab--active' : ''}`} onClick={() => setTab('trend')}>
          账户趋势
        </button>
        <button className={`nb-tab ${tab === 'notes' ? 'nb-tab--active' : ''}`} onClick={() => setTab('notes')}>
          笔记表现
        </button>
      </div>

      {!view ? (
        <div className="nb-card empty-state">
          <p>请先在「今日」页同步，或点击上方「重新同步」。</p>
        </div>
      ) : tab === 'trend' ? (
        /* ===== 账户趋势 ===== */
        <>
          <div className="grid-auto mb-4">
            {metrics.map((m) => (
              <MetricCard key={m.key} metric={m} />
            ))}
          </div>

          <div className="ui-module mb-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="ui-module-title"><span className="ui-code">T-03</span>趋势</h2>
              <div className="flex gap-2">
                <button className={`nb-chip ${period === 'seven' ? 'nb-chip--active' : ''}`} onClick={() => switchPeriod('seven')}>7 天</button>
                <button className={`nb-chip ${period === 'thirty' ? 'nb-chip--active' : ''}`} onClick={() => switchPeriod('thirty')}>30 天</button>
              </div>
            </div>
            <div className="flex gap-2 mb-3" style={{ flexWrap: 'wrap' }}>
              {metrics.map((m) => (
                <button key={m.key} className={`nb-chip ${activeMetric === m.key ? 'nb-chip--active' : ''}`} onClick={() => setActiveMetric(m.key)}>
                  {m.label}
                </button>
              ))}
            </div>
            <div className="nb-muted" style={{ fontSize: 12, marginBottom: 8 }}>
              最近 {trendData.length} 天顺序趋势 · {activeMetric === 'avg_view_time' ? '单位：分秒' : '单位：次'}
            </div>
            {trendData.length === 0 ? (
              <div className="empty-state"><p>暂无趋势数据。</p></div>
            ) : (
              <div className="trend-scroll">
                <LieflatChunkyBars
                  data={trendData}
                  maxValue={maxTrend}
                  height={220}
                  valueFormatter={activeMetric === 'avg_view_time' ? formatDuration : formatNumber}
                  ariaLabel={`T-03 ${metrics.find((metric) => metric.key === activeMetric)?.label ?? activeMetric}趋势`}
                />
              </div>
            )}
          </div>
        </>
      ) : (
        /* ===== 笔记表现 ===== */
        <>
          {/* 排行卡片 */}
          <div className="grid-auto mb-4">
            {topCollect && (
              <div className="ui-module highlight-card">
                <h3 style={{ fontSize: 16, marginBottom: 8 }}>最佳收藏率</h3>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{topCollect.title}</div>
                <div className="nb-muted" style={{ fontSize: 13, marginTop: 4 }}>
                  收藏率 {calcCollectRate(topCollect).toFixed(1)}% · 观看 {formatMetricValue({ key: 'views', total: topCollect.views, label: '观看', trend: [] })}
                </div>
                <button className="nb-btn nb-btn--ghost" style={{ padding: '6px 12px', fontSize: 13, marginTop: 8 }} onClick={() => setDrawerNote(topCollect)}>诊断这篇 ↗</button>
              </div>
            )}
            {topViews && (
              <div className="ui-module highlight-card">
                <h3 style={{ fontSize: 16, marginBottom: 8 }}>最高观看</h3>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{topViews.title}</div>
                <div className="nb-muted" style={{ fontSize: 13, marginTop: 4 }}>
                  观看 {formatMetricValue({ key: 'views', total: topViews.views, label: '观看', trend: [] })} · 收藏率 {calcCollectRate(topViews).toFixed(1)}%
                </div>
                <button className="nb-btn nb-btn--ghost" style={{ padding: '6px 12px', fontSize: 13, marginTop: 8 }} onClick={() => setDrawerNote(topViews)}>诊断这篇 ↗</button>
              </div>
            )}
            {lowViews && (
              <div className="ui-module ui-alert--warn">
                <h3 style={{ fontSize: 16, marginBottom: 8 }}>需关注</h3>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{lowViews.title}</div>
                <div className="nb-muted" style={{ fontSize: 13, marginTop: 4 }}>
                  观看 {formatMetricValue({ key: 'views', total: lowViews.views, label: '观看', trend: [] })} · 可考虑优化标题或封面
                </div>
                <button className="nb-btn nb-btn--ghost" style={{ padding: '6px 12px', fontSize: 13, marginTop: 8 }} onClick={() => setDrawerNote(lowViews)}>诊断这篇 ↗</button>
              </div>
            )}
          </div>

          {/* 笔记列表：搜索 + 排序 */}
          <div className="ui-module">
            <div className="flex items-center justify-between mb-3" style={{ flexWrap: 'wrap', gap: 12 }}>
              <h2 className="ui-module-title"><span className="ui-code">N-03</span>全部笔记（{notes.length}）</h2>
              <input
                className="nb-input"
                placeholder="搜索笔记标题…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ maxWidth: 280 }}
              />
            </div>

            {/* 排序表头 */}
            <div className="note-table-head">
              <button className="note-th note-th--title" onClick={() => handleSort('title')}>标题{sortArrow('title')}</button>
              <button className="note-th" onClick={() => handleSort('views')}>观看{sortArrow('views')}</button>
              <button className="note-th" onClick={() => handleSort('likes')}>点赞{sortArrow('likes')}</button>
              <button className="note-th" onClick={() => handleSort('collects')}>收藏{sortArrow('collects')}</button>
              <button className="note-th" onClick={() => handleSort('comments')}>评论{sortArrow('comments')}</button>
              <button className="note-th" onClick={() => handleSort('collectRate')}>收藏率{sortArrow('collectRate')}</button>
            </div>

            {sortedNotes.length === 0 ? (
              <div className="empty-state"><p>没有匹配的笔记。</p></div>
            ) : (
              <div className="note-table">
                {sortedNotes.map((n) => (
                  <div key={n.id} className="note-row" onClick={() => setDrawerNote(n)} style={{ cursor: 'pointer' }}>
                    <div className="note-td note-td--title" title={n.title}>{n.title}</div>
                    <div className="note-td">{n.views}</div>
                    <div className="note-td">{n.likes}</div>
                    <div className="note-td">{n.collects}</div>
                    <div className="note-td">{n.comments}</div>
                    <div className="note-td note-td--rate">
                      <span className={calcCollectRate(n) >= 5 ? 'nb-tag-good' : 'nb-muted'}>
                        {calcCollectRate(n).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="nb-muted" style={{ fontSize: 12, marginTop: 10 }}>
              点击任意行，在工作台内打开单篇诊断（不跳转创作中心）。
            </div>
          </div>
        </>
      )}

      {/* 单篇诊断抽屉 */}
      <NoteDetailDrawer noteId={drawerNote?.id ?? null} title={drawerNote?.title} onClose={() => setDrawerNote(null)} />
    </div>
  );
}
