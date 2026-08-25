export const BACKEND_INTERRUPTED_MESSAGE =
  '后端服务连接中断，可能发生了进程重启。请确认后端稳定运行后重试。';

export type ApiClientError = Error & { status?: number; code?: string };

function looksLikeHtml(body: string): boolean {
  const trimmed = body.trim();
  return /^<!DOCTYPE/i.test(trimmed) || /^<html[\s>]/i.test(trimmed) || (trimmed.startsWith('<') && trimmed.includes('</'));
}

export function parseApiError(status: number, body: string, method: string, path: string): ApiClientError {
  const trimmed = (body || '').trim();
  let message = `请求失败 ${status}`;
  let code: string | undefined;

  if (!trimmed) {
    message = BACKEND_INTERRUPTED_MESSAGE;
    code = 'BACKEND_INTERRUPTED';
  } else if (looksLikeHtml(trimmed)) {
    message = status >= 500 ? BACKEND_INTERRUPTED_MESSAGE : '服务器返回了无法解析的页面。';
    code = 'BACKEND_HTML_ERROR';
  } else {
    try {
      const parsed = JSON.parse(trimmed) as { code?: unknown; message?: unknown };
      if (typeof parsed.code === 'string' && parsed.code) code = parsed.code;
      if (typeof parsed.message === 'string' && parsed.message) message = parsed.message;
      if (code === 'ACCOUNT_MISMATCH') message = (typeof parsed.message === 'string' && parsed.message) || '账号不匹配';
    } catch {
      message = trimmed.slice(0, 240);
    }
  }

  console.warn('[api]', method, path, status, code || '');
  const err = new Error(message) as ApiClientError;
  err.status = status;
  err.code = code;
  return err;
}

export function parseNetworkError(method: string, path: string): ApiClientError {
  return parseApiError(0, '', method, path);
}
