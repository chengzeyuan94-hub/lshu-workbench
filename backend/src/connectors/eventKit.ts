import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTIVITY_ERROR_CODES } from './errors';
import { runArgv, type ArgvRunner } from './safeExec';
import { canonicalEventKey } from '../productivitySchemaV3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CALENDAR_READER_VERSION = '2';
export const CALENDAR_READER_IDENTITY = 'com.lshu.workbench.calendar-reader';
export const CALENDAR_READER_PATH = path.resolve(__dirname, '../../native/bin/calendar-reader');
export const CALENDAR_READER_SOURCE = path.resolve(__dirname, '../../native/calendar-reader.swift');
export const CALENDAR_READER_PLIST = path.resolve(__dirname, '../../native/calendar-reader.Info.plist');

export type CalendarPermission = 'fullAccess' | 'authorized' | 'notDetermined' | 'denied' | 'restricted' | 'writeOnly' | 'unknown';

export interface EventKitEvent {
  calendarIdentifier: string;
  calendarName: string;
  eventIdentifier: string;
  occurrenceStartAt: string;
  startAt: string;
  endAt: string;
  title: string;
  allDay: boolean;
  allDayLocalStart?: string | null;
  allDayLocalEnd?: string | null;
  availability: 'free' | 'busy' | 'tentative' | 'unavailable' | string;
  calendarType?: string;
  ownedByWorkbench?: boolean;
  timezone?: string;
  status?: string;
  canonicalEventKey: string;
}

export interface EventKitEnvelope {
  ok: boolean;
  version: string;
  permission: CalendarPermission;
  requestedAccess: boolean;
  truncated: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  identity?: string | null;
  events: EventKitEvent[];
}

export function calendarReaderAvailable(): boolean {
  return existsSync(CALENDAR_READER_PATH);
}

export function calendarHelperBuildId(filePath = CALENDAR_READER_PATH): string | null {
  if (!existsSync(filePath)) return null;
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16);
}

export function calendarHelperStaleOnDisk(): boolean {
  if (!existsSync(CALENDAR_READER_PATH)) return true;
  const binM = statSync(CALENDAR_READER_PATH).mtimeMs;
  if (existsSync(CALENDAR_READER_SOURCE) && statSync(CALENDAR_READER_SOURCE).mtimeMs > binM + 500) return true;
  if (existsSync(CALENDAR_READER_PLIST) && statSync(CALENDAR_READER_PLIST).mtimeMs > binM + 500) return true;
  return false;
}

export function parseEventKitEnvelope(raw: string): EventKitEnvelope {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      version: '',
      permission: 'unknown',
      requestedAccess: false,
      truncated: false,
      errorCode: PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR,
      errorMessage: '日历 helper 输出无法解析',
      identity: null,
      events: [],
    };
  }
  const eventsIn = Array.isArray(data.events) ? data.events : [];
  const events: EventKitEvent[] = [];
  for (const ev of eventsIn) {
    if (!ev || typeof ev !== 'object') continue;
    const row = ev as Record<string, unknown>;
    const calendarIdentifier = String(row.calendarIdentifier || '');
    const eventIdentifier = String(row.eventIdentifier || row.calendarItemIdentifier || '');
    const occurrenceStartAt = String(row.occurrenceStartAt || row.startAt || '');
    if (!calendarIdentifier || !eventIdentifier || !occurrenceStartAt) continue;
    if (String(row.status || '') === 'canceled' || row.canceled === true) continue;
    const key = canonicalEventKey({
      provider: 'apple',
      calendarIdentifier,
      eventIdentifier,
      occurrenceStartAt,
    });
    events.push({
      calendarIdentifier,
      calendarName: String(row.calendarName || ''),
      eventIdentifier,
      occurrenceStartAt,
      startAt: String(row.startAt || occurrenceStartAt),
      endAt: String(row.endAt || occurrenceStartAt),
      title: String(row.title || ''),
      allDay: row.allDay === true,
      allDayLocalStart: row.allDayLocalStart ? String(row.allDayLocalStart) : null,
      allDayLocalEnd: row.allDayLocalEnd ? String(row.allDayLocalEnd) : null,
      availability: String(row.availability || 'busy'),
      calendarType: String(row.calendarType || 'standard'),
      ownedByWorkbench: row.ownedByWorkbench === true,
      timezone: String(row.timezone || ''),
      status: String(row.status || 'confirmed'),
      canonicalEventKey: key,
    });
  }
  let permission = String(data.permission || 'unknown') as CalendarPermission;
  if (permission === 'authorized') permission = 'fullAccess';
  return {
    ok: data.ok === true,
    version: String(data.version || ''),
    permission,
    requestedAccess: data.requestedAccess === true,
    truncated: data.truncated === true,
    errorCode: data.errorCode ? String(data.errorCode) : null,
    errorMessage: data.errorMessage ? String(data.errorMessage) : null,
    identity: data.identity ? String(data.identity) : null,
    events,
  };
}

function staleEnvelope(message: string): EventKitEnvelope {
  return {
    ok: false,
    version: '',
    permission: 'unknown',
    requestedAccess: false,
    truncated: false,
    errorCode: PRODUCTIVITY_ERROR_CODES.CALENDAR_HELPER_STALE,
    errorMessage: message,
    identity: CALENDAR_READER_IDENTITY,
    events: [],
  };
}

export async function handshakeCalendarHelper(runner?: ArgvRunner): Promise<EventKitEnvelope | null> {
  if (runner) return null;
  if (calendarHelperStaleOnDisk() || !calendarReaderAvailable()) {
    return staleEnvelope('日历 helper 过期或缺失，禁止继续同步');
  }
  const result = await runArgv([CALENDAR_READER_PATH, '--version'], { timeoutMs: 5_000, maxBytes: 64 * 1024 });
  const env = parseEventKitEnvelope(result.stdout || '{}');
  if (env.version !== CALENDAR_READER_VERSION) {
    return staleEnvelope('日历 helper 版本不一致，禁止继续同步');
  }
  if (env.identity && env.identity !== CALENDAR_READER_IDENTITY) {
    return staleEnvelope('日历 helper 身份不一致，禁止继续同步');
  }
  return env;
}

export async function readEventKitRange(input: {
  from: string;
  to: string;
  timezone: string;
  requestAccess?: boolean;
  runner?: ArgvRunner;
  timeoutMs?: number;
}): Promise<EventKitEnvelope> {
  if (!input.runner) {
    const handshake = await handshakeCalendarHelper();
    if (handshake && handshake.errorCode === PRODUCTIVITY_ERROR_CODES.CALENDAR_HELPER_STALE) {
      return handshake;
    }
  }
  if (!calendarReaderAvailable() && !input.runner) {
    return staleEnvelope('日历 helper 不可用');
  }
  const argv = [
    input.runner ? 'calendar-reader' : CALENDAR_READER_PATH,
    '--from',
    input.from,
    '--to',
    input.to,
    '--timezone',
    input.timezone,
  ];
  if (input.requestAccess) argv.push('--request-access');
  const runner = input.runner ?? runArgv;
  const result = await runner(argv, { timeoutMs: input.timeoutMs ?? 20_000, maxBytes: 2 * 1024 * 1024 });
  if (result.timedOut) {
    return {
      ok: false,
      version: CALENDAR_READER_VERSION,
      permission: 'unknown',
      requestedAccess: Boolean(input.requestAccess),
      truncated: false,
      errorCode: PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED,
      errorMessage: '日历读取超时',
      identity: CALENDAR_READER_IDENTITY,
      events: [],
    };
  }
  return parseEventKitEnvelope(result.stdout || '{}');
}
