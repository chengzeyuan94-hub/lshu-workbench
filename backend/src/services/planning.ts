import { atZone, ceilToQuarterHour, localDateKey, zonedParts } from './localDay';

export interface BusyInterval {
  startAt: string;
  endAt: string;
  source: 'apple' | 'feishu' | 'workbench' | 'lunch' | 'buffer';
  title?: string;
}

export interface PlanningRules {
  timezone: string;
  workDays: number[];
  workStart: string;
  workEnd: string;
  lunchStart: string;
  lunchEnd: string;
  bufferMinutes: number;
  minBlockMinutes: number;
  maxBlockMinutes: number;
  idleReserveRatio: number;
}

export interface PlanBlock {
  todoId?: number;
  title: string;
  startAt: string;
  endAt: string;
  part?: string;
  minutes: number;
}

export type PlanningPreference = 'morning' | 'afternoon' | 'any';

export interface PlanResult {
  blocks: PlanBlock[];
  unscheduled: Array<{ title: string; reason: string; suggestion: string }>;
}

export const DEFAULT_PLANNING_RULES: PlanningRules = {
  timezone: 'Asia/Shanghai',
  workDays: [1, 2, 3, 4, 5],
  workStart: '09:30',
  workEnd: '18:30',
  lunchStart: '12:00',
  lunchEnd: '13:30',
  bufferMinutes: 15,
  minBlockMinutes: 45,
  maxBlockMinutes: 120,
  idleReserveRatio: 0.2,
};

export function shanghaiParts(date: Date): { y: number; m: number; d: number; hh: number; mm: number; weekday: number } {
  return zonedParts(date, 'Asia/Shanghai');
}

function parseHm(hm: string): { hh: number; mm: number } {
  const [h, m] = hm.split(':').map((x) => parseInt(x, 10));
  return { hh: h || 0, mm: m || 0 };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function buildDayWindows(day: Date, rules: PlanningRules, now = new Date()): { start: Date; end: Date }[] {
  const p = zonedParts(day, rules.timezone);
  if (!rules.workDays.includes(p.weekday)) return [];
  const work = parseHm(rules.workStart);
  const end = parseHm(rules.workEnd);
  const lunchS = parseHm(rules.lunchStart);
  const lunchE = parseHm(rules.lunchEnd);
  const notBefore = ceilToQuarterHour(now).getTime();
  const morning = {
    start: atZone(p.y, p.m, p.d, work.hh, work.mm, rules.timezone),
    end: atZone(p.y, p.m, p.d, lunchS.hh, lunchS.mm, rules.timezone),
  };
  const afternoon = {
    start: atZone(p.y, p.m, p.d, lunchE.hh, lunchE.mm, rules.timezone),
    end: atZone(p.y, p.m, p.d, end.hh, end.mm, rules.timezone),
  };
  return [morning, afternoon]
    .map((w) => ({
      start: new Date(Math.max(w.start.getTime(), notBefore)),
      end: w.end,
    }))
    .filter((w) => w.end.getTime() > w.start.getTime() && w.end.getTime() > now.getTime());
}

export function subtractBusy(windows: Array<{ start: Date; end: Date }>, busy: BusyInterval[], bufferMinutes: number): Array<{ start: Date; end: Date }> {
  const bufferMs = bufferMinutes * 60 * 1000;
  let free = windows.map((w) => ({ start: new Date(w.start), end: new Date(w.end) }));
  const busyMs = busy
    .map((b) => ({
      start: new Date(b.startAt).getTime() - bufferMs,
      end: new Date(b.endAt).getTime() + bufferMs,
    }))
    .filter((b) => !Number.isNaN(b.start) && !Number.isNaN(b.end))
    .sort((a, b) => a.start - b.start);

  for (const b of busyMs) {
    const next: Array<{ start: Date; end: Date }> = [];
    for (const w of free) {
      const ws = w.start.getTime();
      const we = w.end.getTime();
      if (!overlaps(ws, we, b.start, b.end)) {
        next.push(w);
        continue;
      }
      if (ws < b.start) next.push({ start: w.start, end: new Date(Math.min(we, b.start)) });
      if (we > b.end) next.push({ start: new Date(Math.max(ws, b.end)), end: w.end });
    }
    free = next.filter((w) => w.end.getTime() - w.start.getTime() >= 15 * 60 * 1000);
  }
  return free;
}

export function planTodos(
  todos: Array<{
    id?: number;
    title: string;
    estimatedMinutes: number;
    priority?: string;
    dueAt?: string | null;
    rank?: number;
    preferredWindow?: PlanningPreference;
  }>,
  busy: BusyInterval[],
  rules: PlanningRules = DEFAULT_PLANNING_RULES,
  day = new Date(),
  now = new Date()
): PlanResult {
  const windows = subtractBusy(buildDayWindows(day, rules, now), busy, rules.bufferMinutes);
  const totalMs = windows.reduce((s, w) => s + (w.end.getTime() - w.start.getTime()), 0);
  const usableMs = Math.floor(totalMs * (1 - rules.idleReserveRatio));
  const blocks: PlanBlock[] = [];
  const unscheduled: PlanResult['unscheduled'] = [];
  let used = 0;

  const ordered = [...todos].sort((a, b) => {
    const dueMs = (x?: string | null) => (x ? new Date(x).getTime() : Number.MAX_SAFE_INTEGER);
    const overdue = (x?: string | null) => Boolean(x) && dueMs(x) < now.getTime();
    const dueToday = (x?: string | null) => Boolean(x) && localDateKey(x, rules.timezone) === localDateKey(now, rules.timezone);
    const pr = (x?: string) => (x === 'high' ? 0 : x === 'low' ? 2 : 1);
    const rank = (x?: number) => Number.isFinite(x) ? Number(x) : Number.MAX_SAFE_INTEGER;
    return rank(a.rank) - rank(b.rank)
      || Number(overdue(b.dueAt)) - Number(overdue(a.dueAt))
      || Number(dueToday(b.dueAt)) - Number(dueToday(a.dueAt))
      || dueMs(a.dueAt) - dueMs(b.dueAt)
      || pr(a.priority) - pr(b.priority);
  });

  const cursorWindows = windows.map((w) => ({ start: new Date(w.start), end: new Date(w.end) }));

  for (const todo of ordered) {
    const minutes = Math.max(todo.estimatedMinutes || 45, rules.minBlockMinutes);
    const parts = splitMinutes(minutes, rules.maxBlockMinutes);
    let placed = 0;
    for (let i = 0; i < parts.length; i++) {
      const need = parts[i] * 60 * 1000;
      if (used + need > usableMs) break;
      const slot = takeSlot(cursorWindows, need, todo.preferredWindow || 'any', rules.timezone);
      if (!slot) break;
      used += need;
      placed += 1;
      blocks.push({
        todoId: todo.id,
        title: todo.title,
        startAt: slot.start.toISOString(),
        endAt: slot.end.toISOString(),
        part: parts.length > 1 ? `${i + 1}/${parts.length}` : undefined,
        minutes: parts[i],
      });
    }
    if (placed < parts.length) {
      unscheduled.push({
        title: todo.title,
        reason: placed === 0 ? 'NO_AVAILABLE_SLOT' : '部分时间块无法安排',
        suggestion: '缩短预估时长、挪到下一工作日，或减少当天已有会议',
      });
    }
  }

  return { blocks, unscheduled };
}

function splitMinutes(total: number, maxBlock: number): number[] {
  if (total <= maxBlock) return [total];
  const parts: number[] = [];
  let left = total;
  while (left > 0) {
    const chunk = Math.min(maxBlock, left);
    parts.push(chunk);
    left -= chunk;
  }
  return parts;
}

function takeSlot(
  windows: Array<{ start: Date; end: Date }>,
  needMs: number,
  preferredWindow: PlanningPreference,
  timezone: string
): { start: Date; end: Date } | null {
  const matches = (window: { start: Date }) => {
    if (preferredWindow === 'any') return true;
    const hour = zonedParts(window.start, timezone).hh;
    return preferredWindow === 'morning' ? hour < 13 : hour >= 13;
  };
  const ordered = preferredWindow === 'any'
    ? windows
    : [...windows.filter(matches), ...windows.filter((window) => !matches(window))];
  for (const w of ordered) {
    const avail = w.end.getTime() - w.start.getTime();
    if (avail < needMs) continue;
    const start = new Date(w.start);
    const end = new Date(start.getTime() + needMs);
    w.start = end;
    return { start, end };
  }
  return null;
}
