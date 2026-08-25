import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CreatorNoteDetail, NoteTrafficSource, NoteAudienceSlice } from '../types';
import { formatNumber } from './widgets';
import { IconRefresh, IconStar, IconHeart, IconComment, IconShare, IconEye, IconUserPlus, IconClose } from './icons';
import ActionProgress from './ActionProgress';
import { useActionProgress } from '../lib/actionProgress';

interface Props {
  noteId: string | null;
  title?: string;
  onClose: () => void;
}

const SOURCE_LABEL: Record<string, string> = {
  live: '实时数据',
  stale: '上次真实数据（已过期）',
  error: '获取失败',
};

// 百分比展示，保留 1 位小数
const pct = (n: number | undefined) => (n === undefined ? '—' : `${n.toFixed(1)}%`);
// 时长秒 → 分秒
const dur = (s: number | undefined) => {
  if (s === undefined) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `${m}分${sec}秒` : `${sec}秒`;
};

// 流量来源条形
function TrafficBars({ sources }: { sources: NoteTrafficSource[] }) {
  if (!sources || sources.length === 0) return <div className="nb-muted" style={{ fontSize: 13 }}>暂无流量来源数据。</div>;
  const max = Math.max(...sources.map((s) => s.percent), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {sources.map((s) => (
        <div key={s.name}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
            <span>{s.name}</span>
            <span className="nb-muted">{pct(s.percent)}</span>
          </div>
          <div className="traffic-track">
            <div className="traffic-fill" style={{ width: `${(s.percent / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// 受众切片（性别/年龄/城市/兴趣）
function AudienceSlices({ slices }: { slices: NoteAudienceSlice[] }) {
  if (!slices || slices.length === 0) return <div className="nb-muted" style={{ fontSize: 13 }}>暂无数据。</div>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {slices.map((s) => (
        <div
          key={s.name}
          title={`${s.name}: ${pct(s.percent)}`}
          className="audience-chip"
        >
          <span style={{ fontWeight: 800 }}>{s.name}</span>
          <span className="nb-muted">{pct(s.percent)}</span>
        </div>
      ))}
    </div>
  );
}

// 每日趋势图（SVG 折线/柱状）
function DailyTrend({ data }: { data: Array<{ date: string; value: number }> }) {
  if (!data || data.length === 0) return <div className="nb-muted" style={{ fontSize: 13 }}>暂无趋势数据。</div>;
  const w = 560;
  const h = 180;
  const pad = 24;
  const max = Math.max(...data.map((d) => d.value), 1);
  const step = Math.max(1, Math.floor(data.length / 12));
  const points = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2);
    const y = h - pad - (d.value / max) * (h - pad * 2);
    return { x, y, d };
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto' }}>
      {/* 网格线 */}
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={pad} x2={w - pad} y1={h - pad - f * (h - pad * 2)} y2={h - pad - f * (h - pad * 2)} stroke="var(--ink-soft)" strokeWidth={1} strokeDasharray="4 4" opacity={0.3} />
      ))}
      {/* 面积 */}
      <polygon
        points={`${pad},${h - pad} ${points.map((p) => `${p.x},${p.y}`).join(' ')} ${w - pad},${h - pad}`}
        fill="var(--ui-yellow)"
        opacity={0.35}
      />
      <polyline
        points={points.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="var(--ui-orange)"
        strokeWidth={2}
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
      {/* 点 + 标签 */}
      {points.map((p, i) => (
        <g key={p.d.date}>
          <circle cx={p.x} cy={p.y} r={3.5} fill="var(--ink)" />
          {i % step === 0 && (
            <text x={p.x} y={h - 6} textAnchor="middle" fontSize={10} fill="var(--ink-soft)">
              {p.d.date.slice(5)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

export default function NoteDetailDrawer({ noteId, title, onClose }: Props) {
  const [detail, setDetail] = useState<CreatorNoteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadProgress = useActionProgress();
  const refreshProgress = useActionProgress();

  const load = async (id: string) => {
    setError(null);
    try {
      await loadProgress.run(async () => {
        const d = await api.getNoteDetail(id);
        setDetail(d);
      }, { label: '正在加载笔记详情', successMessage: '详情已加载' });
    } catch (e) {
      setError((e as Error).message);
      setDetail(null);
    }
  };

  useEffect(() => {
    if (noteId) {
      setDetail(null);
      load(noteId);
    }
  }, [noteId]);

  useEffect(() => {
    if (!noteId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [noteId, onClose]);

  const refresh = async () => {
    if (!noteId) return;
    try {
      await refreshProgress.run(async () => {
        const d = await api.refreshNoteDetail(noteId);
        setDetail(d);
      }, { label: '正在刷新笔记详情', successMessage: '详情已刷新' });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 无选中笔记时不渲染抽屉（必须在所有 hooks 之后）
  if (!noteId) return null;

  const d = detail;
  const showRaw = d && d.rawRows && d.rawRows.length > 0;
  const firstTrendKey = d && d.dailyTrends ? Object.keys(d.dailyTrends)[0] : undefined;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-drawer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <div className="min-0">
            <div className="drawer-kicker">C-03 · 单篇诊断</div>
            <div className="drawer-title" id="note-drawer-title" title={title}>{title || '笔记详情'}</div>
          </div>
          <button className="nb-btn nb-btn--ghost drawer-close" aria-label="关闭诊断抽屉" onClick={onClose}>
            <IconClose /> 关闭
          </button>
        </div>

        {/* 数据源条 */}
        <div className="drawer-source">
          {d ? (
            <>
              <span className={`nb-badge ${d.source === 'live' ? 'nb-badge--olive' : d.source === 'stale' ? 'nb-badge--denim' : 'nb-badge--red'}`}>
                {SOURCE_LABEL[d.source]}
              </span>
              <span className="nb-muted" style={{ fontSize: 12 }}>获取于 {d.fetchedAt ? new Date(d.fetchedAt).toLocaleString() : '—'}</span>
              {d.cache === 'stale' && <span className="nb-muted" style={{ fontSize: 12 }}>缓存已过期，建议刷新</span>}
              <button className="nb-btn nb-btn--ghost" style={{ marginLeft: 'auto' }} onClick={refresh} disabled={refreshProgress.running}>
                {refreshProgress.running ? '刷新中…' : <><IconRefresh size={15} /> 刷新</>}
              </button>
            </>
          ) : null}
          {error && <span className="nb-badge nb-badge--red">{error}</span>}
        </div>

        <ActionProgress progress={loadProgress.progress} onRetry={() => noteId && void load(noteId)} />
        <ActionProgress progress={refreshProgress.progress} onRetry={refresh} />

        {loadProgress.running ? (
          <div className="empty-state"><p>正在加载笔记详情…</p></div>
        ) : error ? (
          <div className="empty-state"><p>加载失败：{error}</p><p style={{ fontSize: 12 }}>请检查 OpenCLI 桥接是否已连接。</p></div>
        ) : d ? (
          <div className="drawer-body">
            {/* 标题/发布时间 */}
            {(d.title || d.publishedAt) && (
              <div style={{ marginBottom: 16 }}>
                {d.publishedAt && <div className="nb-muted" style={{ fontSize: 12 }}>发布于 {d.publishedAt}</div>}
              </div>
            )}

            {/* 基础数据 */}
            <div className="drawer-section">
              <h3 className="drawer-section-title">基础数据</h3>
              <div className="drawer-metrics">
                <div className="drawer-metric"><IconEye size={16} /><span className="nb-muted">曝光</span><b>{formatNumber(d.basic.impressions ?? 0)}</b></div>
                <div className="drawer-metric"><IconEye size={16} /><span className="nb-muted">观看</span><b>{formatNumber(d.basic.views ?? 0)}</b></div>
                <div className="drawer-metric"><IconEye size={16} /><span className="nb-muted">封面点击率</span><b>{pct(d.basic.coverClickRate)}</b></div>
                <div className="drawer-metric"><IconEye size={16} /><span className="nb-muted">平均观看时长</span><b>{dur(d.basic.avgViewTimeSeconds)}</b></div>
                <div className="drawer-metric"><IconUserPlus size={16} /><span className="nb-muted">涨粉</span><b>{formatNumber(d.basic.newFollowers ?? 0)}</b></div>
              </div>
            </div>

            {/* 互动数据 */}
            <div className="drawer-section">
              <h3 className="drawer-section-title">互动数据</h3>
              <div className="drawer-metrics">
                <div className="drawer-metric"><IconHeart size={16} /><span className="nb-muted">点赞</span><b>{formatNumber(d.engagement.likes ?? 0)}</b></div>
                <div className="drawer-metric"><IconStar size={16} /><span className="nb-muted">收藏</span><b>{formatNumber(d.engagement.collects ?? 0)}</b></div>
                <div className="drawer-metric"><IconComment size={16} /><span className="nb-muted">评论</span><b>{formatNumber(d.engagement.comments ?? 0)}</b></div>
                <div className="drawer-metric"><IconShare size={16} /><span className="nb-muted">分享</span><b>{formatNumber(d.engagement.shares ?? 0)}</b></div>
              </div>
            </div>

            {/* 每日趋势 */}
            {firstTrendKey && (
              <div className="drawer-section">
                <h3 className="drawer-section-title">每日趋势 · {firstTrendKey}</h3>
                <DailyTrend data={d.dailyTrends[firstTrendKey]} />
              </div>
            )}

            {/* 流量来源 */}
            <div className="drawer-section">
              <h3 className="drawer-section-title">流量来源</h3>
              <TrafficBars sources={d.trafficSources} />
            </div>

            {/* 受众画像 */}
            <div className="drawer-section">
              <h3 className="drawer-section-title">受众画像</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div className="nb-muted" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>性别</div>
                  <AudienceSlices slices={d.audience.gender} />
                </div>
                <div>
                  <div className="nb-muted" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>年龄</div>
                  <AudienceSlices slices={d.audience.ages} />
                </div>
                <div>
                  <div className="nb-muted" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>城市</div>
                  <AudienceSlices slices={d.audience.cities} />
                </div>
                {d.audience.interests && d.audience.interests.length > 0 && (
                  <div>
                    <div className="nb-muted" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>兴趣</div>
                    <AudienceSlices slices={d.audience.interests} />
                  </div>
                )}
              </div>
            </div>

            {/* 原始字段折叠区 */}
            {showRaw && (
              <details className="drawer-raw">
                <summary>查看原始字段（{d.rawRows.length} 项）</summary>
                <div className="drawer-raw-table">
                  {d.rawRows.map((r, i) => (
                    <div key={i} className="drawer-raw-row">
                      <span className="drawer-raw-section">{r.section}</span>
                      <span className="drawer-raw-metric">{r.metric}</span>
                      <span className="drawer-raw-value">{r.value}</span>
                      {r.extra && <span className="drawer-raw-extra">{r.extra}</span>}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
