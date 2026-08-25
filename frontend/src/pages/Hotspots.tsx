import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api } from '../api/client';
import type {
  HotspotStatus,
  HotspotArticleListItem,
  HotspotArticleDetail,
  KnowledgeHotspotArticle,
  KnowledgeGenerateResult,
  KnowledgeMomentDraft,
  KnowledgeMomentGenerationMode,
} from '../types';
import ActionProgress from '../components/ActionProgress';
import BatchMomentDrawer from '../components/BatchMomentDrawer';
import HistoryMomentGrid from '../components/HistoryMomentGrid';
import { useActionProgress } from '../lib/actionProgress';
import {
  MAX_BATCH_DRAFTS,
  runHotspotDraftBatch,
  type BatchDraftItem,
  type BatchDraftTopic,
} from '../features/hotspots/batchDrafts';

function formatTime(t: string | null): string {
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return d.toLocaleString();
}

function formatCost(c: number): string {
  return `¥${c.toFixed(3)}`;
}

// 判断素材是否为"今天"抓取（避免把历史校准素材标成今日热点）
function isToday(t: string | null): boolean {
  if (!t) return false;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// 毫秒时间戳 → 日期
function formatMs(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

// A-H 评分映射
const SCORE_KEYS: Array<[string, string]> = [
  ['A', '粉丝相关'],
  ['B', '判断空间'],
  ['C', '可行动'],
  ['D', '商业连接'],
  ['E', '证据密度'],
  ['F', '时效势能'],
  ['G', '故事共鸣'],
  ['H', '复用价值'],
];

type Tab = 'live' | 'curated' | 'history';
const TAB_ORDER: Tab[] = ['live', 'curated', 'history'];

function createGenerationRequestId(mode: KnowledgeMomentGenerationMode): string {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `moment-${mode}-${randomId}`;
}

// ===== L叔精选单篇详情元素 =====
interface CuratedArticle {
  article_id: string;
  title: string;
  url: string;
  published_at_ms: number | null;
  author: string;
  summary: string;
  content_length: number;
  fact: string;
  angle: string;
  audience: string;
  format: string;
  action: string;
  evidence_gap: string;
  risk: string;
  scores: Record<string, number>;
  risk_deduction: number;
  score: number;
  decision: string;
}

interface HotspotBatchTopic extends BatchDraftTopic {
  article: KnowledgeHotspotArticle;
}

export default function HotspotsPage() {
  const [tab, setTab] = useState<Tab>('live');

  // ===== 实时素材（次幂数据）=====
  const [status, setStatus] = useState<HotspotStatus | null>(null);
  const [items, setItems] = useState<HotspotArticleListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const fetchProgress = useActionProgress();
  const curatedProgress = useActionProgress();
  const generateProgress = useActionProgress();
  const [syncMsg, setSyncMsg] = useState('');

  // 筛选
  const [sourceKey, setSourceKey] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [keyword, setKeyword] = useState('');
  const [readStatus, setReadStatus] = useState('');

  // 正文抽屉（实时素材）
  const [drawer, setDrawer] = useState<HotspotArticleDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  // ===== L叔精选（知识库 hotspots）=====
  const [curated, setCurated] = useState<KnowledgeHotspotArticle[]>([]);
  const [curatedFetchedAt, setCuratedFetchedAt] = useState<string | null>(null);
  const [curatedLoading, setCuratedLoading] = useState(false);
  const [curatedRefreshing, setCuratedRefreshing] = useState(false);
  const [curatedMsg, setCuratedMsg] = useState('');
  // L叔精选详情抽屉
  const [curatedDrawer, setCuratedDrawer] = useState<CuratedArticle | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<KnowledgeGenerateResult | null>(null);
  const [generateMsg, setGenerateMsg] = useState('');
  const [batchSelectionMode, setBatchSelectionMode] = useState(false);
  const [selectedArticleIds, setSelectedArticleIds] = useState<string[]>([]);
  const [batchDrawerOpen, setBatchDrawerOpen] = useState(false);
  const [batchItems, setBatchItems] = useState<BatchDraftItem<HotspotBatchTopic>[]>([]);
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [batchMsg, setBatchMsg] = useState('');
  const batchRunRef = useRef(0);
  const batchTriggerRef = useRef<HTMLButtonElement | null>(null);

  // ===== 历史朋友圈（本地持久化草稿）=====
  const [historyItems, setHistoryItems] = useState<KnowledgeMomentDraft[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);
  const [historySearch, setHistorySearch] = useState('');
  const [historyKeyword, setHistoryKeyword] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const historyRequestRef = useRef(0);

  const pageSize = 20;

  const handleTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = event.currentTarget.dataset.tab as Tab;
    const currentIndex = TAB_ORDER.indexOf(current);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? TAB_ORDER.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + TAB_ORDER.length) % TAB_ORDER.length;
    const nextTab = TAB_ORDER[nextIndex];
    setTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById(`hotspot-tab-${nextTab}`)?.focus());
  }, []);

  // ===== 实时素材加载 =====
  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getHotspotStatus();
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const r = await api.getHotspots({ page, pageSize, sourceKey, dateFrom, dateTo, keyword, readStatus });
      setItems(r.items);
      setTotal(r.total);
      setTotalPages(r.totalPages);
    } catch {
      setItems([]);
      setTotal(0);
    }
  }, [page, pageSize, sourceKey, dateFrom, dateTo, keyword, readStatus]);

  useEffect(() => {
    if (tab === 'live') {
      loadStatus();
      loadList();
    }
  }, [tab, loadStatus, loadList]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      await fetchProgress.run(async () => {
        const r = await api.syncHotspot();
        if (r.ok) {
          const inserted = r.sources.reduce((n, s) => n + s.inserted, 0);
          const dup = r.sources.reduce((n, s) => n + s.duplicate, 0);
          const failed = r.sources.filter((s) => s.status === 'error').length;
          setSyncMsg(`同步完成：${r.total} 个来源，新入库 ${inserted} 篇，去重 ${dup} 篇${failed ? `，失败 ${failed} 个` : ''}。`);
        }
        await loadStatus();
        await loadList();
      }, { label: '正在抓取热点', successMessage: '抓取完成' });
    } catch (e) {
      const err = e as { message?: string; code?: string };
      setSyncMsg(err.code === 'SYNC_IN_PROGRESS' ? '同步正在进行中，请稍候。' : `同步失败：${err.message ?? '未知错误'}`);
    } finally {
      setSyncing(false);
    }
  }, [loadStatus, loadList, fetchProgress.run]);

  const openDetail = useCallback(async (item: HotspotArticleListItem) => {
    setDrawerLoading(true);
    setDrawer(null);
    try {
      const d = await api.getHotspotArticle(item.id);
      setDrawer(d);
    } catch {
      setDrawer(null);
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  // ===== L叔精选加载 =====
  const loadCurated = useCallback(async (refresh = false) => {
    setCuratedLoading(true);
    setCuratedMsg('');
    try {
      if (refresh) {
        setCuratedRefreshing(true);
        await curatedProgress.run(async () => {
          const r = await api.refreshKnowledgeHotspots();
          setCurated(r.articles);
          setCuratedFetchedAt(r.fetched_at);
          setCuratedMsg(r.message ?? '');
        }, { label: '正在刷新 36Kr 精选', successMessage: '精选已刷新' });
        setCuratedRefreshing(false);
      } else {
        const r = await api.getKnowledgeHotspots();
        setCurated(r.articles);
        setCuratedFetchedAt(r.fetched_at);
        setCuratedRefreshing(false);
      }
    } catch (e) {
      const err = e as { message?: string };
      setCuratedMsg(`加载失败：${err.message ?? '未知错误'}`);
      setCuratedRefreshing(false);
    } finally {
      setCuratedLoading(false);
    }
  }, [curatedProgress.run]);

  useEffect(() => {
    if (tab === 'curated') {
      loadCurated(false);
    }
  }, [tab, loadCurated]);

  const loadHistoryPage = useCallback(async (
    targetPage: number,
    append: boolean,
    query: string,
  ) => {
    const requestId = historyRequestRef.current + 1;
    historyRequestRef.current = requestId;
    if (append) setHistoryLoadingMore(true);
    else setHistoryLoading(true);
    setHistoryError('');
    try {
      const result = await api.getKnowledgeHotspotDrafts({
        page: targetPage,
        pageSize: 20,
        keyword: query,
      });
      if (historyRequestRef.current !== requestId) return;
      setHistoryItems((current) => {
        if (!append) return result.items;
        const knownIds = new Set(current.map((item) => item.id));
        return [...current, ...result.items.filter((item) => !knownIds.has(item.id))];
      });
      setHistoryTotal(result.total);
      setHistoryPage(result.page);
      setHistoryTotalPages(result.totalPages);
    } catch (error) {
      if (historyRequestRef.current !== requestId) return;
      const err = error as { message?: string };
      setHistoryError(err.message ?? '历史朋友圈加载失败，请重试。');
    } finally {
      if (historyRequestRef.current === requestId) {
        setHistoryLoading(false);
        setHistoryLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    if (tab === 'history') void loadHistoryPage(1, false, historyKeyword);
  }, [tab, historyKeyword, loadHistoryPage]);

  useEffect(() => {
    if (!drawer && !curatedDrawer && !drawerLoading && !batchDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setDrawer(null);
      setCuratedDrawer(null);
      setBatchDrawerOpen(false);
      window.setTimeout(() => batchTriggerRef.current?.focus(), 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, curatedDrawer, drawerLoading, batchDrawerOpen]);

  const openCurated = useCallback((a: CuratedArticle) => {
    setCuratedDrawer(a);
    setGenerated(null);
    setGenerateMsg('');
  }, []);

  const generateDraft = useCallback(async () => {
    if (!curatedDrawer) return;
    setGenerating(true);
    setGenerateMsg('');
    try {
      await generateProgress.run(async () => {
        const r = await api.generateKnowledgeHotspot(curatedDrawer.article_id, {
          generationMode: 'single',
          requestId: createGenerationRequestId('single'),
        });
        setGenerated(r);
      }, { label: '正在生成朋友圈草稿', successMessage: '草稿已生成' });
    } catch (e) {
      const err = e as { message?: string };
      setGenerateMsg(`生成失败：${err.message ?? '未知错误'}`);
    } finally {
      setGenerating(false);
    }
  }, [curatedDrawer, generateProgress.run]);

  const toggleBatchArticle = useCallback((article: KnowledgeHotspotArticle) => {
    if (article.score < 70 || article.decision === '暂缓') return;
    setSelectedArticleIds((current) => {
      if (current.includes(article.article_id)) {
        setBatchMsg('');
        return current.filter((id) => id !== article.article_id);
      }
      if (current.length >= MAX_BATCH_DRAFTS) {
        setBatchMsg(`最多选择 ${MAX_BATCH_DRAFTS} 篇选题。`);
        return current;
      }
      setBatchMsg('');
      return [...current, article.article_id];
    });
  }, []);

  const enterBatchSelection = useCallback(() => {
    setBatchSelectionMode(true);
    setSelectedArticleIds([]);
    setBatchMsg('');
  }, []);

  const cancelBatchSelection = useCallback(() => {
    setBatchSelectionMode(false);
    setSelectedArticleIds([]);
    setBatchMsg('');
  }, []);

  const startBatchGeneration = useCallback(async () => {
    if (batchGenerating || selectedArticleIds.length === 0) return;
    const selected = selectedArticleIds
      .map((id) => curated.find((article) => article.article_id === id))
      .filter((article): article is KnowledgeHotspotArticle => Boolean(article));
    if (selected.length === 0) return;

    const runId = batchRunRef.current + 1;
    batchRunRef.current = runId;
    const topics: HotspotBatchTopic[] = selected.map((article) => ({
      articleId: article.article_id,
      title: article.title,
      article,
    }));

    setBatchGenerating(true);
    setBatchMsg('');
    setBatchDrawerOpen(true);
    setBatchSelectionMode(false);
    try {
      const result = await runHotspotDraftBatch({
        topics,
        generate: (articleId) => api.generateKnowledgeHotspot(articleId, {
          generationMode: 'batch',
          requestId: createGenerationRequestId('batch'),
        }),
        onUpdate: (nextItems) => {
          if (batchRunRef.current === runId) setBatchItems(nextItems);
        },
      });
      if (batchRunRef.current === runId) setBatchItems(result);
    } catch (error) {
      const err = error as { message?: string };
      if (batchRunRef.current === runId) setBatchMsg(err.message ?? '批量生成失败，请重试。');
    } finally {
      if (batchRunRef.current === runId) setBatchGenerating(false);
    }
  }, [batchGenerating, curated, selectedArticleIds]);

  const retryBatchItem = useCallback(async (articleId: string) => {
    const target = batchItems.find((item) => item.articleId === articleId);
    if (!target || target.status === 'running') return;
    setBatchItems((current) => current.map((item) => (
      item.articleId === articleId
        ? { ...item, status: 'running', draft: undefined, errorCode: undefined, errorMessage: undefined }
        : item
    )));
    try {
      const result = await api.generateKnowledgeHotspot(articleId, {
        generationMode: 'retry',
        requestId: createGenerationRequestId('retry'),
      });
      const draft = result.draft.trim();
      if (!draft) throw new Error('模型没有返回可展示的朋友圈正文，请重试');
      setBatchItems((current) => current.map((item) => (
        item.articleId === articleId ? { ...item, status: 'success', draft } : item
      )));
    } catch (error) {
      const err = error as { code?: string; message?: string };
      setBatchItems((current) => current.map((item) => (
        item.articleId === articleId
          ? { ...item, status: 'error', errorCode: err.code, errorMessage: err.message ?? '生成失败，请重试' }
          : item
      )));
    }
  }, [batchItems]);

  // ===== 实时素材 4 指标 =====
  const metrics = useMemo(() => {
    if (!status) return [];
    return [
      { key: 'today', label: '今日文章', value: status.todayCount },
      { key: 'total', label: '累计文章', value: status.totalCount },
      { key: 'unread', label: '未读', value: status.unreadCount },
      { key: 'pending', label: '正文待抓', value: status.pendingBodyCount },
    ];
  }, [status]);

  // L叔精选是否"今日"抓取（历史校准素材通常不是今天）
  const curatedIsToday = isToday(curatedFetchedAt);

  return (
    <div className="ui-page">
      <div className="ui-page-head">
        <div>
          <div className="ui-page-kicker">R-04 · RADAR</div>
          <h1>热点雷达</h1>
        </div>
        {tab === 'live' ? (
          <button className="nb-btn nb-btn--primary" onClick={runSync} disabled={syncing || fetchProgress.running}>
            {fetchProgress.running ? '抓取中…' : '立即抓取'}
          </button>
        ) : tab === 'curated' ? (
          <div className="flex gap-2" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {batchSelectionMode ? (
              <>
                <button className="nb-btn nb-btn--ghost" onClick={cancelBatchSelection}>取消</button>
                <button
                  className="nb-btn nb-btn--primary"
                  onClick={startBatchGeneration}
                  disabled={selectedArticleIds.length === 0 || batchGenerating}
                >
                  {batchGenerating ? '生成中…' : `批量生成 ${selectedArticleIds.length}/${MAX_BATCH_DRAFTS}`}
                </button>
              </>
            ) : (
              <>
                <button
                  className="nb-btn nb-btn--ghost"
                  onClick={() => loadCurated(true)}
                  disabled={curatedRefreshing || curatedProgress.running || batchGenerating}
                >
                  {curatedProgress.running ? '刷新中…' : '刷新 36Kr 精选'}
                </button>
                {batchItems.length > 0 && (
                  <button className="nb-btn nb-btn--ghost" onClick={() => setBatchDrawerOpen(true)}>
                    查看批量结果
                  </button>
                )}
                <button
                  ref={batchTriggerRef}
                  className="nb-btn nb-btn--primary"
                  onClick={enterBatchSelection}
                  disabled={curated.length === 0 || batchGenerating}
                >
                  批量生成朋友圈
                </button>
              </>
            )}
          </div>
        ) : (
          <button
            className="nb-btn nb-btn--ghost"
            onClick={() => void loadHistoryPage(1, false, historyKeyword)}
            disabled={historyLoading || historyLoadingMore}
          >
            {historyLoading ? '读取中…' : '刷新历史'}
          </button>
        )}
      </div>

      {tab === 'live' ? (
        <ActionProgress progress={fetchProgress.progress} onRetry={runSync} />
      ) : tab === 'curated' ? (
        <ActionProgress progress={curatedProgress.progress} onRetry={() => void loadCurated(true)} />
      ) : null}

      {/* 页签 */}
      <div className="nb-tabs" role="tablist" aria-label="热点雷达内容">
        <button
          id="hotspot-tab-live"
          type="button"
          role="tab"
          data-tab="live"
          aria-selected={tab === 'live'}
          aria-controls="hotspot-panel-live"
          tabIndex={tab === 'live' ? 0 : -1}
          className={`nb-tab ${tab === 'live' ? 'nb-tab--active' : ''}`}
          onClick={() => setTab('live')}
          onKeyDown={handleTabKeyDown}
        >
          实时素材
        </button>
        <button
          id="hotspot-tab-curated"
          type="button"
          role="tab"
          data-tab="curated"
          aria-selected={tab === 'curated'}
          aria-controls="hotspot-panel-curated"
          tabIndex={tab === 'curated' ? 0 : -1}
          className={`nb-tab ${tab === 'curated' ? 'nb-tab--active' : ''}`}
          onClick={() => setTab('curated')}
          onKeyDown={handleTabKeyDown}
        >
          L叔精选
        </button>
        <button
          id="hotspot-tab-history"
          type="button"
          role="tab"
          data-tab="history"
          aria-selected={tab === 'history'}
          aria-controls="hotspot-panel-history"
          tabIndex={tab === 'history' ? 0 : -1}
          className={`nb-tab ${tab === 'history' ? 'nb-tab--active' : ''}`}
          onClick={() => setTab('history')}
          onKeyDown={handleTabKeyDown}
        >
          历史朋友圈
        </button>
      </div>

      {tab === 'live' && (
        <div
          id="hotspot-panel-live"
          role="tabpanel"
          aria-labelledby="hotspot-tab-live"
        >
          <div className="ui-receipt">
            <span className="nb-badge nb-badge--denim">次幂数据</span>
            <span className="nb-muted" style={{ fontSize: 13, marginLeft: 12 }}>
              每天自动抓取「虎嗅APP」「36氪」微信公众号推文 · 上次抓取 {formatTime(status?.lastFetchAt ?? null)}
            </span>
            {status && (
              <span className="nb-muted" style={{ fontSize: 13, marginLeft: 12 }}>
                · 已调用 {status.callStats ? status.callStats.token + status.callStats.account_info + status.callStats.current + status.callStats.long2short + status.callStats.body : 0} 次幂接口，成本 {formatCost(status.estimatedCost)}
              </span>
            )}
          </div>

          {syncMsg && (
            <div className="ui-alert ui-alert--warn">
              <span style={{ fontSize: 14 }}>{syncMsg}</span>
            </div>
          )}

          {status && !status.cimi.hasCredentials && (
            <div className="ui-alert ui-alert--error">
              <h3 style={{ fontSize: 16, marginBottom: 8 }}>次幂数据凭证未配置</h3>
              <p style={{ fontSize: 14, lineHeight: 1.7 }}>
                当前无法连接次幂数据 API。请在 <code>backend/.env.local</code> 中填写
                <code> CIMIDATA_APP_ID</code> 与 <code>CIMIDATA_APP_SECRET</code>（可从 cimidata.com 注册获取），填写后重启后端即可抓取。
              </p>
            </div>
          )}

          {/* 4 指标卡片 */}
          <div className="grid-auto mb-4">
            {metrics.map((m) => (
              <div key={m.key} className="ui-metric">
                <div className="ui-metric-label">{m.label}</div>
                <div className="ui-data">{m.value}</div>
              </div>
            ))}
          </div>

          {/* 来源状态 */}
          {status && status.sources.length > 0 && (
            <div className="nb-card mb-4">
              <h2 className="nb-section-title" style={{ fontSize: 20 }}>抓取来源</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {status.sources.map((s) => (
                  <div key={s.id} className="cluster-row">
                    <span className={`nb-badge ${s.enabled ? 'nb-badge--olive' : 'nb-badge--red'}`}>{s.enabled ? '启用' : '停用'}</span>
                    <div style={{ fontSize: 14 }}>
                      <strong>{s.displayName}</strong>
                      {s.cimiSynced ? (
                        <span className="nb-muted" style={{ fontSize: 12, marginLeft: 8 }}>· 已同步 (biz {s.accountBiz ? s.accountBiz.slice(0, 6) + '…' : '—'})</span>
                      ) : (
                        <span className="nb-muted" style={{ fontSize: 12, marginLeft: 8 }}>· 待首次抓取同步</span>
                      )}
                    </div>
                    <div className="nb-muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                      最近抓取 {formatTime(s.lastFetchAt)} · {s.lastArticleCount} 篇
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 筛选栏 */}
          <div className="ui-module mb-4">
            <div className="ui-toolbar">
              <select className="nb-input" style={{ maxWidth: 150 }} value={sourceKey} onChange={(e) => { setSourceKey(e.target.value); setPage(1); }}>
                <option value="">全部来源</option>
                {status?.sources.map((s) => (
                  <option key={s.id} value={s.sourceKey}>{s.displayName}</option>
                ))}
              </select>
              <input className="nb-input" type="date" style={{ maxWidth: 160 }} value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
              <input className="nb-input" type="date" style={{ maxWidth: 160 }} value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
              <input
                className="nb-input"
                style={{ maxWidth: 220 }}
                placeholder="搜索关键词…"
                value={keyword}
                onChange={(e) => { setKeyword(e.target.value); setPage(1); }}
              />
              <select className="nb-input" style={{ maxWidth: 140 }} value={readStatus} onChange={(e) => { setReadStatus(e.target.value); setPage(1); }}>
                <option value="">阅读状态</option>
                <option value="unread">未读</option>
                <option value="read">已读</option>
              </select>
            </div>
          </div>

          {/* 文章列表 */}
          <div className="ui-module">
            <div className="flex items-center justify-between mb-3">
              <h2 className="ui-module-title"><span className="ui-code">L-04</span>文章列表（{total}）</h2>
            </div>
            {items.length === 0 ? (
              <div className="empty-state"><p>暂无文章。点击「立即抓取」拉取当天发文，或确认凭证已配置。</p></div>
            ) : (
              <div className="note-table">
                {items.map((it) => (
                  <div
                    key={it.id}
                    className="hotspot-row"
                    onClick={() => openDetail(it)}
                    title={it.title}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</div>
                      <div className="nb-muted" style={{ fontSize: 12, marginTop: 2 }}>
                        {it.sourceName} · {formatTime(it.publishTime)} · {it.author ?? '—'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <span className={`nb-badge ${it.bodyReady ? 'nb-badge--olive' : it.bodyPending ? 'nb-badge--denim' : 'nb-badge--blush'}`}>
                        {it.bodyReady ? '正文 ✓' : it.bodyTooShort ? '正文过短' : '正文待抓'}
                      </span>
                      <span className={`nb-badge ${it.todoStatus === 'added' ? 'nb-badge--olive' : 'nb-badge--denim'}`}>
                        {it.todoStatus === 'added' ? '已入待办' : '待办'}
                      </span>
                      <span className={`nb-badge ${it.readStatus === 'unread' ? 'nb-badge--red' : 'nb-badge--olive'}`}>
                        {it.readStatus === 'unread' ? '未读' : '已读'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="flex gap-2" style={{ marginTop: 14, flexWrap: 'wrap' }}>
                <button className="nb-btn nb-btn--ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
                <span className="nb-muted" style={{ alignSelf: 'center', fontSize: 13 }}>{page} / {totalPages}</span>
                <button className="nb-btn nb-btn--ghost" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>下一页</button>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'curated' && (
        <div
          id="hotspot-panel-curated"
          role="tabpanel"
          aria-labelledby="hotspot-tab-curated"
        >
          {/* 说明条：L叔精选（知识库校准素材，非今日热点） */}
          <div className="ui-receipt">
            <span className="nb-badge">L叔精选</span>
            <span className="nb-muted" style={{ fontSize: 13, marginLeft: 12 }}>
              来自知识库热点评分系统 · 抓取时间 {curatedFetchedAt ? formatTime(curatedFetchedAt) : '—'}
            </span>
            <span className="nb-muted" style={{ fontSize: 13, marginLeft: 12 }}>
              · {curatedIsToday ? '（今日素材）' : '（历史校准素材，非今日热点）'}
            </span>
          </div>

          {curatedMsg && (
            <div className="ui-alert ui-alert--warn">
              <span style={{ fontSize: 14 }}>{curatedMsg}</span>
            </div>
          )}

          {batchSelectionMode && (
            <div className="kb-batch-selection-panel" aria-live="polite">
              <div>
                <strong>选择要生成朋友圈的选题</strong>
                <span>已选择 {selectedArticleIds.length}/{MAX_BATCH_DRAFTS} · 最多选择 4 篇</span>
              </div>
              <span className="kb-batch-selection-hint">
                {selectedArticleIds.length === MAX_BATCH_DRAFTS ? '已选满，取消一篇后可继续选择。' : '点击卡片即可加入或移出本批次。'}
              </span>
            </div>
          )}

          {batchMsg && (
            <div className="ui-alert ui-alert--warn" role="status">
              <span style={{ fontSize: 14 }}>{batchMsg}</span>
            </div>
          )}

          {curatedLoading ? (
            <div className="nb-card empty-state"><p>加载 L叔精选…</p></div>
          ) : curated.length === 0 ? (
            <div className="nb-card empty-state">
              <p>暂无精选素材。点击右上角「刷新 36Kr 精选」抓取并评分。</p>
            </div>
          ) : (
            <div className="grid-auto kb-hotspot-grid">
              {curated.map((a) => {
                const selected = selectedArticleIds.includes(a.article_id);
                const eligible = a.score >= 70 && a.decision !== '暂缓';
                const selectionLocked = batchSelectionMode
                  && !selected
                  && (selectedArticleIds.length >= MAX_BATCH_DRAFTS || !eligible);
                const cardBody = (
                  <>
                    <div className="flex items-center justify-between" style={{ gap: 10 }}>
                      <span className="nb-score-pill nb-score-pill--high" style={{ fontSize: 18, padding: '6px 14px' }}>
                        {a.score}
                      </span>
                      <span className="nb-badge nb-badge--denim" style={{ fontSize: 12 }}>
                        {a.decision}
                      </span>
                    </div>
                    <div className="kb-hotspot-title" style={{ marginTop: 10 }}>{a.title}</div>
                    <div className="kb-hotspot-meta">
                      <span className="nb-badge nb-badge--denim">{formatMs(a.published_at_ms)}</span>
                      {a.author && <span className="nb-badge nb-badge--blush">{a.author}</span>}
                      <span className="nb-badge nb-badge--olive">{a.format}</span>
                    </div>
                    <div className="kb-hotspot-summary">… {a.summary}</div>
                  </>
                );

                if (batchSelectionMode) {
                  return (
                    <label
                      key={a.article_id}
                      className={`nb-card kb-hotspot-card kb-hotspot-select-card ${selected ? 'is-selected' : ''} ${selectionLocked ? 'is-disabled' : ''}`}
                      aria-disabled={selectionLocked}
                    >
                      <span className="kb-hotspot-checkbox-wrap">
                        <input
                          className="kb-hotspot-checkbox"
                          type="checkbox"
                          checked={selected}
                          disabled={selectionLocked}
                          onChange={() => toggleBatchArticle(a)}
                          aria-label={`选择选题：${a.title}`}
                        />
                        <span>{selected ? `已选 ${selectedArticleIds.indexOf(a.article_id) + 1}` : eligible ? '选择' : '不可生成'}</span>
                      </span>
                      {cardBody}
                    </label>
                  );
                }

                return (
                  <button
                    key={a.article_id}
                    type="button"
                    className="nb-card nb-card--hover kb-hotspot-card kb-hotspot-button"
                    onClick={() => openCurated(a)}
                  >
                    {cardBody}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div
          id="hotspot-panel-history"
          role="tabpanel"
          aria-labelledby="hotspot-tab-history"
          aria-busy={historyLoading || historyLoadingMore}
        >
          <div className="ui-receipt">
            <span className="nb-badge">历史朋友圈</span>
            <span className="nb-muted" style={{ fontSize: 13 }}>
              已保存 {historyTotal} 条最终正文 · 只展示可复制的朋友圈草稿，不展示 AI 思考过程
            </span>
          </div>

          <form
            className="ui-module kb-history-toolbar mb-4"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              const nextKeyword = historySearch.trim();
              if (nextKeyword === historyKeyword) {
                void loadHistoryPage(1, false, nextKeyword);
              } else {
                setHistoryKeyword(nextKeyword);
              }
            }}
          >
            <label className="kb-history-search-field">
              <span>搜索正文或选题</span>
              <input
                className="nb-input"
                type="search"
                value={historySearch}
                placeholder="输入关键词…"
                onChange={(event) => setHistorySearch(event.target.value)}
              />
            </label>
            <div className="kb-history-toolbar-actions">
              <button className="nb-btn nb-btn--primary" type="submit" disabled={historyLoading}>
                搜索
              </button>
              {(historyKeyword || historySearch) && (
                <button
                  className="nb-btn nb-btn--ghost"
                  type="button"
                  onClick={() => {
                    setHistorySearch('');
                    if (historyKeyword) setHistoryKeyword('');
                    else void loadHistoryPage(1, false, '');
                  }}
                >
                  清除筛选
                </button>
              )}
            </div>
            <span className="kb-history-result-count" role="status" aria-live="polite">
              {historyKeyword ? `“${historyKeyword}” · ${historyTotal} 条` : `共 ${historyTotal} 条`}
            </span>
          </form>

          {historyError && (
            <div className="ui-alert ui-alert--error kb-history-error" role="alert">
              <div>
                <strong>历史朋友圈读取失败</strong>
                <p>{historyError}</p>
              </div>
              <button
                className="nb-btn nb-btn--ghost"
                type="button"
                onClick={() => void loadHistoryPage(1, false, historyKeyword)}
              >
                重新读取
              </button>
            </div>
          )}

          {historyLoading && historyItems.length === 0 ? (
            <div className="ui-module empty-state" role="status">
              <p>正在读取历史朋友圈…</p>
            </div>
          ) : historyItems.length === 0 && historyError ? null
          : historyItems.length === 0 && !historyError ? (
            <div className="ui-module empty-state kb-history-empty">
              {historyKeyword ? (
                <>
                  <h2>没有符合筛选条件的草稿</h2>
                  <p>换一个关键词，或清除筛选查看全部历史朋友圈。</p>
                  <button
                    className="nb-btn nb-btn--ghost"
                    type="button"
                    onClick={() => {
                      setHistorySearch('');
                      setHistoryKeyword('');
                    }}
                  >
                    清除筛选
                  </button>
                </>
              ) : (
                <>
                  <h2>还没有朋友圈草稿</h2>
                  <p>从「L叔精选」生成单篇或批量朋友圈，成功正文会自动保存在这里。</p>
                  <button className="nb-btn nb-btn--primary" type="button" onClick={() => setTab('curated')}>
                    前往 L叔精选
                  </button>
                </>
              )}
            </div>
          ) : (
            <>
              <HistoryMomentGrid items={historyItems} busy={historyLoading || historyLoadingMore} />
              {historyPage < historyTotalPages && (
                <div className="kb-history-load-more">
                  <button
                    className="nb-btn nb-btn--ghost"
                    type="button"
                    disabled={historyLoadingMore}
                    onClick={() => void loadHistoryPage(historyPage + 1, true, historyKeyword)}
                  >
                    {historyLoadingMore ? '加载中…' : `加载更多（已显示 ${historyItems.length}/${historyTotal}）`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 实时素材正文抽屉 */}
      {drawerLoading && (
        <div className="drawer-overlay">
          <div className="drawer"><div className="drawer-body"><p className="nb-muted">加载正文中…</p></div></div>
        </div>
      )}
      {drawer && (
        <div className="drawer-overlay" onClick={() => setDrawer(null)}>
          <div className="drawer" role="dialog" aria-modal="true" aria-label="热点正文" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <div style={{ maxWidth: 480 }}>
                <div className="drawer-kicker">热点雷达 · {drawer.sourceName}</div>
                <h2 className="drawer-title">{drawer.title}</h2>
              </div>
              <button className="nb-btn nb-btn--ghost drawer-close" aria-label="关闭正文抽屉" onClick={() => setDrawer(null)}>关闭</button>
            </div>
            <div className="drawer-source">
              <span className="nb-badge nb-badge--denim">{formatTime(drawer.publishTime)}</span>
              <span className="nb-badge nb-badge--blush">{drawer.author ?? '—'}</span>
              <span className={`nb-badge ${drawer.bodyReady ? 'nb-badge--olive' : 'nb-badge--denim'}`}>
                {drawer.bodyReady ? '正文 ✓' : drawer.bodyTooShort ? '正文过短' : '正文待抓'}
              </span>
            </div>
            <div className="drawer-body">
              {drawer.bodyText ? (
                <div className="article-body" style={{ fontSize: 15, lineHeight: 1.85, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {drawer.bodyText}
                </div>
              ) : (
                <div className="nb-muted" style={{ fontSize: 14 }}>
                  {drawer.bodyPending ? '正文尚未抓取成功，等待下次同步重试。' : '正文过短或暂不可用。'}
                </div>
              )}
              <div className="flex gap-2" style={{ marginTop: 20, flexWrap: 'wrap' }}>
                <a className="nb-btn nb-btn--ghost" href={drawer.url} target="_blank" rel="noreferrer">查看原文 ↗</a>
                {drawer.todoStatus !== 'added' && (
                  <button className="nb-btn nb-btn--primary" onClick={async () => { await api.addHotspotToTodo(drawer.id); await loadStatus(); await loadList(); }}>加入待办</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* L叔精选详情抽屉 */}
      {curatedDrawer && (
        <div className="drawer-overlay" onClick={() => setCuratedDrawer(null)}>
          <div className="drawer" role="dialog" aria-modal="true" aria-label="精选详情" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <div style={{ maxWidth: 480 }}>
                <div className="drawer-kicker">L叔精选 · {curatedDrawer.format}</div>
                <h2 className="drawer-title">{curatedDrawer.title}</h2>
              </div>
              <button className="nb-btn nb-btn--ghost drawer-close" aria-label="关闭精选抽屉" onClick={() => setCuratedDrawer(null)}>关闭</button>
            </div>
            <div className="drawer-source">
              <span className="nb-badge nb-badge--denim">{formatMs(curatedDrawer.published_at_ms)}</span>
              {curatedDrawer.author && <span className="nb-badge nb-badge--blush">{curatedDrawer.author}</span>}
              <span className="nb-score-pill nb-score-pill--high">总分 {curatedDrawer.score}</span>
              <span className="nb-badge nb-badge--olive">{curatedDrawer.decision}</span>
            </div>
            <div className="drawer-body">
              {curatedDrawer.summary && (
                <div className="kb-draft-block" style={{ marginBottom: 16 }}>
                  {curatedDrawer.summary}
                </div>
              )}

              {/* 评分卡 */}
              <div className="kb-drawer-score-row">
                {SCORE_KEYS.map(([k, label]) => (
                  <div key={k} className="kb-drawer-score">
                    <span>{k} {label}</span>
                    <b>{(curatedDrawer.scores?.[k] ?? 0) / 5}</b>
                  </div>
                ))}
              </div>

              {/* 关键维度 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
                <div><div className="nb-muted" style={{ fontSize: 12, fontWeight: 800 }}>事实</div><div style={{ fontSize: 14 }}>{curatedDrawer.fact || '—'}</div></div>
                <div><div className="nb-muted" style={{ fontSize: 12, fontWeight: 800 }}>角度</div><div style={{ fontSize: 14 }}>{curatedDrawer.angle || '—'}</div></div>
                <div><div className="nb-muted" style={{ fontSize: 12, fontWeight: 800 }}>适合人群</div><div style={{ fontSize: 14 }}>{curatedDrawer.audience || '—'}</div></div>
                <div><div className="nb-muted" style={{ fontSize: 12, fontWeight: 800 }}>行动建议</div><div style={{ fontSize: 14 }}>{curatedDrawer.action || '—'}</div></div>
                <div><div className="nb-muted" style={{ fontSize: 12, fontWeight: 800 }}>证据缺口</div><div style={{ fontSize: 14 }}>{curatedDrawer.evidence_gap || '—'}</div></div>
                <div><div className="nb-muted" style={{ fontSize: 12, fontWeight: 800 }}>风险提醒</div><div style={{ fontSize: 14 }}>{curatedDrawer.risk || '—'}</div></div>
              </div>

              {/* 生成朋友圈草稿 */}
              <div className="nb-divider" />
              <div className="flex items-center justify-between mb-2" style={{ flexWrap: 'wrap', gap: 10 }}>
                <h3 style={{ fontSize: 16 }}>生成朋友圈草稿</h3>
                <button className="nb-btn nb-btn--primary" onClick={generateDraft} disabled={generating || generateProgress.running}>
                  {generateProgress.running ? '生成中…' : '生成草稿'}
                </button>
              </div>
              <ActionProgress progress={generateProgress.progress} onRetry={generateDraft} />
              {generateMsg && <div className="nb-muted" style={{ fontSize: 13, marginBottom: 10, color: 'var(--red)' }}>{generateMsg}</div>}
              {generated && (
                <section aria-labelledby="hotspot-draft-title">
                  <h4 id="hotspot-draft-title" className="kb-sources-title">朋友圈正文草稿</h4>
                  <div className="kb-draft-block">{generated.draft}</div>
                </section>
              )}

              <div className="flex gap-2" style={{ marginTop: 20, flexWrap: 'wrap' }}>
                <a className="nb-btn nb-btn--ghost" href={curatedDrawer.url} target="_blank" rel="noreferrer">查看原文 ↗</a>
              </div>
            </div>
          </div>
        </div>
      )}

      <BatchMomentDrawer
        open={batchDrawerOpen}
        items={batchItems}
        onClose={() => {
          setBatchDrawerOpen(false);
          window.setTimeout(() => batchTriggerRef.current?.focus(), 0);
        }}
        onRetry={retryBatchItem}
      />
    </div>
  );
}
