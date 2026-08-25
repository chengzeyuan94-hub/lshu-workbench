import { describe, expect, it } from 'vitest';
import {
  planCalendarWrite,
  assertWorkbenchCalendarWrite,
  buildWorkbenchEventScript,
  executeWorkbenchCalendarWrite,
  TEST_EVENT_TITLE,
} from '../src/connectors/appleCalendar';
import { PRODUCTIVITY_ERROR_CODES } from '../src/connectors/errors';
import { WORKBENCH_CALENDAR_NAME } from '../src/connectors/types';

describe('Calendar 受控写入（全部 mock）', () => {
  it('拒绝写入个人/工作/家庭等原有日历', () => {
    expect(() => assertWorkbenchCalendarWrite('个人')).toThrowError(/专属日历/);
    expect(() =>
      planCalendarWrite({
        calendarName: '工作',
        title: '测试',
        startAt: '2026-08-25T10:00:00.000Z',
        endAt: '2026-08-25T11:00:00.000Z',
        autoScheduleEnabled: true,
        confirmed: true,
      })
    ).toThrowError(/原有日历|专属/);
  });

  it('未开启自动排程且未确认时禁止写入', () => {
    try {
      planCalendarWrite({
        calendarName: WORKBENCH_CALENDAR_NAME,
        title: '测试',
        startAt: '2026-08-25T10:00:00.000Z',
        endAt: '2026-08-25T11:00:00.000Z',
        autoScheduleEnabled: false,
        confirmed: false,
      });
      expect.fail('should throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe(PRODUCTIVITY_ERROR_CODES.EXTERNAL_WRITE_DISABLED);
    }
  });

  it('同一 todo 再次排程走 update 而不是重复 create', () => {
    const first = planCalendarWrite({
      calendarName: WORKBENCH_CALENDAR_NAME,
      title: '[测试] 工作台事件',
      startAt: '2026-08-25T10:00:00.000Z',
      endAt: '2026-08-25T11:00:00.000Z',
      autoScheduleEnabled: false,
      confirmed: true,
    });
    expect(first.action).toBe('create');
    const second = planCalendarWrite({
      calendarName: WORKBENCH_CALENDAR_NAME,
      title: '[测试] 工作台事件',
      startAt: '2026-08-25T14:00:00.000Z',
      endAt: '2026-08-25T15:00:00.000Z',
      existingEventId: 'evt-1',
      autoScheduleEnabled: false,
      confirmed: true,
    });
    expect(second.action).toBe('update');
    expect(second.eventId).toBe('evt-1');
    expect(second.calendarName).toBe(WORKBENCH_CALENDAR_NAME);
  });

  it('真实脚本只允许专属日历和测试标题，绝不点名用户日历', () => {
    const script = buildWorkbenchEventScript('create', {
      title: TEST_EVENT_TITLE,
      startAt: '2026-08-25T08:00:00.000Z',
      endAt: '2026-08-25T08:30:00.000Z',
    });
    expect(script).toContain(WORKBENCH_CALENDAR_NAME);
    expect(script).toContain(TEST_EVENT_TITLE);
    expect(script).not.toContain('tell calendar "个人"');
    expect(script).not.toContain('tell calendar "工作"');
    expect(script).not.toContain('tell calendar "家庭"');
    expect(() =>
      buildWorkbenchEventScript('create', {
        title: '普通会议',
        startAt: '2026-08-25T08:00:00.000Z',
        endAt: '2026-08-25T08:30:00.000Z',
      })
    ).toThrowError(/测试标题/);
  });

  it('mock runner 可创建并按 uid 回滚', async () => {
    const created = await executeWorkbenchCalendarWrite(
      'create',
      {
        title: TEST_EVENT_TITLE,
        startAt: '2026-08-25T08:00:00.000Z',
        endAt: '2026-08-25T08:30:00.000Z',
        confirmed: true,
      },
      { runner: async () => ({ stdout: 'OK|evt-test-1', stderr: '', code: 0, timedOut: false, truncated: false }) }
    );
    expect(created.eventId).toBe('evt-test-1');
    const deleted = await executeWorkbenchCalendarWrite(
      'delete',
      { title: TEST_EVENT_TITLE, eventId: 'evt-test-1', confirmed: true },
      { runner: async () => ({ stdout: 'OK|evt-test-1', stderr: '', code: 0, timedOut: false, truncated: false }) }
    );
    expect(deleted.deleted).toBe(true);
  });
});
