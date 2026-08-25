import { describe, expect, it } from 'vitest';
import { canonicalEventKey } from '../src/productivitySchemaV3';
import { parseEventKitEnvelope, CALENDAR_READER_VERSION } from '../src/connectors/eventKit';
import { eventToBusy, defaultAgendaRange, AGENDA_WINDOW_DAYS, maxSpanOk } from '../src/services/agendaService';
import { PRODUCTIVITY_ERROR_CODES } from '../src/connectors/errors';

describe('Calendar EventKit envelope', () => {
  it('缺稳定 ID 的事件跳过，不靠 title 生成 key', () => {
    const env = parseEventKitEnvelope(JSON.stringify({
      ok: true,
      version: CALENDAR_READER_VERSION,
      permission: 'authorized',
      requestedAccess: false,
      truncated: false,
      events: [
        { calendarIdentifier: '', eventIdentifier: '', occurrenceStartAt: '', title: '会议' },
        { calendarIdentifier: 'cal-1', eventIdentifier: 'ev-1', occurrenceStartAt: '2026-08-24T01:00:00Z', startAt: '2026-08-24T01:00:00Z', endAt: '2026-08-24T02:00:00Z', title: '合成会议', availability: 'busy', allDay: false },
      ],
    }));
    expect(env.events).toHaveLength(1);
    expect(env.events[0].canonicalEventKey).toContain('cal-1');
    expect(env.events[0].canonicalEventKey).not.toContain('合成会议');
  });

  it('canonical key 组成均非空', () => {
    expect(() => canonicalEventKey({ provider: '', calendarIdentifier: 'a', eventIdentifier: 'b', occurrenceStartAt: 'c' })).toThrow();
    expect(canonicalEventKey({ provider: 'apple', calendarIdentifier: 'a', eventIdentifier: 'b', occurrenceStartAt: 'c' })).toBe('apple::a::b::c');
  });

  it('free 不阻塞；birthday 全天默认不阻塞', () => {
    expect(eventToBusy({
      calendarIdentifier: 'c', calendarName: '工作', eventIdentifier: 'e', occurrenceStartAt: 't',
      startAt: '2026-08-24T01:00:00Z', endAt: '2026-08-24T02:00:00Z', title: 'x', allDay: false, availability: 'free', canonicalEventKey: 'k',
    }, false)).toBeNull();
    expect(eventToBusy({
      calendarIdentifier: 'c', calendarName: '生日', eventIdentifier: 'e', occurrenceStartAt: 't',
      startAt: '2026-08-24T00:00:00Z', endAt: '2026-08-25T00:00:00Z', title: '某人', allDay: true, availability: 'busy', calendarType: 'birthday', canonicalEventKey: 'k',
    }, false)).toBeNull();
  });

  it('helper 路径固定且 GET 不带 request-access', () => {
    expect(CALENDAR_READER_VERSION).toBe('2');
  });

  it('默认同步窗口为当地今天起 7 天', () => {
    expect(AGENDA_WINDOW_DAYS).toBe(7);
    const now = new Date('2026-08-24T06:55:00.000Z');
    const { from, to } = defaultAgendaRange(now, 'Asia/Shanghai');
    expect(to.getTime() - from.getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(maxSpanOk(from, to)).toBe(true);
    expect(maxSpanOk(from, new Date(from.getTime() + 40 * 24 * 3600 * 1000))).toBe(false);
    expect(from.toISOString()).toBe('2026-08-23T16:00:00.000Z');
  });
});

describe('权限状态', () => {
  it('解析 notDetermined/denied', () => {
    const a = parseEventKitEnvelope(JSON.stringify({ ok: false, version: '1', permission: 'notDetermined', requestedAccess: false, truncated: false, events: [] }));
    const b = parseEventKitEnvelope(JSON.stringify({ ok: false, version: '1', permission: 'denied', requestedAccess: false, truncated: false, events: [] }));
    expect(a.permission).toBe('notDetermined');
    expect(b.permission).toBe('denied');
    expect(PRODUCTIVITY_ERROR_CODES.CALENDAR_BUSY_UNKNOWN).toBe('CALENDAR_BUSY_UNKNOWN');
  });
});
