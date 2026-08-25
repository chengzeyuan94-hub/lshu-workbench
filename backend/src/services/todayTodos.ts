import { createHash } from 'node:crypto';
import db, { productivity, type TodoRow } from '../db';
import { mapTodoRow } from './productivitySync';

export interface TodayTodosQuery {
  now?: Date;
  timeZone?: string;
  limit?: number;
}

export interface TodayTodosResult {
  items: Array<ReturnType<typeof mapTodoRow> & { evidenceCount: number }>;
  total: number;
  asOf: string;
  revision: string;
  timeZone: string;
}

const BLOCKED_SOURCE_STATUS = new Set(['completed', 'canceled', 'out_of_scope', 'missing']);
const BLOCKED_LIFECYCLE = new Set(['ignored', 'completed', 'canceled']);
const CONFIRMED_LIFECYCLES = new Set(['confirmed', 'planned', 'in_progress', 'suspected_done']);
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function localDateKey(value: Date | string | null | undefined, timeZone: string): string | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function visibilityOf(row: TodoRow): string {
  return row.visibility || 'visible';
}

function lifecycleOf(row: TodoRow): string {
  return row.lifecycle_status || (row.status === 'confirmed' ? 'confirmed' : row.status === 'ignored' ? 'ignored' : 'candidate');
}

function sourceStatusOf(row: TodoRow): string {
  return row.source_status || 'open';
}

function originOf(row: TodoRow): string {
  return row.origin_mode || 'legacy';
}

export function isTodayTodoRow(row: TodoRow, todayKey: string, timeZone: string): boolean {
  if (visibilityOf(row) !== 'visible') return false;
  if (row.status === 'ignored') return false;
  const life = lifecycleOf(row);
  if (BLOCKED_LIFECYCLE.has(life)) return false;
  if (BLOCKED_SOURCE_STATUS.has(sourceStatusOf(row))) return false;

  const origin = originOf(row);
  if (row.source_type === 'things' && origin === 'structured') {
    return sourceStatusOf(row) === 'open';
  }

  if (origin === 'legacy' && (row.status === 'pending' || life === 'candidate')) return false;
  if ((origin === 'ai' || row.source_type === 'feishu_message' || row.source_type === 'desktop') && (row.status === 'pending' || life === 'candidate')) {
    return false;
  }

  if ((origin === 'ai' || origin === 'manual') && CONFIRMED_LIFECYCLES.has(life)) {
    const plannedKey = localDateKey(row.planned_start_at, timeZone);
    const dueKey = localDateKey(row.due_at, timeZone);
    const plannedToday = plannedKey === todayKey;
    const dueToday = dueKey === todayKey;
    const overdue = Boolean(dueKey && dueKey < todayKey);
    return plannedToday || dueToday || overdue;
  }

  return false;
}

function dueSortKey(row: TodoRow, todayKey: string, timeZone: string): string {
  const dueKey = localDateKey(row.due_at, timeZone);
  if (!dueKey || dueKey > todayKey || !row.due_at) return '\uffff';
  return row.due_at;
}

export function sortTodayTodoRows(rows: TodoRow[], todayKey: string, timeZone: string): TodoRow[] {
  return [...rows].sort((a, b) => {
    const plannedA = a.planned_start_at || '\uffff';
    const plannedB = b.planned_start_at || '\uffff';
    if (plannedA !== plannedB) return plannedA < plannedB ? -1 : 1;
    const dueA = dueSortKey(a, todayKey, timeZone);
    const dueB = dueSortKey(b, todayKey, timeZone);
    if (dueA !== dueB) return dueA < dueB ? -1 : 1;
    const pA = PRIORITY_RANK[a.priority] ?? 9;
    const pB = PRIORITY_RANK[b.priority] ?? 9;
    if (pA !== pB) return pA - pB;
    const uA = a.updated_at || '';
    const uB = b.updated_at || '';
    if (uA !== uB) return uA < uB ? 1 : -1;
    return Number(b.id) - Number(a.id);
  });
}

export function todayTodosRevision(rows: TodoRow[]): string {
  const material = rows.map((r) => `${r.id}:${r.updated_at || ''}`).join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function queryTodayTodos(input: TodayTodosQuery = {}): TodayTodosResult {
  const now = input.now || new Date();
  const timeZone = input.timeZone || systemTimeZone();
  const todayKey = localDateKey(now, timeZone) || '1970-01-01';
  const asOf = now.toISOString();
  const rows = db.prepare(
    `SELECT * FROM todos
     WHERE IFNULL(visibility, 'visible') = 'visible'
       AND IFNULL(lifecycle_status, 'candidate') NOT IN ('ignored', 'completed', 'canceled')
       AND IFNULL(status, '') != 'ignored'
       AND IFNULL(source_status, 'open') NOT IN ('completed', 'canceled', 'out_of_scope', 'missing')
       AND (
         (source_type = 'things' AND IFNULL(origin_mode, 'legacy') = 'structured')
         OR (
           IFNULL(origin_mode, 'legacy') IN ('ai', 'manual')
           AND IFNULL(lifecycle_status, 'candidate') IN ('confirmed', 'planned', 'in_progress', 'suspected_done')
         )
       )`
  ).all() as TodoRow[];
  const matched = sortTodayTodoRows(rows.filter((row) => isTodayTodoRow(row, todayKey, timeZone)), todayKey, timeZone);
  const total = matched.length;
  const limited = input.limit != null && Number.isFinite(input.limit) && input.limit > 0
    ? matched.slice(0, Math.floor(input.limit))
    : matched;
  const counts = productivity.getEvidenceCounts(limited.map((row) => row.id));
  return {
    items: limited.map((row) => ({ ...mapTodoRow(row), evidenceCount: counts.get(row.id) ?? 0 })),
    total,
    asOf,
    revision: todayTodosRevision(matched),
    timeZone,
  };
}
