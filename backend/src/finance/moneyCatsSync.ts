import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMoneyCatsBaseline,
  localDateFor,
  type MoneyCatsBaseline,
} from './moneyCatsBaseline';

export const DEFAULT_MONEYCATS_ALLOWED_ROOT = join(
  homedir(),
  'Library/Mobile Documents/iCloud~com~maliquankai~savemoney/Documents',
);
export const DEFAULT_MONEYCATS_SOURCE = join(
  DEFAULT_MONEYCATS_ALLOWED_ROOT,
  'moneycats_backup.db/user_database.db',
);

export interface MoneyCatsSyncPaths {
  source: string;
  allowedRoot: string;
  currentOutput: string;
  baselineOutput: string;
  lastRunOutput: string;
  lockPath: string;
}

export interface FinanceRunRecord {
  status: 'success';
  trigger: string;
  startedAt: string;
  finishedAt: string;
  asOf: string;
  rowsRead: number;
}

export interface MoneyCatsSyncResult {
  run: FinanceRunRecord;
  baseline: MoneyCatsBaseline;
}

export interface MoneyCatsSyncOptions {
  trigger?: string;
  asOf?: string;
  paths?: Partial<MoneyCatsSyncPaths>;
  now?: () => Date;
}

function backendDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

export function defaultMoneyCatsSyncPaths(): MoneyCatsSyncPaths {
  const backendDir = backendDirectory();
  return {
    source: process.env.MONEYCATS_DB_PATH || DEFAULT_MONEYCATS_SOURCE,
    allowedRoot: process.env.MONEYCATS_ALLOWED_ROOT || DEFAULT_MONEYCATS_ALLOWED_ROOT,
    currentOutput: join(backendDir, 'data/finance/current.json'),
    baselineOutput: join(backendDir, 'data/finance/baseline.json'),
    lastRunOutput: join(backendDir, 'data/finance/last-run.json'),
    lockPath: join(backendDir, 'data/locks/moneycats-sync.lock'),
  };
}

export function resolveMoneyCatsSyncPaths(overrides: Partial<MoneyCatsSyncPaths> = {}): MoneyCatsSyncPaths {
  return { ...defaultMoneyCatsSyncPaths(), ...overrides };
}

async function sha256(path: string): Promise<string> {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function validateSourcePath(source: string, allowedRoot: string): Promise<string> {
  const resolvedAllowedRoot = await realpath(allowedRoot);
  const resolvedSource = await realpath(source);
  const outside = relative(resolvedAllowedRoot, resolvedSource);
  if (
    outside.startsWith(`..${sep}`)
    || outside === '..'
    || resolve(resolvedSource) === resolve(resolvedAllowedRoot)
  ) {
    throw new Error('FINANCE_SOURCE_OUTSIDE_ALLOWLIST');
  }
  if (basename(resolvedSource) !== 'user_database.db') {
    throw new Error('FINANCE_SOURCE_UNEXPECTED_FILE');
  }
  return resolvedSource;
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(lockPath), 0o700);
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    const lockStat = await stat(lockPath).catch(() => null);
    if (lockStat && Date.now() - lockStat.mtimeMs > 30 * 60 * 1000) {
      await rm(lockPath, { force: true });
      return acquireLock(lockPath);
    }
    throw new Error('FINANCE_SYNC_ALREADY_RUNNING', { cause: error });
  }
  return async () => {
    await rm(lockPath, { force: true });
  };
}

async function createConsistentSnapshot(sourcePath: string): Promise<{
  snapshotPath: string;
  cleanup: () => Promise<void>;
  sourceSize: number;
  sourceModifiedAt: string;
  sourceSha256: string;
}> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'lshu-moneycats-'));
    await chmod(temporaryDirectory, 0o700);
    const snapshotPath = join(temporaryDirectory, 'snapshot.db');
    const before = await stat(sourcePath);
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      source.pragma('query_only = ON');
      await source.backup(snapshotPath);
    } finally {
      source.close();
    }
    await chmod(snapshotPath, 0o600);
    const after = await stat(sourcePath);
    const sourceSha256 = await sha256(sourcePath);
    const final = await stat(sourcePath);
    if (
      before.size === after.size
      && before.mtimeMs === after.mtimeMs
      && after.size === final.size
      && after.mtimeMs === final.mtimeMs
    ) {
      return {
        snapshotPath,
        cleanup: () => rm(temporaryDirectory, { recursive: true, force: true }),
        sourceSize: final.size,
        sourceModifiedAt: final.mtime.toISOString(),
        sourceSha256,
      };
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
    if (attempt === 3) throw new Error('FINANCE_SOURCE_BUSY');
  }
  throw new Error('FINANCE_SOURCE_BUSY');
}

async function generateBaseline(
  source: string,
  allowedRoot: string,
  asOf: string,
  generatedAt: string,
): Promise<MoneyCatsBaseline> {
  const sourcePath = await validateSourcePath(source, allowedRoot);
  const snapshot = await createConsistentSnapshot(sourcePath);
  try {
    const db = new Database(snapshot.snapshotPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma('query_only = ON');
      return buildMoneyCatsBaseline(db, {
        asOf,
        generatedAt,
        source: {
          sizeBytes: snapshot.sourceSize,
          modifiedAt: snapshot.sourceModifiedAt,
          sha256: snapshot.sourceSha256,
        },
      });
    } finally {
      db.close();
    }
  } finally {
    await snapshot.cleanup();
  }
}

function safeErrorCode(error: unknown): string {
  const candidate = error instanceof Error ? error.message : '';
  return /^FINANCE_[A-Z0-9_]+$/.test(candidate) ? candidate : 'FINANCE_PARSE_FAILED';
}

export async function runMoneyCatsSync(options: MoneyCatsSyncOptions = {}): Promise<MoneyCatsSyncResult> {
  const paths = resolveMoneyCatsSyncPaths(options.paths);
  const now = options.now ?? (() => new Date());
  const trigger = options.trigger?.trim() || 'manual';
  const asOf = options.asOf || localDateFor(now());
  const releaseLock = await acquireLock(paths.lockPath);
  const startedAt = now().toISOString();
  try {
    const baseline = await generateBaseline(paths.source, paths.allowedRoot, asOf, now().toISOString());
    await writePrivateJson(paths.currentOutput, baseline);
    const baselineExists = await stat(paths.baselineOutput).then(() => true).catch(() => false);
    if (!baselineExists) {
      await writePrivateJson(paths.baselineOutput, baseline).catch(() => undefined);
    }
    const run: FinanceRunRecord = {
      status: 'success',
      trigger,
      startedAt,
      finishedAt: now().toISOString(),
      asOf: baseline.asOf,
      rowsRead: baseline.source.totalRows,
    };
    await writePrivateJson(paths.lastRunOutput, {
      ...run,
      sourceHash: baseline.source.sha256,
    }).catch(() => undefined);
    return { run, baseline };
  } catch (error) {
    await writePrivateJson(paths.lastRunOutput, {
      status: 'failed',
      trigger,
      startedAt,
      finishedAt: now().toISOString(),
      errorCode: safeErrorCode(error),
    }).catch(() => undefined);
    throw error;
  } finally {
    await releaseLock();
  }
}
