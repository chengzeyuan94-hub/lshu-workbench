import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMoneyCatsSync, type MoneyCatsSyncPaths } from './moneyCatsSync';

function createSource(path: string, valid = true): void {
  const db = new Database(path);
  try {
    if (!valid) {
      db.exec('CREATE TABLE unexpected (id TEXT);');
      return;
    }
    db.exec(`
      CREATE TABLE bookkeep (
        bid TEXT,
        costcome INTEGER,
        price TEXT,
        ymdDate TEXT,
        ymdtime TEXT,
        nocost INTEGER,
        refund INTEGER,
        title TEXT,
        sourcecurrency TEXT
      );
      INSERT INTO bookkeep VALUES
        ('expense', 0, '12.34', '2026-08-25', '1787616000', 0, 0, '伙食', '¥'),
        ('income', 1, '50.00', '2026-08-25', '1787619600', 0, 0, '收入', '¥');
    `);
  } finally {
    db.close();
  }
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('MoneyCats deterministic sync', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ root: string; paths: MoneyCatsSyncPaths }> {
    const root = await mkdtemp(join(tmpdir(), 'finance-sync-test-'));
    temporaryDirectories.push(root);
    const source = join(root, 'user_database.db');
    return {
      root,
      paths: {
        source,
        allowedRoot: root,
        currentOutput: join(root, 'data/current.json'),
        baselineOutput: join(root, 'data/baseline.json'),
        lastRunOutput: join(root, 'data/last-run.json'),
        lockPath: join(root, 'locks/sync.lock'),
      },
    };
  }

  it('reads a snapshot without changing the source and writes integer-minor-unit aggregates', async () => {
    const { paths } = await fixture();
    createSource(paths.source);
    const before = await readFile(paths.source);

    const result = await runMoneyCatsSync({
      paths,
      asOf: '2026-08-25',
      trigger: 'test',
      now: () => new Date('2026-08-25T02:00:00.000Z'),
    });

    const after = await readFile(paths.source);
    expect(digest(after)).toBe(digest(before));
    expect(result.run).toMatchObject({ status: 'success', trigger: 'test', rowsRead: 2 });
    expect(result.baseline.periods.week).toMatchObject({
      incomeMinor: 5_000,
      expenseMinor: 1_234,
      netMinor: 3_766,
    });
    expect(Number.isInteger(result.baseline.periods.week.netMinor)).toBe(true);
  });

  it('keeps the previous current.json when a later parse fails', async () => {
    const { paths } = await fixture();
    createSource(paths.source);
    await runMoneyCatsSync({ paths, asOf: '2026-08-25' });
    const previous = await readFile(paths.currentOutput, 'utf8');

    await rm(paths.source);
    createSource(paths.source, false);
    await expect(runMoneyCatsSync({ paths, asOf: '2026-08-25' }))
      .rejects.toThrow('FINANCE_SCHEMA_UNSUPPORTED');

    expect(await readFile(paths.currentOutput, 'utf8')).toBe(previous);
    const lastRun = JSON.parse(await readFile(paths.lastRunOutput, 'utf8')) as Record<string, unknown>;
    expect(lastRun).toMatchObject({ status: 'failed', errorCode: 'FINANCE_SCHEMA_UNSUPPORTED' });
  });

  it('rejects a concurrent cross-process lock', async () => {
    const { paths } = await fixture();
    createSource(paths.source);
    await mkdir(dirname(paths.lockPath), { recursive: true });
    await writeFile(paths.lockPath, '{}');

    await expect(runMoneyCatsSync({ paths, asOf: '2026-08-25' }))
      .rejects.toThrow('FINANCE_SYNC_ALREADY_RUNNING');
  });
});
