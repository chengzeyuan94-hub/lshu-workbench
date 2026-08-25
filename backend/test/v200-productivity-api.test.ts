import { describe, expect, it } from 'vitest';
import { mapProductivityError, ProductivityError, PRODUCTIVITY_ERROR_CODES } from '../src/connectors/errors';
import { emptyStateText, todoActionFlags } from '../src/services/todoActions';

describe('API 错误码与前端按钮/空态', () => {
  it('映射 400/401/403/409/503', () => {
    expect(mapProductivityError(new ProductivityError(PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR, 'bad')).status).toBe(400);
    expect(mapProductivityError(new ProductivityError(PRODUCTIVITY_ERROR_CODES.FEISHU_UNAUTHORIZED, 'auth')).status).toBe(401);
    expect(mapProductivityError(new ProductivityError(PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED, 'scope')).status).toBe(403);
    expect(mapProductivityError(new ProductivityError(PRODUCTIVITY_ERROR_CODES.EXTERNAL_WRITE_DISABLED, 'off')).status).toBe(403);
    expect(mapProductivityError(new ProductivityError(PRODUCTIVITY_ERROR_CODES.THINGS_PERMISSION_DENIED, 'perm')).status).toBe(403);
    expect(mapProductivityError(new ProductivityError(PRODUCTIVITY_ERROR_CODES.SYNC_IN_PROGRESS, 'lock')).status).toBe(409);
    expect(mapProductivityError(new ProductivityError(PRODUCTIVITY_ERROR_CODES.CALENDAR_CONFLICT, 'busy')).status).toBe(409);
    expect(mapProductivityError(new ProductivityError(PRODUCTIVITY_ERROR_CODES.THINGS_UNAVAILABLE, 'down')).status).toBe(503);
    expect(mapProductivityError(new ProductivityError(PRODUCTIVITY_ERROR_CODES.NO_AVAILABLE_SLOT, 'full')).status).toBe(503);
  });

  it('自动排程关闭时确认排入日历按钮禁用', () => {
    const flags = todoActionFlags({ status: 'confirmed', lifecycleStatus: 'confirmed', autoScheduleEnabled: false, calendarAvailable: true });
    expect(flags.canPlan).toBe(true);
    expect(flags.canCommitPlan).toBe(false);
    expect(flags.canComplete).toBe(true);
    expect(todoActionFlags({ status: 'ignored', lifecycleStatus: 'ignored' }).canConfirm).toBe(false);
  });

  it('空态文案覆盖各视图', () => {
    expect(emptyStateText('pending')).toContain('智能收件箱');
    expect(emptyStateText('today')).toContain('今天');
    expect(emptyStateText('suspected_done')).toContain('疑似');
  });
});
