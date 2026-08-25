import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from './errors';
import { runArgv, type ArgvRunner } from './safeExec';
import type { ConnectorRunResult, StandardizedItem } from './types';
import { fingerprintSource } from '../services/hash';
import { redactText, truncateSummary } from '../services/redact';

export const THINGS_LISTS = {
  inbox: ['收件箱', 'Inbox'],
  today: ['今天', 'Today'],
  upcoming: ['计划', 'Upcoming'],
  logbook: ['日志簿', 'Logbook'],
  trash: ['废纸篓', 'Trash'],
};

const THINGS_JXA = `
function iso(d) { if (!d) return null; try { return new Date(d).toISOString(); } catch (e) { return null; } }
function safeName(obj) { try { return obj ? String(obj.name()) : ''; } catch (e) { return ''; } }
const app = Application('Things3');
try { app.launch(); } catch (e) {}
function listByNames(names) {
  const lists = app.lists();
  for (let i = 0; i < lists.length; i++) {
    const n = String(lists[i].name());
    if (names.indexOf(n) >= 0) return lists[i];
  }
  return null;
}
const list = listByNames(['今天', 'Today']);
if (!list) {
  JSON.stringify({ ok: false, errorCode: 'THINGS_TODAY_MISSING', truncated: false, coverageComplete: false, lists: { today: [] } });
} else {
  try {
  const out = [];
  let truncated = false;
  const todos = list.toDos();
  const limit = 200;
  const n = Math.min(todos.length, limit);
  if (todos.length > limit) truncated = true;
  for (let i = 0; i < n; i++) {
    const t = todos[i];
    let project = '';
    let area = '';
    let dueAt = null;
    let modifiedAt = null;
    try { project = safeName(t.project()); } catch (e) {}
    try { area = safeName(t.area()); } catch (e) {}
    try { dueAt = iso(t.dueDate()); } catch (e) {}
    try { modifiedAt = iso(t.modificationDate()); } catch (e) {}
    out.push({
      id: String(t.id()),
      title: String(t.name()),
      status: String(t.status()),
      list: 'today',
      project: project,
      area: area,
      dueAt: dueAt,
      modifiedAt: modifiedAt
    });
  }
  JSON.stringify({ ok: true, scope: 'today', truncated: truncated, coverageComplete: !truncated, lists: { today: out } });
  } catch (e) {
    JSON.stringify({ ok: false, errorCode: 'THINGS_TODOS_FAILED', truncated: false, coverageComplete: false, lists: { today: [] } });
  }
}
`;

export interface ThingsRawTodo {
  id: string;
  title: string;
  notes?: string;
  status: string;
  list: string;
  project?: string;
  area?: string;
  tags?: string[];
  createdAt?: string | null;
  modifiedAt?: string | null;
  activationAt?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
}

export interface ThingsRawPayload {
  ok?: boolean;
  lists?: {
    inbox?: ThingsRawTodo[];
    today?: ThingsRawTodo[];
    upcoming?: ThingsRawTodo[];
    anytime?: ThingsRawTodo[];
    someday?: ThingsRawTodo[];
  };
  projects?: Array<{ id: string; name: string; todoCount: number }>;
  logbook?: ThingsRawTodo[];
  all?: ThingsRawTodo[];
  listIds?: {
    inbox?: string[];
    today?: string[];
    upcoming?: string[];
    anytime?: string[];
    someday?: string[];
  };
  truncated?: boolean;
}

export function mapThingsStatus(status: string): StandardizedItem['status'] {
  const s = String(status || '').toLowerCase();
  if (s === 'completed' || s === 'complete') return 'completed';
  if (s === 'canceled' || s === 'cancelled') return 'canceled';
  return 'open';
}

export function parseThingsJson(raw: string): ThingsRawPayload {
  const text = String(raw || '').trim();
  if (!text) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.THINGS_UNAVAILABLE, 'Things 返回空结果');
  }
  try {
    const parsed = JSON.parse(text) as ThingsRawPayload;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('not object');
    }
    return parsed;
  } catch {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.THINGS_UNAVAILABLE, 'Things 数据解析失败');
  }
}

export function classifyThingsFailure(stderr: string, timedOut: boolean): ProductivityError {
  if (timedOut) {
    return new ProductivityError(PRODUCTIVITY_ERROR_CODES.THINGS_UNAVAILABLE, 'Things 读取超时');
  }
  const text = `${stderr}`.toLowerCase();
  if (
    text.includes('not authorized') ||
    text.includes('1002') ||
    text.includes('-1743') ||
    text.includes('not allowed') ||
    text.includes('oserror -1743') ||
    text.includes('permission')
  ) {
    return new ProductivityError(PRODUCTIVITY_ERROR_CODES.THINGS_PERMISSION_DENIED, '没有 Things 自动化权限');
  }
  return new ProductivityError(PRODUCTIVITY_ERROR_CODES.THINGS_UNAVAILABLE, 'Things 当前不可用');
}

const STATUS_RANK: Record<string, number> = { open: 1, completed: 2, canceled: 3 };

/** Compatibility parser for historical multi-list fixtures. Not used by production Today sync. */
export function toThingsItemsCompat(payload: ThingsRawPayload): StandardizedItem[] {
  const buckets = [
    ...(payload.all ?? []),
    ...(payload.lists?.inbox ?? []),
    ...(payload.lists?.today ?? []),
    ...(payload.lists?.upcoming ?? []),
    ...(payload.lists?.anytime ?? []),
    ...(payload.lists?.someday ?? []),
    ...(payload.logbook ?? []),
  ];
  const byId = new Map<string, ThingsRawTodo & { memberships: string[] }>();
  for (const todo of buckets) {
    if (!todo?.id) continue;
    const prev = byId.get(todo.id);
    const memberships = prev?.memberships ? [...prev.memberships] : [];
    if (todo.list && !memberships.includes(todo.list)) memberships.push(todo.list);
    if (!prev) {
      byId.set(todo.id, { ...todo, memberships });
      continue;
    }
    const prevRank = STATUS_RANK[mapThingsStatus(prev.status)] || 0;
    const nextRank = STATUS_RANK[mapThingsStatus(todo.status)] || 0;
    const prevMod = Date.parse(prev.modifiedAt || '') || 0;
    const nextMod = Date.parse(todo.modifiedAt || '') || 0;
    const takeIncoming = nextRank > prevRank || (nextRank === prevRank && nextMod >= prevMod);
    const merged = takeIncoming ? { ...prev, ...todo, memberships } : { ...todo, ...prev, memberships };
    if (todo.dueAt === null || prev.dueAt === null) merged.dueAt = takeIncoming ? todo.dueAt ?? null : prev.dueAt ?? null;
    byId.set(todo.id, merged);
  }
  const listIds = payload.listIds || {};
  for (const key of ['inbox', 'today', 'upcoming', 'anytime', 'someday'] as const) {
    for (const id of listIds[key] || []) {
      const row = byId.get(id);
      if (!row) continue;
      if (!row.memberships.includes(key)) row.memberships.push(key);
      if (key === 'today') row.list = 'today';
    }
  }
  const items: StandardizedItem[] = [];
  for (const todo of byId.values()) {
    const memberships = todo.memberships || [];
    const list = memberships.includes('today') ? 'today' : todo.list;
    items.push({
      sourceType: 'things',
      sourceExternalId: todo.id,
      sourceFingerprint: fingerprintSource('things', todo.id),
      title: todo.title || '未命名待办',
      notes: truncateSummary(todo.notes || '', 200),
      project: todo.project || todo.area || undefined,
      tags: todo.tags || [],
      status: mapThingsStatus(todo.status),
      dueAt: todo.dueAt ?? null,
      createdAt: todo.createdAt ?? null,
      modifiedAt: todo.modifiedAt ?? null,
      completedAt: todo.completedAt ?? null,
      summary: truncateSummary(`${memberships.join(',')} ${todo.project || ''}`.trim(), 80),
      payload: {
        list,
        memberships,
        area: todo.area || '',
        activationAt: todo.activationAt || null,
        canceledAt: todo.canceledAt || null,
        snapshotComplete: payload.truncated !== true,
        truncated: payload.truncated === true,
      },
    });
  }
  return items;
}

export function toThingsItems(payload: ThingsRawPayload): StandardizedItem[] {
  const today = payload.lists?.today ?? [];
  return today
    .filter((todo) => todo?.id)
    .slice(0, 200)
    .map((todo) => ({
      sourceType: 'things' as const,
      sourceExternalId: todo.id,
      sourceFingerprint: fingerprintSource('things', todo.id),
      title: todo.title || '未命名待办',
      notes: truncateSummary(todo.notes || '', 200),
      project: todo.project || todo.area || undefined,
      tags: todo.tags || [],
      status: mapThingsStatus(todo.status),
      dueAt: todo.dueAt ?? null,
      createdAt: todo.createdAt ?? null,
      modifiedAt: todo.modifiedAt ?? null,
      completedAt: todo.completedAt ?? null,
      summary: truncateSummary(`${todo.project || todo.area || ''}`.trim(), 80),
      payload: {
        list: 'today',
        memberships: ['today'],
        area: todo.area || '',
        activationAt: todo.activationAt || null,
        canceledAt: todo.canceledAt || null,
        snapshotComplete: payload.truncated !== true && payload.ok !== false,
        truncated: payload.truncated === true,
        sourceScope: 'things_today',
      },
    }));
}

export async function readThings(options: { runner?: ArgvRunner; timeoutMs?: number } = {}): Promise<ConnectorRunResult> {
  const runner = options.runner ?? runArgv;
  const result = await runner(['osascript', '-l', 'JavaScript', '-e', THINGS_JXA], {
    timeoutMs: options.timeoutMs ?? 15_000,
    maxBytes: 256 * 1024,
  });
  if (result.timedOut || result.code !== 0) {
    const err = classifyThingsFailure(result.stderr, result.timedOut);
    return {
      connector: 'things',
      ok: false,
      items: [],
      itemsSeen: 0,
      errorCode: err.code,
      errorMessage: err.message,
    };
  }
  try {
    const payload = parseThingsJson(result.stdout);
    if (payload.ok === false) {
      return {
        connector: 'things',
        ok: false,
        items: [],
        itemsSeen: 0,
        errorCode: PRODUCTIVITY_ERROR_CODES.THINGS_UNAVAILABLE,
        errorMessage: 'Things 今天列表不可用',
        extra: { coverageComplete: false, scope: 'today' },
      };
    }
    const items = toThingsItems(payload);
    const truncated = payload.truncated === true;
    return {
      connector: 'things',
      ok: truncated ? true : true,
      items,
      itemsSeen: items.length,
      extra: {
        scope: 'today',
        truncated,
        snapshotComplete: truncated !== true,
        coverageComplete: truncated !== true,
      },
    };
  } catch (e) {
    const err = e instanceof ProductivityError ? e : classifyThingsFailure(result.stderr, false);
    return {
      connector: 'things',
      ok: false,
      items: [],
      itemsSeen: 0,
      errorCode: err.code,
      errorMessage: redactText(err.message, 160),
    };
  }
}
