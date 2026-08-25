import { getSettings, getTodos, productivity, type TodoRow } from '../db';
import { loadAgendaViews, resolveTimeZone } from './agendaService';
import { busyRevisionOf, localDateKey, localDayBounds, overviewRevisionOf, sanitizeOccurredAt } from './localDay';
import {
  areSemanticallyEquivalentActions,
  normalizeActionDue,
  normalizeActionObject,
} from './actionIdentity';
import { normalizeTitle } from './hash';

export type TodayOverviewKind = 'task' | 'fixed_event' | 'needs_review' | 'activity_summary' | 'completed';
export type TodayOverviewSource = 'things' | 'feishu' | 'apple_calendar' | 'desktop' | 'workbench';

export interface TodayOverviewItem {
  stableKey: string;
  sourceType: TodayOverviewSource;
  kind: TodayOverviewKind;
  title: string;
  startAt?: string;
  endAt?: string;
  dueAt?: string;
  estimatedMinutes?: number;
  readonly: boolean;
  fixed: boolean;
  schedulable: boolean;
  confidence?: number;
  evidenceCount: number;
  state: string;
  todoId?: number;
  occurredAt?: string;
}

export interface TodayOverviewResult {
  date: string;
  timezone: string;
  from: string;
  to: string;
  revision: string;
  busyRevision: string;
  items: TodayOverviewItem[];
  counts: {
    tasks: number;
    fixedEvents: number;
    needsReview: number;
    summaries: number;
    completed: number;
  };
}

interface SemanticOverviewMeta {
  source: TodayOverviewSource;
  sourceLocalDate: string;
  owner: string;
  due: string;
  project: string;
  title: string;
}

function mapSource(raw: string | undefined): TodayOverviewSource | null {
  if (raw === 'things') return 'things';
  if (raw === 'feishu_message' || raw === 'feishu') return 'feishu';
  if (raw === 'desktop') return 'desktop';
  if (raw === 'feishu_calendar') return 'feishu';
  if (raw === 'manual') return 'workbench';
  return null;
}

function visibilityOf(row: TodoRow): string {
  return row.visibility || 'visible';
}

function lifecycleOf(row: TodoRow): string {
  return row.lifecycle_status || (row.status === 'confirmed' ? 'confirmed' : row.status === 'ignored' ? 'ignored' : 'candidate');
}

function isLegacyCandidate(row: TodoRow): boolean {
  const origin = row.origin_mode || 'legacy';
  const life = lifecycleOf(row);
  return origin === 'legacy' && (row.status === 'pending' || life === 'candidate');
}

function isCurrentThingsTodayMirror(row: TodoRow): boolean {
  return row.source_type === 'things'
    && row.origin_mode === 'structured'
    && row.source_scope === 'things_today';
}

export function queryTodayOverview(options: { date?: string; timezone?: string; now?: Date } = {}): TodayOverviewResult {
  const timezone = options.timezone && options.timezone.trim()
    ? resolveTimeZone(options.timezone)
    : resolveTimeZone(String(getSettings().timezone || '') || undefined);
  const now = options.now || new Date();
  const date = options.date || localDateKey(now, timezone)!;
  const bounds = localDayBounds(date, timezone);
  const fromMs = bounds.start.getTime();
  const toMs = bounds.end.getTime();
  const items: TodayOverviewItem[] = [];
  const semanticMeta = new Map<string, SemanticOverviewMeta>();
  const todoRows = getTodos();
  const evidenceCounts = productivity.getEvidenceCounts(todoRows.map((row) => row.id));

  for (const row of todoRows) {
    if (visibilityOf(row) === 'hidden_local') continue;
    const source = mapSource(row.source_type);
    if (!source) continue;
    // Things is a direct mirror of the connector's current「今天」scope. Older
    // legacy rows (including pre-scope rows with source_scope=NULL) remain in
    // SQLite for audit/history, but must never inflate today's overview.
    if (row.source_type === 'things' && !isCurrentThingsTodayMirror(row)) continue;
    if (isLegacyCandidate(row)) continue;
    const life = lifecycleOf(row);
    if (life === 'ignored' || life === 'canceled' || row.status === 'ignored') continue;
    if (row.source_status === 'canceled' || row.source_status === 'out_of_scope' || row.source_status === 'missing') continue;

    if (row.source_type === 'things') {
      const completed = life === 'completed' || row.source_status === 'completed';
      items.push({
        stableKey: `things:${row.source_external_id || row.id}`,
        sourceType: 'things',
        kind: completed ? 'completed' : 'task',
        title: row.title,
        dueAt: row.due_at || undefined,
        estimatedMinutes: row.estimated_minutes || 45,
        readonly: true,
        fixed: false,
        schedulable: !completed,
        evidenceCount: 1,
        state: completed ? 'completed' : life,
        todoId: row.id,
        occurredAt: row.source_occurred_at || row.last_seen_at || undefined,
      });
      continue;
    }

    const occurred = sanitizeOccurredAt(row.source_occurred_at);
    const occurredKey = localDateKey(occurred, timezone);
    const dueKey = localDateKey(row.due_at, timezone);
    const plannedKey = localDateKey(row.planned_start_at, timezone);
    const completedKey = localDateKey(row.completed_at, timezone);
    const overdue = Boolean(row.due_at) && Date.parse(String(row.due_at)) < fromMs && life !== 'completed';
    const inToday = occurredKey === date || dueKey === date || plannedKey === date || completedKey === date || overdue;
    if (!inToday) continue;
    if ((row.origin_mode === 'ai' || source === 'feishu' || source === 'desktop') && (life === 'candidate' || row.status === 'pending')) {
      const stableKey = `todo:${row.id}`;
      items.push({
        stableKey,
        sourceType: source,
        kind: 'task',
        title: row.title,
        dueAt: row.due_at || undefined,
        estimatedMinutes: row.estimated_minutes || 45,
        readonly: row.source_readonly === 1,
        fixed: false,
        schedulable: false,
        confidence: row.inference_confidence ?? undefined,
        evidenceCount: Math.max(1, evidenceCounts.get(row.id) || 0),
        state: 'pending',
        todoId: row.id,
        occurredAt: occurred || undefined,
      });
      if (row.origin_mode === 'ai' && (source === 'feishu' || source === 'desktop')) {
        semanticMeta.set(stableKey, {
          source,
          sourceLocalDate: occurredKey || date,
          owner: row.action_owner || 'legacy-self',
          due: normalizeActionDue(row.due_at),
          project: normalizeTitle(row.cluster || ''),
          title: row.title,
        });
      }
      continue;
    }

    const completed = life === 'completed';
    const confirmed = life === 'confirmed' || life === 'planned' || life === 'in_progress' || life === 'suspected_done';
    const stableKey = `todo:${row.id}`;
    items.push({
      stableKey,
      sourceType: source,
      kind: completed ? 'completed' : 'task',
      title: row.title,
      startAt: row.planned_start_at || undefined,
      endAt: row.planned_end_at || undefined,
      dueAt: row.due_at || undefined,
      estimatedMinutes: row.estimated_minutes || 45,
      readonly: row.source_readonly === 1,
      fixed: false,
      schedulable: !completed && confirmed,
      confidence: row.inference_confidence ?? undefined,
      evidenceCount: Math.max(1, evidenceCounts.get(row.id) || 0),
      state: completed ? 'completed' : life,
      todoId: row.id,
      occurredAt: occurred || undefined,
    });
    if (row.origin_mode === 'ai' && (source === 'feishu' || source === 'desktop')) {
      semanticMeta.set(stableKey, {
        source,
        sourceLocalDate: occurredKey || date,
        owner: row.action_owner || 'legacy-self',
        due: normalizeActionDue(row.due_at),
        project: normalizeTitle(row.cluster || ''),
        title: row.title,
      });
    }
  }

  for (const ev of loadAgendaViews(bounds.start.toISOString(), bounds.end.toISOString())) {
    const start = Date.parse(ev.startAt);
    const end = Date.parse(ev.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < toMs && end > fromMs)) continue;
    const source: TodayOverviewSource = ev.ownedByWorkbench ? 'workbench' : ev.provider === 'feishu' ? 'feishu' : 'apple_calendar';
    items.push({
      stableKey: `cal:${ev.canonicalEventKey}`,
      sourceType: source,
      kind: 'fixed_event',
      title: ev.title || '未命名日程',
      startAt: ev.startAt,
      endAt: ev.endAt,
      readonly: true,
      fixed: true,
      schedulable: false,
      evidenceCount: 1,
      state: 'fixed',
    });
  }

  for (const row of productivity.listSuggestions()) {
    const occurred = sanitizeOccurredAt(row.source_occurred_at as string | null);
    if (localDateKey(occurred, timezone) !== date) continue;
    const source = mapSource(String(row.source_type || '')) || 'feishu';
    items.push({
      stableKey: `suggestion:${row.id}`,
      sourceType: source,
      kind: 'needs_review',
      title: String(row.title || '待确认行动'),
      readonly: true,
      fixed: false,
      schedulable: false,
      confidence: Number(row.confidence || 0),
      evidenceCount: 1,
      state: 'needs_review',
      occurredAt: occurred || undefined,
    });
  }

  const outcomes = productivity.listUnitOutcomesForDate(date);
  const bySource = new Map<string, { read: number; actions: number }>();
  for (const row of outcomes) {
    const source = mapSource(String(row.source_type || '')) || 'desktop';
    const bucket = bySource.get(source) || { read: 0, actions: 0 };
    bucket.read += 1;
    if (String(row.decision) === 'actionable' || String(row.decision) === 'uncertain') bucket.actions += 1;
    bySource.set(source, bucket);
  }
  for (const [source, bucket] of bySource) {
    if (source !== 'feishu' && source !== 'desktop') continue;
    items.push({
      stableKey: `summary:${source}:${date}`,
      sourceType: source,
      kind: 'activity_summary',
      title: `${source === 'feishu' ? '飞书' : '桌面'}已读取 ${bucket.read}，识别 ${bucket.actions} 个行动`,
      readonly: true,
      fixed: false,
      schedulable: false,
      evidenceCount: bucket.read,
      state: 'summary',
    });
  }

  const seen = new Set<string>();
  const stableDeduped = items.filter((item) => {
    if (seen.has(item.stableKey)) return false;
    seen.add(item.stableKey);
    return true;
  });
  const deduped: TodayOverviewItem[] = [];
  for (const item of stableDeduped) {
    const meta = semanticMeta.get(item.stableKey);
    if (!meta) {
      deduped.push(item);
      continue;
    }
    const duplicateIndex = deduped.findIndex((prior) => {
      const priorMeta = semanticMeta.get(prior.stableKey);
      return Boolean(
        priorMeta
        && priorMeta.source === meta.source
        && priorMeta.sourceLocalDate === meta.sourceLocalDate
        && priorMeta.owner === meta.owner
        && priorMeta.due === meta.due
        && priorMeta.project === meta.project
        && areSemanticallyEquivalentActions(priorMeta.title, meta.title)
      );
    });
    if (duplicateIndex < 0) {
      deduped.push(item);
      continue;
    }
    const prior = deduped[duplicateIndex];
    const combinedEvidence = prior.evidenceCount + item.evidenceCount;
    const priorScore = prior.evidenceCount * 1000 + normalizeActionObject(prior.title).length;
    const itemScore = item.evidenceCount * 1000 + normalizeActionObject(item.title).length;
    deduped[duplicateIndex] = {
      ...(itemScore > priorScore ? item : prior),
      evidenceCount: combinedEvidence,
    };
  }

  const busy = loadAgendaViews(bounds.start.toISOString(), bounds.end.toISOString())
    .filter((ev) => Date.parse(ev.startAt) < toMs && Date.parse(ev.endAt) > fromMs)
    .map((ev) => ({ startAt: ev.startAt, endAt: ev.endAt, source: ev.provider }));

  return {
    date,
    timezone,
    from: bounds.start.toISOString(),
    to: bounds.end.toISOString(),
    revision: overviewRevisionOf(deduped),
    busyRevision: busyRevisionOf(busy),
    items: deduped,
    counts: {
      tasks: deduped.filter((i) => i.kind === 'task').length,
      fixedEvents: deduped.filter((i) => i.kind === 'fixed_event').length,
      needsReview: deduped.filter((i) => i.kind === 'needs_review').length,
      summaries: deduped.filter((i) => i.kind === 'activity_summary').length,
      completed: deduped.filter((i) => i.kind === 'completed').length,
    },
  };
}
