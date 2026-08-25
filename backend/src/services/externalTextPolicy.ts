export const EXTERNAL_TEXT_POLICY_VERSION = 'etp-v1';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<!\d)(?:1[3-9]\d{9}|\+?\d[\d\s-]{8,}\d)(?!\d)/g;
const ID_RE = /\b\d{17}[\dXx]\b/g;
const TOKEN_RE = /\b(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}\b/gi;
const PATH_RE = /(?:\/Users\/[^\s"'，。]+|\/home\/[^\s"']+|\/var\/[^\s"']+)/g;
const QUERY_RE = /https?:\/\/[^\s"']+\?[^\s"']+/gi;

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\s]+$/u;
const THANKS = /^(谢谢|感谢|thanks|thx|ok|好的|收到|嗯嗯)[!！.。]*$/i;

export function sanitizeExternalText(text: string, maxChars: number): string {
  let out = String(text || '');
  out = out.replace(TOKEN_RE, '[redacted-token]');
  out = out.replace(EMAIL_RE, '[redacted-email]');
  out = out.replace(ID_RE, '[redacted-id]');
  out = out.replace(PHONE_RE, '[redacted-phone]');
  out = out.replace(QUERY_RE, '[redacted-url]');
  out = out.replace(PATH_RE, '[redacted-path]');
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}

export function isLowInformation(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return true;
  if (EMOJI_ONLY.test(t)) return true;
  if (THANKS.test(t)) return true;
  if (/^https?:\/\/\S+$/i.test(t)) return true;
  return t.length < 2;
}

export function containsHtmlOrControl(text: string): boolean {
  return /<[^>]+>/.test(text) || /[\u0000-\u0008]/.test(text);
}
