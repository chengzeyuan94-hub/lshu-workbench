import { describe, expect, it, vi } from 'vitest';
import { BACKEND_INTERRUPTED_MESSAGE, parseApiError, parseNetworkError } from './parseApiError';

describe('parseApiError', () => {
  it('空 body 的 500 只给出进程中断文案一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = parseApiError(500, '', 'POST', '/productivity/sync/commit');
    expect(err.message).toBe(BACKEND_INTERRUPTED_MESSAGE);
    expect(err.status).toBe(500);
    expect(err.code).toBe('BACKEND_INTERRUPTED');
    expect(err.message).not.toMatch(/undefined/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain('POST');
    expect(String(warn.mock.calls[0])).toContain('/productivity/sync/commit');
    warn.mockRestore();
  });

  it('HTML 500 不把页面原文塞进 UI', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = parseApiError(500, '<html><body>Internal Server Error</body></html>', 'GET', '/todos');
    expect(err.message).toBe(BACKEND_INTERRUPTED_MESSAGE);
    expect(err.message).not.toContain('<html>');
    warn.mockRestore();
  });

  it('JSON 错误使用服务端 message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = parseApiError(403, JSON.stringify({ code: 'CALENDAR_WRITE_ONLY', message: '仅有写入权限，需要完整访问。' }), 'POST', '/productivity/calendar/connect');
    expect(err.code).toBe('CALENDAR_WRITE_ONLY');
    expect(err.message).toBe('仅有写入权限，需要完整访问。');
    warn.mockRestore();
  });

  it('网络中断与空 500 使用同一提示', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = parseNetworkError('POST', '/productivity/sync/commit');
    expect(err.message).toBe(BACKEND_INTERRUPTED_MESSAGE);
    warn.mockRestore();
  });
});
