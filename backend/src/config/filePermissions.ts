import { chmodSync, mkdirSync, existsSync, statSync } from 'node:fs';

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* ignore if chmod unsupported */
  }
}

export function ensurePrivateFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

export function modeOf(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}
