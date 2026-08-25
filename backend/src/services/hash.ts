import { createHash } from 'node:crypto';

export function sha256(...parts: Array<string | number | null | undefined>): string {
  const hash = createHash('sha256');
  hash.update(parts.map((p) => String(p ?? '')).join('\n'));
  return hash.digest('hex');
}

export function fingerprintSource(sourceType: string, externalId: string, extra = ''): string {
  return `${sourceType}:${sha256(sourceType, externalId, extra).slice(0, 32)}`;
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[“”"'\s\p{P}\p{S}]+/gu, '')
    .slice(0, 80);
}
