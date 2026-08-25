const TOKEN_RE = /(token|secret|authorization|bearer)["'\s:=]+[^\s"',}]+/gi;
const PATH_RE = /\/Users\/[^/\s]+\/[^\s"']+/g;
const SK_RE = /\bsk-[A-Za-z0-9]{8,}\b/g;

export function redactText(input: string, maxLen = 240): string {
  const redacted = input
    .replace(SK_RE, 'sk-[redacted]')
    .replace(TOKEN_RE, '$1=[redacted]')
    .replace(PATH_RE, (m) => {
      const parts = m.split('/');
      return `/…/${parts[parts.length - 1] || ''}`;
    })
    .replace(/https?:\/\/[^\s"']+/g, '[link]');
  return redacted.length > maxLen ? `${redacted.slice(0, maxLen)}…` : redacted;
}

export function truncateSummary(text: string, maxLen = 160): string {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}…` : compact;
}
