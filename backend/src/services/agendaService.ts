import { isValidIanaTimeZone } from '../config/runtimeConfig';
import type { BusyInterval } from './planning';
import { productivity, getSettings } from '../db';
import { WORKBENCH_CALENDAR_NAME } from '../connectors/types';
import { readEventKitRange, type EventKitEvent } from '../connectors/eventKit';
import type { ArgvRunner } from '../connectors/safeExec';
import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from '../connectors/errors';

export type BusyStatus = 'fresh' | 'stale' | 'unknown' | 'partial' | 'blocked';

export interface AgendaEventView {
  provider: 'apple' | 'feishu' | 'workbench';
  canonicalEventKey: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  availability: string;
  readonly: boolean;
  ownedByWorkbench: boolean;
  calendarName?: string;
  tentative?: boolean;
}

export const AGENDA_WINDOW_DAYS = 7;

export function startOfZonedDay(now: Date, timeZone: string): Date {
  const locale = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = locale.format(now);
  const probe = new Date(`${day}T12:00:00.000Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(probe);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const mm = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  const ss = Number(parts.find((p) => p.type === 'second')?.value || 0);
  return new Date(probe.getTime() - (hh * 3600 + mm * 60 + ss) * 1000);
}

export function defaultAgendaRange(now = new Date(), timeZone = 'Asia/Shanghai'): { from: Date; to: Date } {
  const from = startOfZonedDay(now, timeZone);
  const to = new Date(from.getTime() + AGENDA_WINDOW_DAYS * 24 * 3600 * 1000);
  return { from, to };
}

export function resolveTimeZone(raw?: string): string {
  const settings = getSettings();
  const zone = raw || String(settings.timezone || 'Asia/Shanghai');
  if (!isValidIanaTimeZone(zone)) throw new Error('时区无效');
  return zone;
}

export function maxSpanOk(from: Date, to: Date): boolean {
  return to.getTime() - from.getTime() <= (AGENDA_WINDOW_DAYS + 1) * 24 * 3600 * 1000 && to > from;
}

function isHolidayLike(ev: EventKitEvent): boolean {
  return ev.calendarType === 'birthday' || ev.calendarType === 'subscription' || ev.calendarType === 'holiday';
}

export function eventToBusy(ev: EventKitEvent, blockAllDayHolidays: boolean): BusyInterval | null {
  if (ev.availability === 'free') return null;
  if (ev.status === 'canceled') return null;
  if (ev.allDay && isHolidayLike(ev) && !blockAllDayHolidays) return null;
  return {
    startAt: ev.startAt,
    endAt: ev.endAt,
    source: ev.ownedByWorkbench ? 'workbench' : 'apple',
    title: ev.title,
  };
}

export function isFullCalendarRead(permission: string): boolean {
  return permission === 'fullAccess';
}

function windowCovers(windowRow: Record<string, unknown> | undefined, fromAt: string, toAt: string, timezone: string): boolean {
  if (!windowRow) return false;
  if (Number(windowRow.snapshot_complete) !== 1 || String(windowRow.status) !== 'ok') return false;
  const winTz = String(windowRow.timezone || '');
  if (winTz && winTz !== timezone) return false;
  const winFrom = Date.parse(String(windowRow.from_at || ''));
  const winTo = Date.parse(String(windowRow.to_at || ''));
  const reqFrom = Date.parse(fromAt);
  const reqTo = Date.parse(toAt);
  if (!Number.isFinite(winFrom) || !Number.isFinite(winTo) || !Number.isFinite(reqFrom) || !Number.isFinite(reqTo)) return false;
  return winFrom <= reqFrom && winTo >= reqTo;
}

function windowFresh(windowRow: Record<string, unknown> | undefined): boolean {
  if (!windowRow) return false;
  const staleAfter = String(windowRow.stale_after || '');
  if (staleAfter && new Date(staleAfter).getTime() < Date.now()) return false;
  return Boolean(windowRow.last_success_at);
}

export async function syncAppleAgenda(options: {
  from?: string;
  to?: string;
  timezone?: string;
  requestAccess?: boolean;
  runner?: ArgvRunner;
  persist?: boolean;
}): Promise<{
  events: EventKitEvent[];
  permission: string;
  busyStatus: BusyStatus;
  truncated: boolean;
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  helperVersion: string;
}> {
  const tz = resolveTimeZone(options.timezone);
  const range = defaultAgendaRange(new Date(), tz);
  const from = options.from ? new Date(options.from) : range.from;
  const to = options.to ? new Date(options.to) : range.to;
  if (!maxSpanOk(from, to)) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AGENDA_COVERAGE, '查询区间超出允许的最大窗口');
  }
  if (from.getTime() < range.from.getTime() - 1000 || to.getTime() > range.to.getTime() + 1000) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AGENDA_COVERAGE, 'Apple 忙闲仅覆盖当地今天起 7 天');
  }
  const envelope = await readEventKitRange({
    from: from.toISOString(),
    to: to.toISOString(),
    timezone: tz,
    requestAccess: options.requestAccess === true,
    runner: options.runner,
  });
  const events = envelope.events.filter((ev) => ev.status !== 'canceled');
  const complete = envelope.ok && isFullCalendarRead(envelope.permission) && !envelope.truncated;
  if (options.persist !== false) {
    const rows = events.map((ev) => ({
      provider: 'apple',
      canonical_event_key: ev.canonicalEventKey,
      calendar_identifier: ev.calendarIdentifier,
      event_identifier: ev.eventIdentifier,
      occurrence_start_at: ev.occurrenceStartAt,
      calendar_name: ev.calendarName,
      title: ev.title,
      start_at: ev.startAt,
      end_at: ev.endAt,
      original_timezone: ev.timezone || tz,
      all_day: ev.allDay ? 1 : 0,
      all_day_local_start: ev.allDayLocalStart || null,
      all_day_local_end: ev.allDayLocalEnd || null,
      availability: ev.availability,
      readonly: 1,
      owned_by_workbench: ev.ownedByWorkbench ? 1 : 0,
      calendar_type: ev.calendarType || 'standard',
      last_seen_at: new Date().toISOString(),
    }));
    productivity.commitAgendaProvider({
      provider: 'apple',
      events: complete ? rows : [],
      fromAt: from.toISOString(),
      toAt: to.toISOString(),
      timezone: tz,
      complete,
      status: complete ? 'ok' : envelope.permission === 'notDetermined' ? 'unknown' : 'partial',
      errorCode: complete ? null : envelope.errorCode || PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED,
    });
  }
  return {
    events,
    permission: envelope.permission,
    busyStatus: complete ? 'fresh' : envelope.permission === 'notDetermined' || envelope.permission === 'writeOnly' ? 'unknown' : 'partial',
    truncated: envelope.truncated,
    ok: complete,
    errorCode: complete ? null : envelope.errorCode || PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED,
    errorMessage: complete ? null : envelope.errorMessage || null,
    helperVersion: envelope.version || '',
  };
}

export function persistFeishuAgenda(events: Array<{
  canonicalEventKey: string;
  calendarIdentifier?: string;
  eventIdentifier: string;
  occurrenceStartAt: string;
  startAt: string;
  endAt: string;
  title: string;
  allDay?: boolean;
  availability?: string;
  timezone?: string;
}>, range: { fromAt: string; toAt: string; timezone: string; complete: boolean; status: string; errorCode?: string | null }): void {
  productivity.commitAgendaProvider({
    provider: 'feishu',
    events: range.complete
      ? events.map((ev) => ({
          provider: 'feishu',
          canonical_event_key: ev.canonicalEventKey,
          calendar_identifier: ev.calendarIdentifier || 'feishu',
          event_identifier: ev.eventIdentifier,
          occurrence_start_at: ev.occurrenceStartAt,
          calendar_name: 'feishu',
          title: ev.title,
          start_at: ev.startAt,
          end_at: ev.endAt,
          original_timezone: ev.timezone || range.timezone,
          all_day: ev.allDay ? 1 : 0,
          all_day_local_start: null,
          all_day_local_end: null,
          availability: ev.availability || 'busy',
          readonly: 1,
          owned_by_workbench: 0,
          calendar_type: 'standard',
          last_seen_at: new Date().toISOString(),
        }))
      : [],
    fromAt: range.fromAt,
    toAt: range.toAt,
    timezone: range.timezone,
    complete: range.complete,
    status: range.status,
    errorCode: range.errorCode,
  });
}

export function loadAgendaViews(fromAt: string, toAt: string): AgendaEventView[] {
  const cached = productivity.listAgendaEvents(fromAt, toAt);
  return cached.map((row) => ({
    provider: String(row.provider) as AgendaEventView['provider'],
    canonicalEventKey: String(row.canonical_event_key),
    title: String(row.title || ''),
    startAt: String(row.start_at),
    endAt: String(row.end_at),
    allDay: Number(row.all_day) === 1,
    availability: String(row.availability || 'busy'),
    readonly: Number(row.readonly) === 1,
    ownedByWorkbench: Number(row.owned_by_workbench) === 1,
    calendarName: String(row.calendar_name || ''),
    tentative: String(row.availability) === 'tentative',
  }));
}

export function requiredProviders(): Array<'apple' | 'feishu'> {
  const settings = getSettings();
  const out: Array<'apple' | 'feishu'> = [];
  if (settings.calendarEnabled !== false) out.push('apple');
  if (settings.feishuEnabled !== false) out.push('feishu');
  return out;
}

export function serverBusyIntervals(fromAt: string, toAt: string, timezone?: string): { busy: BusyInterval[]; busyStatus: BusyStatus; coverageError?: string } {
  const tz = timezone || resolveTimeZone();
  const settings = getSettings();
  const required = requiredProviders();
  let busyStatus: BusyStatus = 'fresh';
  for (const provider of required) {
    const win = productivity.latestAgendaWindow(provider);
    if (!windowFresh(win) || !windowCovers(win, fromAt, toAt, tz)) {
      busyStatus = win ? 'partial' : 'unknown';
      return { busy: [], busyStatus: busyStatus === 'unknown' ? 'blocked' : 'blocked', coverageError: `${provider}_coverage` };
    }
  }
  const blockHolidays = settings.blockAllDayHolidays === true;
  const busy: BusyInterval[] = [];
  for (const row of productivity.listAgendaEvents(fromAt, toAt)) {
    if (String(row.availability) === 'free') continue;
    if (String(row.deleted_at || '')) continue;
    if (Number(row.all_day) === 1 && (String(row.calendar_type) === 'birthday' || String(row.calendar_type) === 'subscription') && !blockHolidays) {
      continue;
    }
    const source = Number(row.owned_by_workbench) === 1 ? 'workbench' : String(row.provider) === 'feishu' ? 'feishu' : 'apple';
    busy.push({ startAt: String(row.start_at), endAt: String(row.end_at), source, title: String(row.title || '') });
  }
  for (const mapping of productivity.listActiveCalendarMappings()) {
    if (mapping.end_at <= fromAt || mapping.start_at >= toAt) continue;
    busy.push({ startAt: mapping.start_at, endAt: mapping.end_at, source: 'workbench', title: WORKBENCH_CALENDAR_NAME });
  }
  return { busy, busyStatus };
}

export function todayPlanningBusy(fromAt: string, toAt: string, timezone?: string): {
  busy: BusyInterval[];
  busyStatus: BusyStatus;
  appleOk: boolean;
  feishuOk: boolean;
  feishuOverlay: boolean;
  warning: string | null;
  unverified: boolean;
} {
  const tz = timezone || resolveTimeZone();
  const settings = getSettings();
  const appleWin = productivity.latestAgendaWindow('apple');
  const feishuWin = productivity.latestAgendaWindow('feishu');
  const appleCovered = Boolean(windowFresh(appleWin) && windowCovers(appleWin, fromAt, toAt, tz));
  const feishuRequired = settings.feishuEnabled !== false;
  const feishuOk = !feishuRequired || Boolean(windowFresh(feishuWin) && windowCovers(feishuWin, fromAt, toAt, tz));
  let permission = '';
  let busyCached = '';
  try {
    const calCfg = JSON.parse(productivity.getCheckpoint('calendar')?.config_json || '{}') as Record<string, unknown>;
    permission = String(calCfg.permission || '');
    busyCached = String(calCfg.busyStatus || '');
  } catch {
    permission = '';
  }
  const appleComplete = permission === 'fullAccess' && busyCached === 'fresh' && appleCovered;
  const unverified = !appleComplete;
  const warning = feishuRequired && !feishuOk ? '未叠加飞书日程' : null;
  const blockHolidays = settings.blockAllDayHolidays === true;
  const busy: BusyInterval[] = [];
  for (const row of productivity.listAgendaEvents(fromAt, toAt)) {
    if (String(row.availability) === 'free') continue;
    if (String(row.deleted_at || '')) continue;
    const provider = String(row.provider);
    if (provider === 'feishu' && !feishuOk) continue;
    if (Number(row.all_day) === 1 && (String(row.calendar_type) === 'birthday' || String(row.calendar_type) === 'subscription') && !blockHolidays) {
      continue;
    }
    const source = Number(row.owned_by_workbench) === 1 ? 'workbench' : provider === 'feishu' ? 'feishu' : 'apple';
    busy.push({ startAt: String(row.start_at), endAt: String(row.end_at), source, title: String(row.title || '') });
  }
  for (const mapping of productivity.listActiveCalendarMappings()) {
    if (mapping.end_at <= fromAt || mapping.start_at >= toAt) continue;
    busy.push({ startAt: mapping.start_at, endAt: mapping.end_at, source: 'workbench', title: WORKBENCH_CALENDAR_NAME });
  }
  return {
    busy,
    busyStatus: unverified ? (appleWin ? 'partial' : 'unknown') : 'fresh',
    appleOk: appleComplete,
    feishuOk,
    feishuOverlay: Boolean(feishuRequired && feishuOk),
    warning,
    unverified,
  };
}

export { WORKBENCH_CALENDAR_NAME };
