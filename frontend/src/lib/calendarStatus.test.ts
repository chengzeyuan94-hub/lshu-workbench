import { describe, expect, it } from 'vitest';
import {
  appleCalendarBanner,
  calendarConnectSuccessCopy,
  feishuCoverageBanner,
  shouldHintCalendarPermissionDialog,
  splitCalendarStatus,
} from './calendarStatus';

describe('Calendar 成功态文案', () => {
  it('fullAccess 成功后不提示等待弹窗', () => {
    const copy = calendarConnectSuccessCopy('fullAccess', 1);
    expect(copy).toBe('Apple Calendar 已连接 · 完整访问 · 已读取 1 条事件');
    expect(copy).not.toMatch(/弹窗|请允许|已请求日历权限|请等待/);
    expect(shouldHintCalendarPermissionDialog('fullAccess')).toBe(false);
    expect(appleCalendarBanner({ available: true, permission: 'fullAccess', itemsRead: 1 })).toBeNull();
  });

  it('feishu_coverage 不把 Apple Calendar 标成失败', () => {
    const split = splitCalendarStatus({ appleAvailable: true, coverageError: 'feishu_coverage' });
    expect(split.apple).toBe('已连接');
    expect(split.feishuCoverage).toBe('不完整');
    expect(feishuCoverageBanner('feishu_coverage')).toBe('飞书日程覆盖：不完整');
    expect(appleCalendarBanner({ available: true, permission: 'fullAccess' })).toBeNull();
  });
});
