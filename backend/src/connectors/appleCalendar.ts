import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from './errors';
import { runArgv, type ArgvRunner } from './safeExec';
import { PROTECTED_CALENDAR_NAMES, WORKBENCH_CALENDAR_NAME } from './types';
import { redactText } from '../services/redact';

export interface CalendarInfo {
  name: string;
  writable: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarName: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  ownedByWorkbench?: boolean;
}

const LIST_CALENDARS_JXA = `
const cal = Application('Calendar');
try { cal.launch(); } catch (e) {}
const names = cal.calendars.name();
const out = [];
for (const n of names) {
  const c = cal.calendars.byName(n);
  let writable = false;
  try { writable = !!c.writable(); } catch (e) {}
  out.push({ name: String(n), writable: writable });
}
JSON.stringify({ ok: true, calendars: out });
`;

export function parseCalendarList(raw: string): CalendarInfo[] {
  try {
    const data = JSON.parse(raw) as { calendars?: CalendarInfo[] };
    return Array.isArray(data.calendars) ? data.calendars : [];
  } catch {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED, '无法解析日历列表');
  }
}

export function parseCalendarEvents(raw: string): CalendarEvent[] {
  try {
    const data = JSON.parse(raw) as { events?: CalendarEvent[] };
    return Array.isArray(data.events) ? data.events : [];
  } catch {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED, '无法解析日历事件');
  }
}

export function assertWorkbenchCalendarWrite(calendarName: string): void {
  if (calendarName !== WORKBENCH_CALENDAR_NAME || PROTECTED_CALENDAR_NAMES.has(calendarName)) {
    throw new ProductivityError(
      PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED,
      '只能写入工作台专属日历，不能修改用户原有日历'
    );
  }
}

export function classifyCalendarFailure(stderr: string, timedOut: boolean): ProductivityError {
  if (timedOut) {
    return new ProductivityError(PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED, '日历读取超时');
  }
  const text = stderr.toLowerCase();
  if (text.includes('not authorized') || text.includes('-1743') || text.includes('permission')) {
    return new ProductivityError(PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED, '没有日历自动化权限');
  }
  return new ProductivityError(PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED, '日历当前不可用');
}

export async function listAppleCalendars(options: { runner?: ArgvRunner; timeoutMs?: number } = {}): Promise<CalendarInfo[]> {
  const runner = options.runner ?? runArgv;
  const result = await runner(['osascript', '-l', 'JavaScript', '-e', LIST_CALENDARS_JXA], {
    timeoutMs: options.timeoutMs ?? 12_000,
    maxBytes: 64 * 1024,
  });
  if (result.timedOut || result.code !== 0) {
    throw classifyCalendarFailure(result.stderr, result.timedOut);
  }
  return parseCalendarList(result.stdout);
}

export async function readAppleBusyEvents(
  eventsJson: string
): Promise<CalendarEvent[]> {
  return parseCalendarEvents(eventsJson);
}

export interface CalendarWriteInput {
  calendarName: string;
  title: string;
  startAt: string;
  endAt: string;
  existingEventId?: string | null;
  autoScheduleEnabled: boolean;
  confirmed: boolean;
}

export function planCalendarWrite(input: CalendarWriteInput): { action: 'create' | 'update'; calendarName: string; title: string; startAt: string; endAt: string; eventId?: string } {
  if (!input.autoScheduleEnabled && !input.confirmed) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.EXTERNAL_WRITE_DISABLED, '未开启自动排程，且用户未确认写入日历');
  }
  assertWorkbenchCalendarWrite(input.calendarName);
  if (PROTECTED_CALENDAR_NAMES.has(input.calendarName)) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED, '禁止写入用户原有日历');
  }
  return {
    action: input.existingEventId ? 'update' : 'create',
    calendarName: WORKBENCH_CALENDAR_NAME,
    title: input.title,
    startAt: input.startAt,
    endAt: input.endAt,
    eventId: input.existingEventId || undefined,
  };
}

export function redactCalendarLog(text: string): string {
  return redactText(text, 160);
}

export const TEST_EVENT_TITLE = '[测试] L叔工作台排程连通性检查 — 可回滚';

function shanghaiWall(iso: string): { y: number; m: number; d: number; hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  let hh = get('hour');
  if (hh === 24) hh = 0;
  return { y: get('year'), m: get('month'), d: get('day'), hh, mm: get('minute') };
}

function assertSafeInt(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 9999) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR, '非法日期参数');
  }
  return n;
}

export function buildWorkbenchEventScript(action: 'create' | 'delete' | 'find', input: {
  title: string;
  startAt?: string;
  endAt?: string;
  eventId?: string;
}): string {
  if (PROTECTED_CALENDAR_NAMES.has(WORKBENCH_CALENDAR_NAME)) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED, '专属日历名落入保护名单');
  }
  const cal = WORKBENCH_CALENDAR_NAME.replace(/"/g, '');
  const title = String(input.title || '').replace(/"/g, '');
  if (title !== TEST_EVENT_TITLE && action === 'create') {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR, '首次真实写入只允许测试标题');
  }
  if (action === 'create') {
    const s = shanghaiWall(input.startAt || '');
    const e = shanghaiWall(input.endAt || '');
    [s.y, s.m, s.d, s.hh, s.mm, e.y, e.m, e.d, e.hh, e.mm].forEach(assertSafeInt);
    return `
tell application "Calendar"
  if not (exists calendar "${cal}") then
    make new calendar with properties {name:"${cal}"}
  end if
  tell calendar "${cal}"
    set startDate to current date
    set year of startDate to ${s.y}
    set month of startDate to ${s.m}
    set day of startDate to ${s.d}
    set hours of startDate to ${s.hh}
    set minutes of startDate to ${s.mm}
    set seconds of startDate to 0
    set endDate to current date
    set year of endDate to ${e.y}
    set month of endDate to ${e.m}
    set day of endDate to ${e.d}
    set hours of endDate to ${e.hh}
    set minutes of endDate to ${e.mm}
    set seconds of endDate to 0
    set newEv to make new event with properties {summary:"${title}", start date:startDate, end date:endDate}
    return "OK|" & (uid of newEv)
  end tell
end tell
`;
  }
  const eventId = String(input.eventId || '').replace(/[^A-Za-z0-9._@-]/g, '');
  if (!eventId) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR, '缺少 eventId');
  }
  if (action === 'find') {
    return `
tell application "Calendar"
  if not (exists calendar "${cal}") then
    return "MISSING"
  end if
  tell calendar "${cal}"
    set matched to (every event whose uid is "${eventId}")
    if (count of matched) is 0 then
      return "MISSING"
    end if
    return "OK|" & (uid of item 1 of matched)
  end tell
end tell
`;
  }
  return `
tell application "Calendar"
  if not (exists calendar "${cal}") then
    return "MISSING"
  end if
  tell calendar "${cal}"
    set matched to (every event whose uid is "${eventId}")
    if (count of matched) is 0 then
      return "MISSING"
    end if
    delete matched
    return "OK|" & "${eventId}"
  end tell
end tell
`;
}

export async function executeWorkbenchCalendarWrite(
  action: 'create' | 'delete' | 'find',
  input: { title: string; startAt?: string; endAt?: string; eventId?: string; confirmed: boolean },
  options: { runner?: ArgvRunner; timeoutMs?: number } = {}
): Promise<Record<string, unknown>> {
  if (!input.confirmed) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.EXTERNAL_WRITE_DISABLED, '未确认，拒绝写入日历');
  }
  planCalendarWrite({
    calendarName: WORKBENCH_CALENDAR_NAME,
    title: input.title,
    startAt: input.startAt || new Date().toISOString(),
    endAt: input.endAt || new Date().toISOString(),
    existingEventId: action === 'create' ? null : input.eventId,
    autoScheduleEnabled: false,
    confirmed: true,
  });
  const script = buildWorkbenchEventScript(action, input);
  const runner = options.runner ?? runArgv;
  const result = await runner(['osascript', '-e', script], {
    timeoutMs: options.timeoutMs ?? 25_000,
    maxBytes: 32 * 1024,
  });
  if (result.timedOut || result.code !== 0) {
    throw classifyCalendarFailure(result.stderr || result.stdout, result.timedOut);
  }
  const out = result.stdout.trim();
  if (out === 'MISSING') {
    return { ok: true, found: false, deleted: false, calendarName: WORKBENCH_CALENDAR_NAME };
  }
  if (out.startsWith('OK|')) {
    const eventId = out.slice(3);
    return {
      ok: true,
      found: true,
      deleted: action === 'delete',
      eventId,
      calendarName: WORKBENCH_CALENDAR_NAME,
      title: input.title,
    };
  }
  throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED, '日历写入结果无法解析');
}

