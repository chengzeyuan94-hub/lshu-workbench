import { basename, dirname, extname } from 'node:path';
import { sha256 } from './hash';

export const DESKTOP_DLP_VERSION = 'ddl-v31';

const SECRET_PATH_TOKENS = [
  'env',
  'credential',
  'credentials',
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwd',
  'cookie',
  'cookies',
  'session',
  'authorization',
  'privatekey',
  'private-key',
  'ssh',
  'pem',
  'p12',
  'mobileprovision',
  'keychain',
  'keystore',
  '登录',
  '密码',
  '密钥',
  '凭证',
  'idrsa',
  'ided25519',
];

const BLOCKED_EXT = new Set([
  'pem',
  'p12',
  'pfx',
  'key',
  'crt',
  'cer',
  'der',
  'mobileprovision',
  'keystore',
  'jks',
  'kdbx',
  'ovpn',
]);

const BLOCKED_DIR_TOKENS = new Set(['.ssh', '.gnupg', '.aws', '.kube', 'keychain']);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?<!\d)(?:1[3-9]\d{9}|\+\d[\d-]{8,}\d)(?!\d)/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
const SK_RE = /\bsk-[A-Za-z0-9]{8,}\b/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+=/]{8,}\b/i;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const COOKIE_RE = /(?:^|[;\s])(?:Set-Cookie|Cookie)\s*[:=]/i;
const CONN_RE = /(?:postgres(?:ql)?|mysql|mongodb|redis|amqp):\/\/\S+/i;
const PASS_PAIR_RE = /(?:password|passwd|pwd)\s*[:=]\s*\S+/i;

export type DesktopBlockReason =
  | 'secret_filename'
  | 'secret_path'
  | 'secret_extension'
  | 'secret_directory'
  | 'content_secret';

export interface DesktopPathVerdict {
  blocked: boolean;
  reasonCode?: DesktopBlockReason;
}

export function normalizeIdentityText(input: string): string {
  return String(input || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[._\-/\s\\]+/g, '');
}

function pathParts(filePath: string): string[] {
  return String(filePath || '')
    .split(/[/\\]+/)
    .filter(Boolean);
}

export function classifyDesktopPath(filePath: string, allowlistHashes: string[] = []): DesktopPathVerdict {
  const opaque = sha256('desktop-path', filePath);
  if (allowlistHashes.includes(opaque)) return { blocked: false };
  const name = basename(filePath);
  const ext = extname(name).replace('.', '').toLowerCase();
  const parent = basename(dirname(filePath));
  const normalizedName = normalizeIdentityText(name);
  const normalizedPath = normalizeIdentityText(filePath);
  if (BLOCKED_EXT.has(ext)) return { blocked: true, reasonCode: 'secret_extension' };
  if (BLOCKED_DIR_TOKENS.has(parent.toLowerCase()) || BLOCKED_DIR_TOKENS.has(name.toLowerCase())) {
    return { blocked: true, reasonCode: 'secret_directory' };
  }
  if (name.startsWith('.env') || normalizedName.includes('envlocal') || normalizedName.includes('dotenv')) {
    return { blocked: true, reasonCode: 'secret_filename' };
  }
  for (const token of SECRET_PATH_TOKENS) {
    const n = normalizeIdentityText(token);
    if (normalizedName.includes(n)) return { blocked: true, reasonCode: 'secret_filename' };
    if (normalizedPath.includes(n)) return { blocked: true, reasonCode: 'secret_path' };
  }
  return { blocked: false };
}

export function detectContentSecrets(text: string): boolean {
  const raw = String(text || '');
  if (!raw) return false;
  return (
    SK_RE.test(raw) ||
    JWT_RE.test(raw) ||
    BEARER_RE.test(raw) ||
    PRIVATE_KEY_RE.test(raw) ||
    COOKIE_RE.test(raw) ||
    CONN_RE.test(raw) ||
    PASS_PAIR_RE.test(raw)
  );
}

export function looksIdentifyingLabel(name: string): boolean {
  const raw = String(name || '');
  if (EMAIL_RE.test(raw) || PHONE_RE.test(raw)) return true;
  const n = normalizeIdentityText(raw);
  return SECRET_PATH_TOKENS.some((t) => n.includes(normalizeIdentityText(t)));
}

export function safeDocumentLabel(name: string, fallbackSeed: string): string {
  const base = basename(String(name || 'file'));
  if (!base || looksIdentifyingLabel(base) || looksIdentifyingLabel(dirname(name))) {
    return `document_${sha256('label', fallbackSeed).slice(0, 12)}`;
  }
  const ext = extname(base).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  return ext ? `document_${ext}` : 'document_file';
}

export function assertModelPayloadSafe(serialized: string): void {
  const text = String(serialized || '');
  if (
    detectContentSecrets(text) ||
    /\/Users\//.test(text) ||
    /\/home\//.test(text) ||
    /sourceExternalId|action_identity|payload_json/.test(text)
  ) {
    throw new Error('DLP_BLOCKED');
  }
}
