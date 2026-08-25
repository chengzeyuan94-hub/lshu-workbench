const SENSITIVE_NAME = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i;

const ALLOW = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'SHELL',
  'XPC_SERVICE_NAME',
  'XPC_FLAGS',
  '__CF_USER_TEXT_ENCODING',
]);

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

/** Minimal environment for child processes. Never forwards API keys or tokens. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!value) continue;
    if (isSensitiveEnvName(key)) continue;
    if (ALLOW.has(key) || key.startsWith('LC_')) {
      out[key] = value;
    }
  }
  if (!out.PATH && base.PATH) out.PATH = base.PATH;
  return out;
}
