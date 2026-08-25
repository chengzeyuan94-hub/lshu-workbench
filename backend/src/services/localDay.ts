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

export function zonedParts(date: Date, timeZone: string): {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0;
  return {
    y: parseInt(get('year'), 10),
    m: parseInt(get('month'), 10),
    d: parseInt(get('day'), 10),
    hh,
    mm: parseInt(get('minute'), 10),
    weekday: weekdayMap[get('weekday')] ?? 0,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function atZone(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 8; i += 1) {
    const got = zonedParts(new Date(guess), timeZone);
    const gotUtc = Date.UTC(got.y, got.m - 1, got.d, got.hh, got.mm, 0);
    const wantUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
    const delta = wantUtc - gotUtc;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

export function startOfLocalDate(dateKey: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new Error('日期无效');
  return atZone(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, timeZone);
}

export function localDayBounds(dateKey: string, timeZone: string): { start: Date; end: Date; dateKey: string } {
  const start = startOfLocalDate(dateKey, timeZone);
  const startParts = zonedParts(start, timeZone);
  const next = new Date(start.getTime() + 36 * 3600 * 1000);
  const nextKey = localDateKey(next, timeZone);
  const end = nextKey
    ? startOfLocalDate(nextKey, timeZone)
    : atZone(startParts.y, startParts.m, startParts.d + 1, 0, 0, timeZone);
  return { start, end, dateKey };
}

export function overlapsRange(startAt: string, endAt: string, fromMs: number, toMs: number): boolean {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start < toMs && end > fromMs;
}

export function ceilToQuarterHour(date: Date): Date {
  const step = 15 * 60 * 1000;
  return new Date(Math.ceil(date.getTime() / step) * step);
}

export function sanitizeOccurredAt(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    const ms = num < 1e12 ? num * 1000 : num;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

export function overviewRevisionOf(items: Array<{ stableKey: string; startAt?: string; endAt?: string; dueAt?: string }>): string {
  const payload = items
    .map((item) => `${item.stableKey}|${item.startAt || ''}|${item.endAt || ''}|${item.dueAt || ''}`)
    .sort()
    .join('\n');
  let hash = 0;
  for (let i = 0; i < payload.length; i += 1) hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
  return `ov-${payload.length}-${(hash >>> 0).toString(16)}`;
}

export function busyRevisionOf(busy: Array<{ startAt: string; endAt: string; source: string }>): string {
  const payload = busy
    .map((b) => `${b.source}|${b.startAt}|${b.endAt}`)
    .sort()
    .join('\n');
  let hash = 0;
  for (let i = 0; i < payload.length; i += 1) hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
  return `bz-${payload.length}-${(hash >>> 0).toString(16)}`;
}
