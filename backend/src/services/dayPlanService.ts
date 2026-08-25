import { getSettings } from '../db';
import { productivity } from '../db';
import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from '../connectors/errors';
import { WORKBENCH_CALENDAR_NAME } from '../connectors/types';
import { resolveTimeZone, todayPlanningBusy } from './agendaService';
import { busyRevisionOf, localDateKey, zonedParts } from './localDay';
import { DEFAULT_PLANNING_RULES, planTodos, type PlanResult } from './planning';
import { commitSync, type SyncDeps } from './productivitySync';
import { queryTodayOverview, type TodayOverviewItem, type TodayOverviewResult } from './todayOverview';
import { selectTodayFocusWithAi, type AiDayPlannerResult } from './aiDayPlanner';
import type { FetchLike } from './deepseekClient';

export interface DayPlanBlockDto {
  stableKey: string;
  todoId?: number | null;
  title: string;
  startAt?: string | null;
  endAt?: string | null;
  sourceType: string;
  kind: string;
  fixed: boolean;
  schedulable: boolean;
  minutes: number;
  unscheduled: boolean;
  reason?: string | null;
}

export interface DayPlanDto {
  id: number;
  date: string;
  timezone: string;
  status: string;
  overviewRevision: string;
  busyRevision: string;
  warning: string | null;
  unverified: boolean;
  strategy: 'ai' | 'manual';
  planner: AiDayPlannerResult | null;
  write: false;
  targetCalendar: string;
  blocks: DayPlanBlockDto[];
  unscheduled: Array<{ title: string; reason: string; suggestion: string; stableKey?: string }>;
  copy: {
    draft: string;
    commitPreview: string;
  };
}

function parsePlannerMeta(raw: unknown): AiDayPlannerResult | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as AiDayPlannerResult).selections)) return null;
    return parsed as AiDayPlannerResult;
  } catch {
    return null;
  }
}

function parseJsonArray(raw: unknown): Array<{ title: string; reason: string; suggestion: string; stableKey?: string }> {
  if (Array.isArray(raw)) return raw as Array<{ title: string; reason: string; suggestion: string; stableKey?: string }>;
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapPlanRow(row: Record<string, unknown>, blocks: Array<Record<string, unknown>>): DayPlanDto {
  const unscheduled = parseJsonArray(row.unscheduled_json);
  return {
    id: Number(row.id),
    date: String(row.local_date),
    timezone: String(row.timezone),
    status: String(row.status),
    overviewRevision: String(row.overview_revision),
    busyRevision: String(row.busy_revision),
    warning: row.warning ? String(row.warning) : null,
    unverified: Number(row.unverified) === 1,
    strategy: row.strategy === 'ai' ? 'ai' : 'manual',
    planner: parsePlannerMeta(row.planner_meta_json),
    write: false,
    targetCalendar: WORKBENCH_CALENDAR_NAME,
    blocks: blocks.map((b) => ({
      stableKey: String(b.stable_key),
      todoId: b.todo_id == null ? null : Number(b.todo_id),
      title: String(b.title),
      startAt: String(b.start_at || '') || null,
      endAt: String(b.end_at || '') || null,
      sourceType: String(b.source_type),
      kind: String(b.kind),
      fixed: Number(b.fixed) === 1,
      schedulable: Number(b.schedulable) === 1,
      minutes: Number(b.minutes || 0),
      unscheduled: Number(b.unscheduled) === 1,
      reason: b.reason ? String(b.reason) : null,
    })),
    unscheduled,
    copy: {
      draft: '草稿尚未写入日历',
      commitPreview: `将写入工作台日历「${WORKBENCH_CALENDAR_NAME}」，不会修改 Things、飞书消息或 Apple 原有事件`,
    },
  };
}

export function getTodayDayPlan(options: { date?: string; timezone?: string; now?: Date } = {}): DayPlanDto | null {
  const timezone = options.timezone ? resolveTimeZone(options.timezone) : resolveTimeZone(String(getSettings().timezone || '') || undefined);
  const date = options.date || localDateKey(options.now || new Date(), timezone)!;
  const row = productivity.getDayPlan(date, timezone);
  if (!row) return null;
  const overview = queryTodayOverview({ date, timezone, now: options.now });
  const busy = todayPlanningBusy(overview.from, overview.to, timezone);
  let status = String(row.status);
  if (status === 'draft' && (String(row.overview_revision) !== overview.revision || String(row.busy_revision) !== busyRevisionOf(busy.busy))) {
    productivity.markDayPlanStale(Number(row.id));
    status = 'stale';
  }
  return mapPlanRow({ ...row, status }, productivity.listDayPlanBlocks(Number(row.id)));
}

function isFreshForDate(date: string, timezone: string): boolean {
  const settings = getSettings();
  const parse = (raw?: string | null) => {
    try {
      const parsed = JSON.parse(raw || '{}');
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };
  const roundDayOf = (connector: string) => {
    const cp = productivity.getCheckpoint(connector);
    const cfg = parse(cp?.config_json);
    return localDateKey(String(cfg.lastRoundAt || cp?.last_success_at || ''), timezone);
  };
  if (settings.thingsEnabled !== false && roundDayOf('things') !== date) return false;
  if (settings.desktopEnabled !== false && roundDayOf('desktop') !== date) return false;
  if (settings.feishuEnabled !== false && roundDayOf('feishu') !== date) return false;
  if (settings.calendarEnabled !== false && roundDayOf('calendar') !== date) return false;
  return true;
}

function emptyReason(now: Date, timezone: string, rules = DEFAULT_PLANNING_RULES): string {
  const p = zonedParts(now, timezone);
  if (!rules.workDays.includes(p.weekday)) return 'WEEKEND';
  const [endH, endM] = rules.workEnd.split(':').map((x) => parseInt(x, 10));
  if (p.hh * 60 + p.mm >= (endH || 0) * 60 + (endM || 0)) return 'AFTER_HOURS';
  return 'NO_AVAILABLE_SLOT';
}

export async function createTodayDayPlan(options: {
  date?: string;
  timezone?: string;
  now?: Date;
  syncIfStale?: boolean;
  deps?: SyncDeps;
  mode?: 'ai' | 'manual';
  fetchImpl?: FetchLike;
} = {}): Promise<DayPlanDto> {
  const timezone = options.timezone ? resolveTimeZone(options.timezone) : resolveTimeZone(String(getSettings().timezone || '') || undefined);
  const now = options.now || new Date();
  const date = options.date || localDateKey(now, timezone)!;
  if (options.syncIfStale !== false && !isFreshForDate(date, timezone)) {
    await commitSync(options.deps);
  }
  const overview = queryTodayOverview({ date, timezone, now });
  const busyState = todayPlanningBusy(overview.from, overview.to, timezone);
  const schedulable = overview.items.filter((item) => item.kind === 'task' && item.schedulable && item.state !== 'completed');
  const mode = options.mode || 'manual';
  const planner = mode === 'ai'
    ? await selectTodayFocusWithAi({ candidates: overview.items, date, timezone, now, fetchImpl: options.fetchImpl })
    : null;
  const selectedByKey = new Map((planner?.selections || []).map((selection) => [selection.stableKey, selection]));
  const focusItems = planner
    ? schedulable.filter((item) => selectedByKey.has(item.stableKey))
    : schedulable;
  const rules = { ...DEFAULT_PLANNING_RULES, timezone };
  const planned: PlanResult = planTodos(
    focusItems.map((item) => {
      const selection = selectedByKey.get(item.stableKey);
      return {
      id: item.todoId,
      title: item.title,
      estimatedMinutes: selection?.estimatedMinutes || item.estimatedMinutes || 45,
      priority: 'medium',
      dueAt: item.dueAt,
      rank: selection?.rank,
      preferredWindow: selection?.preferredWindow,
    };
    }),
    busyState.busy,
    rules,
    now,
    now
  );
  const fallbackReason = emptyReason(now, timezone, rules);
  const placedKeys = new Set<string>();
  const blocks: DayPlanBlockDto[] = [];

  for (const item of overview.items.filter((i) => i.kind === 'fixed_event')) {
    blocks.push({
      stableKey: item.stableKey,
      todoId: item.todoId ?? null,
      title: item.title,
      startAt: item.startAt || null,
      endAt: item.endAt || null,
      sourceType: item.sourceType,
      kind: item.kind,
      fixed: true,
      schedulable: false,
      minutes: item.startAt && item.endAt ? Math.max(0, Math.round((Date.parse(item.endAt) - Date.parse(item.startAt)) / 60000)) : 0,
      unscheduled: false,
    });
  }

  for (const block of planned.blocks) {
    const item = focusItems.find((s) => s.todoId === block.todoId && !placedKeys.has(`${s.stableKey}:${block.startAt}`))
      || focusItems.find((s) => s.title === block.title);
    const stableKey = item?.stableKey || `task:${block.title}:${block.startAt}`;
    placedKeys.add(`${stableKey}:${block.startAt}`);
    blocks.push({
      stableKey,
      todoId: block.todoId ?? item?.todoId ?? null,
      title: block.title,
      startAt: block.startAt,
      endAt: block.endAt,
      sourceType: item?.sourceType || 'workbench',
      kind: 'task',
      fixed: false,
      schedulable: true,
      minutes: block.minutes,
      unscheduled: false,
    });
  }

  const unscheduled = planned.unscheduled.map((u) => {
    const item = focusItems.find((s) => s.title === u.title);
    return {
      title: u.title,
      reason: u.reason === 'NO_AVAILABLE_SLOT' ? fallbackReason : u.reason,
      suggestion: u.suggestion,
      stableKey: item?.stableKey,
    };
  });
  if (planner) {
    for (const item of schedulable) {
      if (selectedByKey.has(item.stableKey)) continue;
      unscheduled.push({
        title: item.title,
        reason: 'AI_FOCUS_LIMIT',
        suggestion: '今天只保留最多 5 件主任务，建议明天继续或手动调整',
        stableKey: item.stableKey,
      });
    }
  }
  for (const u of unscheduled) {
    blocks.push({
      stableKey: u.stableKey || `unscheduled:${u.title}`,
      title: u.title,
      sourceType: schedulable.find((s) => s.stableKey === u.stableKey || s.title === u.title)?.sourceType || 'workbench',
      kind: 'task',
      fixed: false,
      schedulable: true,
      minutes: 0,
      unscheduled: true,
      reason: u.reason,
    });
  }

  const warning = [
    busyState.warning,
    busyState.unverified ? '按当前资料生成未校验草稿，Apple 忙闲不完整时不得宣称无冲突' : null,
  ].filter(Boolean).join(' · ') || null;

  const planId = productivity.replaceDayPlan({
    localDate: date,
    timezone,
    status: 'draft',
    overviewRevision: overview.revision,
    busyRevision: busyRevisionOf(busyState.busy),
    warning,
    unverified: busyState.unverified,
    strategy: mode,
    plannerMeta: planner,
    unscheduled,
    blocks,
  });
  return mapPlanRow(productivity.getDayPlan(date, timezone) || {
    id: planId,
    local_date: date,
    timezone,
    status: 'draft',
    overview_revision: overview.revision,
    busy_revision: busyRevisionOf(busyState.busy),
    warning,
    unverified: busyState.unverified ? 1 : 0,
    strategy: mode,
    planner_meta_json: JSON.stringify(planner || {}),
    unscheduled_json: JSON.stringify(unscheduled),
  }, productivity.listDayPlanBlocks(planId));
}

export function refuseExternalCommit(): never {
  throw new ProductivityError(
    PRODUCTIVITY_ERROR_CODES.EXTERNAL_WRITE_DISABLED,
    '本轮只保存本地草稿。确认写入「L叔工作台」日历不会修改 Things、飞书消息或 Apple 原有事件，且本轮不执行真实外部写入。'
  );
}

export function dayPlanCommitPreview(plan: DayPlanDto): {
  blockCount: number;
  date: string;
  range: { startAt: string | null; endAt: string | null };
  targetCalendar: string;
  write: false;
  willNotModify: string[];
} {
  const timed = plan.blocks.filter((b) => !b.unscheduled && !b.fixed && b.startAt && b.endAt);
  const starts = timed.map((b) => Date.parse(b.startAt as string)).filter(Number.isFinite);
  const ends = timed.map((b) => Date.parse(b.endAt as string)).filter(Number.isFinite);
  return {
    blockCount: timed.length,
    date: plan.date,
    range: {
      startAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      endAt: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
    },
    targetCalendar: WORKBENCH_CALENDAR_NAME,
    write: false,
    willNotModify: ['Things', '飞书消息', 'Apple 原有事件'],
  };
}

export type { TodayOverviewItem, TodayOverviewResult };
