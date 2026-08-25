import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Barcode, Calendar, Check, File, Message, Receipt, Sparkles, StickyNote } from 'pixelarticons/react';
import { api } from '../api/client';
import lshuAvatar from '../assets/avatar/lshu-avatar.source.svg';
import obsidianPrinter from '../assets/printer/printer-02-obsidian-wide.svg';
import type {
  AppSettings,
  ConnectorStatus,
  DayPlan,
  TodoEvidence,
  TodoItem,
  TodoLifecycle,
  AiStatusResponse,
  TodayOverviewItem,
  TodayOverviewSource,
} from '../types';
import ActionProgress from '../components/ActionProgress';
import ClickSpark from '../components/motion/ClickSpark';
import { useActionProgress } from '../lib/actionProgress';
import { aiErrorLabel, formatAiTime, formatAiRunSummary } from '../lib/aiStatus';
import { appleCalendarBanner, feishuCoverageBanner } from '../lib/calendarStatus';
import { invalidateTodayTodos } from '../features/todos/useTodayTodos';
import {
  getScheduledBlocks,
  getTimelineBlocks,
  humanizePlanWarning,
  humanizeUnscheduled,
  overviewStateLabel,
} from '../features/todos/todoPresentation';
import { RECEIPT_PRINT_DURATION_MS } from '../features/todos/receiptMotion';

const SOURCE_COLOR: Record<string, string> = {
  things: '#FFD12E',
  feishu: '#FF5A1F',
  apple_calendar: '#2F6BFF',
  desktop: '#111111',
  workbench: '#111111',
};

const SOURCE_LABEL: Record<string, string> = {
  things: 'Things',
  feishu: '飞书',
  apple_calendar: 'Apple 日历',
  desktop: '桌面',
  workbench: '工作台',
  feishu_message: '飞书',
};

function SourceIcon({ source }: { source: string }) {
  const props = { width: 16, height: 16, 'aria-hidden': true as const };
  if (source === 'things') return <StickyNote {...props} />;
  if (source === 'feishu') return <Message {...props} />;
  if (source === 'apple_calendar') return <Calendar {...props} />;
  return <File {...props} />;
}

function lifecycleOf(todo: TodoItem): TodoLifecycle {
  return todo.lifecycleStatus || (todo.status === 'confirmed' ? 'confirmed' : todo.status === 'ignored' ? 'ignored' : 'candidate');
}

function formatWhen(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatHm(value?: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function localDateKey(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function weekdayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00`);
  return d.toLocaleDateString('zh-CN', { weekday: 'long' });
}

export default function TodosPage() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  const date = localDateKey(new Date(), timezone);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [overview, setOverview] = useState<TodayOverviewItem[]>([]);
  const [overviewMeta, setOverviewMeta] = useState({ date, revision: '' });
  const [searchParams] = useSearchParams();
  const focusedRef = useRef<string | null>(null);
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [syncing, setSyncing] = useState(false);
  const syncProgress = useActionProgress();
  const planProgress = useActionProgress();
  const itemPlanProgress = useActionProgress();
  const [syncMsg, setSyncMsg] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<TodoItem | null>(null);
  const [evidence, setEvidence] = useState<TodoEvidence[]>([]);
  const [dayPlan, setDayPlan] = useState<DayPlan | null>(null);
  const [receiptPrintKey, setReceiptPrintKey] = useState(0);
  const [receiptPrinting, setReceiptPrinting] = useState(false);
  const receiptPrintTimerRef = useRef(0);
  const receiptStartTimerRef = useRef(0);
  const receiptSectionRef = useRef<HTMLElement>(null);
  const [commitPreview, setCommitPreview] = useState<{
    blockCount: number;
    date: string;
    range: { startAt: string | null; endAt: string | null };
    targetCalendar: string;
    willNotModify: string[];
  } | null>(null);
  const [writeNote, setWriteNote] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<'all' | TodayOverviewSource>('all');
  const [stateFilter, setStateFilter] = useState<'open' | 'review' | 'planned' | 'completed'>('open');
  const [agendaIssue, setAgendaIssue] = useState('');
  const [feishuCoverageIssue, setFeishuCoverageIssue] = useState('');
  const [suggestions, setSuggestions] = useState<Array<{ id: number; title: string; confidence: number; reasonCode: string }>>([]);
  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);
  const [editMinutes, setEditMinutes] = useState('');
  const [editDue, setEditDue] = useState('');

  const load = useCallback(async (mode: 'page' | 'refresh' = 'page') => {
    try {
      const [list, status, dash, ai, sugg, today, plan] = await Promise.all([
        api.getTodos(),
        api.getConnectorStatus(),
        api.getAgenda(),
        api.getAiStatus().catch(() => null),
        api.getAiSuggestions().catch(() => ({ suggestions: [] as Array<{ id: number; title: string; confidence: number; reasonCode?: string; reason_code?: string }>, count: 0 })),
        api.getTodayOverview(date, timezone),
        api.getTodayDayPlan(date, timezone).catch(() => ({ plan: null })),
      ]);
      setTodos(list);
      setConnectors(status.connectors);
      setSettings(status.settings);
      const calendar = dash.calendar;
      setAgendaIssue(calendar ? (appleCalendarBanner({
        available: calendar.available,
        permission: calendar.permission,
        statusLabel: calendar.statusLabel,
        hint: calendar.hint,
        itemsRead: calendar.itemsRead,
      }) || '') : '');
      setFeishuCoverageIssue(feishuCoverageBanner(dash.coverageError) || '');
      setAiStatus(ai);
      setSuggestions((sugg.suggestions || []).map((s) => ({
        id: s.id,
        title: s.title,
        confidence: s.confidence,
        reasonCode: s.reasonCode || s.reason_code || '',
      })));
      setOverview(today.items || []);
      setOverviewMeta({ date: today.date, revision: today.revision });
      setDayPlan(plan.plan);
      if (mode === 'page') setError('');
    } catch (e) {
      if (mode === 'page') setError((e as Error).message || '待办服务不可用');
    }
  }, [date, timezone]);

  useEffect(() => {
    void load('page');
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  useEffect(() => {
    if (!detailsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetailsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailsOpen]);

  useEffect(() => () => {
    window.clearTimeout(receiptPrintTimerRef.current);
    window.clearTimeout(receiptStartTimerRef.current);
  }, []);

  const startReceiptPrintAnimation = useCallback(() => {
    window.clearTimeout(receiptPrintTimerRef.current);
    window.clearTimeout(receiptStartTimerRef.current);
    setReceiptPrinting(false);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.requestAnimationFrame(() => {
      receiptSectionRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      receiptStartTimerRef.current = window.setTimeout(() => {
        setReceiptPrinting(true);
        setReceiptPrintKey((key) => key + 1);
        receiptPrintTimerRef.current = window.setTimeout(
          () => setReceiptPrinting(false),
          reducedMotion ? 0 : RECEIPT_PRINT_DURATION_MS,
        );
      }, reducedMotion ? 0 : 320);
    });
  }, []);

  const plannedKeys = useMemo(() => new Set((dayPlan?.blocks || []).filter((b) => !b.unscheduled && !b.fixed).map((b) => b.stableKey)), [dayPlan]);

  const filtered = useMemo(() => overview.filter((item) => {
    if (sourceFilter !== 'all' && item.sourceType !== sourceFilter) return false;
    if (stateFilter === 'review') return item.kind === 'needs_review';
    if (stateFilter === 'completed') return item.kind === 'completed';
    if (stateFilter === 'planned') return plannedKeys.has(item.stableKey);
    if (stateFilter === 'open') {
      return item.kind === 'task' || item.kind === 'fixed_event' || item.kind === 'activity_summary' || item.kind === 'needs_review';
    }
    return true;
  }), [overview, sourceFilter, stateFilter, plannedKeys]);

  const saveFlags = async (patch: Partial<AppSettings>) => {
    const next = await api.updateSettings(patch);
    setSettings(next);
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      await syncProgress.run(async () => {
        const started = await api.commitProductivitySync();
        let dto = started;
        if (started.status === 'running' && started.runId) {
          for (;;) {
            dto = await api.getProductivitySyncRun(started.runId);
            if (dto.status !== 'running') break;
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
          }
        }
        if (dto.status === 'error' || dto.status === 'interrupted') {
          throw Object.assign(new Error(dto.errorMessage || '同步失败'), { code: dto.errorCode });
        }
        setSyncMsg(dto.receipt || `只读同步 ${dto.itemsSeen ?? 0} 条，新增 ${dto.created ?? 0}，更新 ${dto.updated ?? 0}。`);
        await load('refresh');
        invalidateTodayTodos();
      }, { label: '正在同步今日数据', successMessage: '今日数据已同步' });
    } catch {
      setSyncMsg('');
    } finally {
      setSyncing(false);
      await load('refresh');
      invalidateTodayTodos();
    }
  };

  const planToday = async () => {
    setReceiptPrinting(false);
    window.clearTimeout(receiptPrintTimerRef.current);
    window.clearTimeout(receiptStartTimerRef.current);
    try {
      await planProgress.run(async () => {
        const currentSettings = settings || await api.getSettings();
        if (currentSettings.aiAnalysisEnabled !== true || currentSettings.aiPlanningConsent !== true) {
          const confirmed = window.confirm(
            '首次使用 AI 今日规划：只会发送已经固化的工作画像、今天的脱敏事项标题和固定忙碌时间。不会重新扫描电脑，也不会发送文件路径、正文或聊天记录。是否继续？'
          );
          if (!confirmed) throw new Error('已取消 AI 今日规划');
          const nextSettings = await api.updateSettings({
            aiAnalysisEnabled: true,
            aiPlanningConsent: true,
            confirmAiUpload: currentSettings.aiAnalysisEnabled !== true,
            confirmAiPlanningUpload: true,
          });
          setSettings(nextSettings);
        }
        const r = await api.createTodayDayPlan({ date, timezone, syncIfStale: true });
        setDayPlan(r.plan);
        setCommitPreview(r.commitPreview);
        setWriteNote(r.plan.copy.draft);
        await load('refresh');

        startReceiptPrintAnimation();
      }, { label: 'AI 正在选择最多 5 件并规划今日排程', successMessage: 'AI 今日排程已生成并保存在本机' });
    } catch {
      setReceiptPrinting(false);
      /* ActionProgress 已展示失败 */
    }
  };

  const confirmWrite = async () => {
    setWriteNote('');
    try {
      await api.commitTodayDayPlan();
    } catch (e) {
      setWriteNote((e as Error).message || '本轮不写入外部日历');
    }
  };

  const openDetail = async (todo: TodoItem) => {
    setSelected(todo);
    setEditMinutes(String(todo.estimatedMinutes || 60));
    setEditDue(todo.dueAt ? todo.dueAt.slice(0, 16) : '');
    try {
      const detail = await api.getTodoEvidence(todo.id);
      setEvidence(detail.evidence);
      setSelected(detail.todo);
    } catch {
      setEvidence([]);
    }
  };

  const refreshAfterWrite = async () => {
    await load('refresh');
    invalidateTodayTodos();
  };

  useEffect(() => {
    const raw = searchParams.get('focus');
    if (!raw) return;
    if (focusedRef.current === raw) return;
    const id = Number(raw);
    if (!Number.isFinite(id)) return;
    const hit = todos.find((t) => t.id === id);
    if (!hit) return;
    focusedRef.current = raw;
    void openDetail(hit);
  }, [searchParams, todos]);

  const feishu = connectors.find((c) => c.id === 'feishu');
  const timelineBlocks = getTimelineBlocks(dayPlan?.blocks || []);
  const scheduledBlocks = getScheduledBlocks(dayPlan?.blocks || []);
  const completedCount = overview.filter((i) => i.kind === 'completed').length;
  const totalCheckable = overview.filter((i) => i.kind === 'task' || i.kind === 'completed').length;
  const overviewItemCount = overview.filter((i) => i.kind !== 'activity_summary').length;
  const planWarning = humanizePlanWarning(dayPlan?.warning, Boolean(dayPlan?.unverified));
  const summaries = filtered.filter((i) => i.kind === 'activity_summary');
  const mainItems = filtered.filter((i) => i.kind !== 'activity_summary');
  const receiptBlocks = [...timelineBlocks].sort((a, b) => String(a.startAt || '').localeCompare(String(b.startAt || '')));
  const scheduledMinutes = scheduledBlocks.reduce((sum, block) => sum + Math.max(0, block.minutes || 0), 0);
  const fixedMinutes = receiptBlocks.filter((block) => block.fixed).reduce((sum, block) => sum + Math.max(0, block.minutes || 0), 0);
  const receiptSourceCount = new Set(receiptBlocks.map((block) => block.sourceType)).size;
  const receiptSerial = `LC-${overviewMeta.date.replace(/-/g, '')}-${String(dayPlan?.id || 0).padStart(3, '0')}`;
  const receiptProgressTotal = Math.max(totalCheckable, completedCount);
  return (
    <div className="ui-page todo-v4">
      <div className="ui-page-head">
        <div>
          <div className="ui-page-kicker">T-02 · JOB QUEUE</div>
          <h1>待办智能中枢</h1>
        </div>
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          <ClickSpark className="todo-plan-spark" color="#FFD12E">
            <button className="nb-btn nb-btn--primary" onClick={planToday} disabled={planProgress.running || syncing}>
              {planProgress.running ? '规划中…' : '规划今日排程'}
            </button>
          </ClickSpark>
          <button className="nb-btn nb-btn--ghost" onClick={syncNow} disabled={syncing || syncProgress.running}>
            {syncProgress.running ? '同步中…' : '同步今日数据'}
          </button>
          <button className="nb-btn nb-btn--ghost" onClick={() => setDetailsOpen(true)}>
            运行详情
          </button>
        </div>
      </div>

      <ActionProgress progress={syncProgress.progress} onRetry={syncNow} />
      <ActionProgress progress={planProgress.progress} onRetry={planToday} />

      {error && <div className="ui-alert ui-alert--error">{error}</div>}
      {syncMsg && <div className="ui-receipt" style={{ fontSize: 13 }}>{syncMsg}</div>}

      <div className="todo-connector-grid mb-4">
        {connectors.map((c) => (
          <div key={c.id} className={`todo-connector-card ${c.available && c.lastRoundOk !== false ? '' : 'is-limited'}`}>
            <div className="todo-connector-head">
              <strong>{c.label}</strong>
              <span className={`nb-badge ${c.available ? 'nb-badge--olive' : 'nb-badge--red'}`}>
                {c.statusLabel || (c.available ? '可读' : '不可读')}
              </span>
            </div>
            <div className="todo-connector-count">本轮读取 <b>{c.roundCount ?? c.itemsRead ?? 0}</b></div>
            <div className="todo-connector-time">最近成功 {formatWhen(c.lastSuccessAt || c.lastSyncAt)}</div>
          </div>
        ))}
      </div>

      <div className="todo-primary-grid mb-4">
      <section className="todo-overview-box">
        <div className="todo-module-head">
          <h2 className="ui-module-title"><span className="ui-code">O-01</span>今天总览</h2>
          <div className="todo-module-meta">
            <time dateTime={overviewMeta.date}>{overviewMeta.date}</time>
            <span>{overviewItemCount} 项</span>
          </div>
        </div>
        <div className="todo-filter-groups">
          <div className="todo-filter-set">
            <span className="todo-filter-label">来源</span>
            <div className="todo-filter-row nb-tabs" role="group" aria-label="按来源筛选">
              {(['all', 'things', 'feishu', 'apple_calendar', 'desktop'] as const).map((key) => (
                <button
                  key={key}
                  className={`nb-tab ${sourceFilter === key ? 'nb-tab--active' : ''}`}
                  aria-pressed={sourceFilter === key}
                  onClick={() => setSourceFilter(key)}
                >
                  {key === 'all' ? '全部' : SOURCE_LABEL[key]}
                </button>
              ))}
            </div>
          </div>
          <div className="todo-filter-set">
            <span className="todo-filter-label">状态</span>
            <div className="todo-filter-row nb-tabs" role="group" aria-label="按状态筛选">
              {([
                ['open', '待处理'],
                ['review', '需确认'],
                ['planned', '已排程'],
                ['completed', '已完成'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  className={`nb-tab ${stateFilter === key ? 'nb-tab--active' : ''}`}
                  aria-pressed={stateFilter === key}
                  onClick={() => setStateFilter(key)}
                >
                  {label}{key === 'review' ? ` ${suggestions.length}` : ''}
                </button>
              ))}
            </div>
          </div>
        </div>
        {mainItems.length === 0 && summaries.length === 0 && (
          <p className="todo-overview-empty">今天还没有可展示的事项。先同步今日数据。</p>
        )}
        <div className="todo-overview-list">
          {mainItems.map((item) => (
            <article key={item.stableKey} className="todo-overview-item" style={{ borderLeftColor: SOURCE_COLOR[item.sourceType] || '#111111' }}>
              <span className="todo-source-icon" style={{ color: SOURCE_COLOR[item.sourceType] }}><SourceIcon source={item.sourceType} /></span>
              <span className="todo-source-label">{SOURCE_LABEL[item.sourceType]}</span>
              <strong className="todo-overview-title">{item.title}</strong>
              <span className="todo-overview-state">{overviewStateLabel(item, plannedKeys.has(item.stableKey))}</span>
              <span className="todo-overview-meta">
                <span>{item.startAt ? `${formatHm(item.startAt)}–${formatHm(item.endAt)}` : item.dueAt ? `截止 ${formatHm(item.dueAt) || formatWhen(item.dueAt)}` : '时间待定'}</span>
                {item.estimatedMinutes ? <span>预计 {item.estimatedMinutes} 分钟</span> : null}
                <span>{item.fixed ? '固定事项' : item.schedulable ? '可排程' : item.kind === 'needs_review' ? '需要确认' : '仅记录'}</span>
              </span>
            </article>
          ))}
        </div>
        {summaries.length > 0 && (
          <details className="todo-summary-fold">
            <summary>来源摘要（已处理但不参与排程）</summary>
            <div className="todo-summary-list">
              {summaries.map((item) => (
                <div key={item.stableKey} className="todo-overview-item" style={{ borderLeftColor: SOURCE_COLOR[item.sourceType] }}>
                  <span className="todo-source-icon" style={{ color: SOURCE_COLOR[item.sourceType] }}><SourceIcon source={item.sourceType} /></span>
                  <span className="todo-source-label">{SOURCE_LABEL[item.sourceType]}</span>
                  <span className="todo-overview-title">{item.title}</span>
                  <span className="todo-overview-state">仅记录</span>
                  <span className="todo-overview-meta"><span>已处理</span><span>不参与排程</span></span>
                </div>
              ))}
            </div>
          </details>
        )}
      </section>

      <section ref={receiptSectionRef} className="todo-journal">
        <div className="todo-module-head">
          <h2 className="ui-module-title"><span className="ui-code">P-01</span>今日排程</h2>
          <div className="todo-module-head-actions">
            <span className="todo-plan-count">{dayPlan ? `${scheduledBlocks.length} 项已排入` : '等待规划'}</span>
            {dayPlan && scheduledBlocks.length > 0 && (
              <button className="todo-replay-print" type="button" onClick={startReceiptPrintAnimation} disabled={receiptPrinting}>
                {receiptPrinting ? '出票中…' : '重播出票'}
              </button>
            )}
          </div>
        </div>
        <div className="todo-journal-content">
          {!dayPlan && (
            <div className="todo-plan-prompt">
              <strong>还没有今日排程</strong>
              <span>点击右上角「规划今日排程」，生成只保存在本地的手账草稿。</span>
            </div>
          )}

          {dayPlan && planWarning && <div className="todo-journal-warn">{planWarning}</div>}

          {dayPlan?.planner && (
            <div className="todo-ai-plan-note" aria-label="AI 今日规划摘要">
              <div>
                <Sparkles width={18} height={18} aria-hidden="true" />
                <strong>AI 今日聚焦 {dayPlan.planner.selectedCount}/{dayPlan.planner.candidateCount}</strong>
                <span>最多 5 件 · 固定日程另计</span>
              </div>
              <p>{dayPlan.planner.planSummary}</p>
            </div>
          )}

          {dayPlan && scheduledBlocks.length === 0 && (
            <div className="todo-plan-empty" role="status">
              <strong>本轮没有事项排入今日时间轴</strong>
              <span>{dayPlan.unscheduled.length} 项需要改期、缩短时长或调整工作时间</span>
            </div>
          )}

          {dayPlan && scheduledBlocks.length > 0 && (
            <div className="todo-receipt-stage">
              <div className={`todo-receipt-printer${receiptPrinting ? ' is-printing' : ' is-done'}`} role="status">
                <img src={obsidianPrinter} alt="" aria-hidden="true" className="todo-receipt-printer-asset" />
                <span className="todo-receipt-printer-led" aria-hidden="true" />
                <div className="todo-receipt-printer-progress" aria-hidden="true"><i /></div>
                <span className="sr-only">{receiptPrinting ? '正在打印今日排程' : '今日排程打印完成，本地草稿'}</span>
              </div>
              <div className="todo-receipt-output">
                <div
                  key={`${dayPlan.id}-${receiptPrintKey}`}
                  className={`todo-receipt-feed${receiptPrintKey > 0 ? ' is-printing' : ''}`}
                >
                  <article
                    className={`todo-receipt${receiptPrinting ? ' is-feeding' : ''}`}
                    aria-label={`${overviewMeta.date} 今日排程小票`}
                  >
                <header className="todo-receipt-hero">
                  <div className="todo-receipt-brand">
                    <img src={lshuAvatar} alt="" aria-hidden="true" />
                    <div>
                      <span className="todo-receipt-eyebrow">L叔 · LOCAL COMMAND</span>
                      <h3>今日，做出点名堂</h3>
                      <p>DAILY ROUTE RECEIPT / 今日作战小票</p>
                    </div>
                  </div>
                  <div className="todo-receipt-seal" aria-label="本地排程草稿">
                    <Receipt width={24} height={24} aria-hidden="true" />
                    <b>LOCAL DRAFT</b>
                    <span>{receiptSerial}</span>
                  </div>
                </header>

                <div className="todo-receipt-facts" aria-label="排程概览">
                  <span><small>DATE</small><b>{overviewMeta.date}</b></span>
                  <span><small>DAY</small><b>{weekdayLabel(overviewMeta.date)}</b></span>
                  <span><small>ROUTES</small><b>{scheduledBlocks.length} 项</b></span>
                  <span><small>SOURCES</small><b>{receiptSourceCount} 个</b></span>
                </div>

                <div className="todo-receipt-section-title">
                  <span>NO.</span><span>TIME</span><strong>TODAY ROUTE</strong><span>MIN / STATE</span>
                </div>

                <ol className="todo-receipt-routes">
                  {receiptBlocks.map((block, index) => (
                    <li
                      key={`${block.stableKey}-${block.startAt}`}
                      className={`${block.fixed ? 'is-fixed' : ''}${block.kind === 'completed' ? ' is-completed' : ''}`}
                      style={{
                        borderLeftColor: SOURCE_COLOR[block.sourceType] || '#111111',
                      }}
                    >
                      <span className="todo-receipt-route-no">{String(index + 1).padStart(2, '0')}</span>
                      <time className="todo-receipt-route-time" dateTime={block.startAt || undefined}>
                        <b>{formatHm(block.startAt)}</b>
                        <span>{formatHm(block.endAt)}</span>
                      </time>
                      <span className="todo-receipt-route-main">
                        <span className="todo-receipt-route-source" style={{ color: SOURCE_COLOR[block.sourceType] || '#111111' }}>
                          <SourceIcon source={block.sourceType} />
                          {SOURCE_LABEL[block.sourceType] || block.sourceType}
                        </span>
                        <strong title={block.title}>{block.title}</strong>
                      </span>
                      <span className="todo-receipt-route-state">
                        <b>{block.minutes || 0} MIN</b>
                        <span>{block.fixed ? 'FIXED · 固定' : block.kind === 'completed' ? 'DONE · 完成' : 'PLANNED · 已排入'}</span>
                      </span>
                    </li>
                  ))}
                </ol>

                <div className="todo-receipt-totals">
                  <span><small>SCHEDULED</small><b>{scheduledMinutes} MIN</b></span>
                  <span><small>FIXED</small><b>{fixedMinutes} MIN</b></span>
                  <span><small>UNSCHEDULED</small><b>{dayPlan.unscheduled.length} ITEMS</b></span>
                </div>

                <footer className="todo-receipt-footer">
                  <div className="todo-receipt-motto">
                    <Sparkles width={20} height={20} aria-hidden="true" />
                    <div>
                      <strong>{dayPlan.planner?.dailyMessage || '今天先把最重要的事做好'}</strong>
                      <span>AI DAILY NOTE · DEEPSEEK</span>
                    </div>
                  </div>
                  <div className="todo-receipt-barcode" aria-label={`排程编号 ${receiptSerial}`}>
                    <Barcode width={88} height={34} aria-hidden="true" />
                    <span>{receiptSerial}</span>
                  </div>
                </footer>

                <div className="todo-receipt-stamp" aria-label={`今日完成 ${completedCount}/${receiptProgressTotal}`}>
                  <Check width={18} height={18} aria-hidden="true" />
                  今日完成 {completedCount}/{receiptProgressTotal}
                </div>
                  </article>
                </div>
              </div>
            </div>
          )}

          {(dayPlan?.unscheduled.length || 0) > 0 && (
            <div className="todo-unscheduled">
              <h3>今日未排入</h3>
              <div className="todo-unscheduled-list">
                {dayPlan?.unscheduled.map((u) => (
                  <div key={`${u.stableKey || u.title}`} className="todo-unscheduled-item">
                    <strong>{u.title}</strong>
                    <span>{humanizeUnscheduled(u.reason, u.suggestion)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
      </div>

      {detailsOpen && (
        <div className="todo-drawer-mask" onClick={() => setDetailsOpen(false)}>
          <aside className="todo-drawer todo-run-drawer" role="dialog" aria-modal="true" aria-labelledby="todo-run-drawer-title" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <div>
                <div className="drawer-kicker">R-01 · RUNTIME</div>
                <h2 className="drawer-title" id="todo-run-drawer-title">运行详情</h2>
              </div>
              <button className="nb-btn drawer-close" onClick={() => setDetailsOpen(false)} aria-label="关闭运行详情">关闭</button>
            </div>

            <div className="todo-run-drawer-body">
              <section className="todo-run-section">
                <h3>来源回执</h3>
                <div className="todo-run-connectors">
                  {connectors.map((c) => (
                    <div key={c.id} className="todo-run-connector">
                      <div><strong>{c.label}</strong><span>{c.statusLabel || (c.available ? '可读' : '不可读')}</span></div>
                      <p>本轮 {c.roundCount ?? c.itemsRead ?? 0} · 上次成功 {c.lastSuccessCount ?? 0}</p>
                      <p>最近成功 {formatWhen(c.lastSuccessAt || c.lastSyncAt)}</p>
                      {c.usingStaleSnapshot && <p>使用旧快照，本轮未读入</p>}
                      {c.id === 'feishu' && <p>{c.hasCurrentUserId ? '已识别当前用户' : '未识别当前用户'}</p>}
                      {c.lastError && <p className="todo-run-code">{c.lastError}</p>}
                    </div>
                  ))}
                </div>
              </section>

              <section className="todo-run-section">
                <h3>自动化开关</h3>
                <label className="todo-switch">
                  <input
                    type="checkbox"
                    checked={Boolean(settings?.autoScheduleEnabled)}
                    onChange={(e) => saveFlags({ autoScheduleEnabled: e.target.checked })}
                  />
                  自动排程（默认关，不能绕过确认写入）
                </label>
              </section>

              <section className="todo-run-section">
                <h3>权限与覆盖</h3>
                {agendaIssue ? <div className="ui-alert ui-alert--error">Apple Calendar：{agendaIssue}</div> : <p className="nb-muted">Apple Calendar 未报告覆盖错误。</p>}
                {feishuCoverageIssue && <div className="ui-alert">{feishuCoverageIssue}</div>}
                {feishu && !feishu.lastRoundOk && <div className="ui-alert">飞书本轮 0，状态 {feishu.statusLabel || '不可读'}</div>}
              </section>

              {aiStatus && (
                <section className="todo-run-section">
                  <h3>DeepSeek 分析</h3>
                  <div className="todo-run-metrics">
                    <span>飞书输入 <b>{aiStatus.feishuInputCount ?? 0}</b></span>
                    <span>桌面输入 <b>{aiStatus.desktopInputCount ?? 0}</b></span>
                    <span>分析单元 <b>{aiStatus.inputUnits}</b></span>
                    <span>缓存 <b>{aiStatus.cacheHits}</b></span>
                    <span>HTTP <b>{aiStatus.httpAttempts || aiStatus.calls}</b></span>
                    <span>Schema 成功 <b>{aiStatus.schemaSuccess ?? 0}</b></span>
                    <span>明确行动 <b>{aiStatus.actionable}</b></span>
                    <span>待确认 <b>{suggestions.length}</b></span>
                    <span>非行动 <b>{aiStatus.rejected}</b></span>
                    <span>延后 <b>{aiStatus.deferred}</b></span>
                  </div>
                  <p className="todo-run-code">溢出 {aiStatus.deferredReasons?.overflow ?? aiStatus.deferredByOverflow ?? 0} / 格式 {aiStatus.deferredReasons?.schema ?? aiStatus.deferredBySchema ?? 0}</p>
                  <p>{formatAiRunSummary(aiStatus)}</p>
                  <p>最近运行 {formatAiTime(aiStatus.startedAt)}</p>
                  {aiErrorLabel(aiStatus.errorCode) ? <p className="todo-run-code">{aiErrorLabel(aiStatus.errorCode)}</p> : null}
                </section>
              )}

              {dayPlan && (
                <section className="todo-run-section todo-write-box">
                  <h3>排程草稿与写入</h3>
                  <p>{dayPlan.copy.draft}</p>
                  {dayPlan.planner && (
                    <details className="todo-run-raw">
                      <summary>AI 今日选择依据</summary>
                      <p>{dayPlan.planner.profileSummary}</p>
                      <p>{dayPlan.planner.planSummary}</p>
                      {dayPlan.planner.selections.map((selection) => (
                        <p key={selection.stableKey}>
                          {selection.rank}. {selection.reason} · {selection.estimatedMinutes} 分钟 · {selection.preferredWindow}
                        </p>
                      ))}
                    </details>
                  )}
                  {commitPreview && (
                    <ul>
                      <li>将写入 {commitPreview.blockCount} 个时间块</li>
                      <li>日期 {commitPreview.date}{commitPreview.range.startAt ? ` · ${formatWhen(commitPreview.range.startAt)} → ${formatWhen(commitPreview.range.endAt)}` : ''}</li>
                      <li>目标日历：{commitPreview.targetCalendar}</li>
                      <li>不会修改 {commitPreview.willNotModify.join('、')}</li>
                    </ul>
                  )}
                  {(dayPlan.unscheduled.length || 0) > 0 && (
                    <details className="todo-run-raw">
                      <summary>查看内部未排入原因</summary>
                      {dayPlan.unscheduled.map((entry) => (
                        <p key={`${entry.stableKey || entry.title}-raw`} className="todo-run-code">{entry.title} · {entry.reason} · {entry.suggestion}</p>
                      ))}
                    </details>
                  )}
                  <button className="nb-btn nb-btn--ghost" onClick={confirmWrite}>确认写入「L叔工作台」日历</button>
                  {writeNote && <p className="nb-muted">{writeNote}</p>}
                </section>
              )}

              <button className="nb-btn nb-btn--ghost" onClick={async () => {
                const p = await api.previewProductivitySync();
                setSyncMsg(p.receipt || `预览 ${p.itemsSeen} 条（不写入）`);
              }}>预览同步变化</button>
            </div>
          </aside>
        </div>
      )}

      {selected && (
        <div className="todo-drawer-mask" onClick={() => setSelected(null)}>
          <aside className="todo-drawer" role="dialog" aria-modal="true" aria-labelledby="todo-drawer-title" onClick={(e) => e.stopPropagation()}>
            <h2 className="nb-section-title" id="todo-drawer-title" style={{ fontSize: 22 }}>{selected.title}</h2>
            <p className="nb-muted" style={{ fontSize: 13 }}>为什么生成：{selected.reason || '—'}</p>
            <div className="flex gap-2 mt-2" style={{ flexWrap: 'wrap' }}>
              <span className="nb-badge">{SOURCE_LABEL[selected.sourceType || 'desktop']}</span>
              <span className="nb-badge">{lifecycleOf(selected)}</span>
            </div>
            <label className="setting-label">预计时长（分钟）</label>
            {selected.sourceReadonly ? (
              <p className="nb-muted">请在 Things 中完成或改期。工作台只提供本地隐藏。</p>
            ) : (
              <>
                <input className="nb-input" value={editMinutes} onChange={(e) => setEditMinutes(e.target.value)} />
                <label className="setting-label">截止时间</label>
                <input className="nb-input" type="datetime-local" value={editDue} onChange={(e) => setEditDue(e.target.value)} />
                <button
                  className="nb-btn nb-btn--ghost"
                  style={{ marginTop: 8 }}
                  onClick={async () => {
                    await api.editTodo(selected.id, {
                      title: selected.title,
                      estimatedMinutes: Number(editMinutes) || 60,
                      dueAt: editDue ? new Date(editDue).toISOString() : null,
                    });
                    await refreshAfterWrite();
                  }}
                >
                  保存时长与截止时间
                </button>
              </>
            )}
            <h3 style={{ marginTop: 18 }}>来源证据</h3>
            <div className="todo-evidence-list">
              {evidence.length === 0 && <div className="nb-muted">还没有证据。</div>}
              {evidence.map((ev) => (
                <div key={ev.id} className="todo-evidence">
                  <b>{ev.evidence_type}</b>
                  <span>{ev.summary}</span>
                  <em>{formatWhen(ev.occurred_at)}</em>
                </div>
              ))}
            </div>
            <ActionProgress progress={itemPlanProgress.progress} />
            <div className="flex gap-2 mt-4" style={{ flexWrap: 'wrap' }}>
              {selected.status === 'pending' && (
                <button className="nb-btn nb-btn--primary" onClick={async () => { await api.confirmTodo(selected.id); await refreshAfterWrite(); setSelected(null); }}>确认</button>
              )}
              {lifecycleOf(selected) !== 'completed' && !selected.sourceReadonly && (
                <button className="nb-btn nb-btn--ghost" onClick={async () => { await api.completeTodo(selected.id); await refreshAfterWrite(); setSelected(null); }}>确认完成</button>
              )}
              {lifecycleOf(selected) === 'completed' && (
                <button className="nb-btn" onClick={async () => { await api.reopenTodo(selected.id); await refreshAfterWrite(); setSelected(null); }}>撤销完成</button>
              )}
              <button className="nb-btn nb-btn--ghost" onClick={async () => { await api.ignoreTodo(selected.id); await refreshAfterWrite(); setSelected(null); }}>忽略</button>
              <button className="nb-btn nb-btn--ghost" onClick={() => setSelected(null)}>关闭</button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
