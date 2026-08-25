import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerFinanceRoutes } from '../financeRoutes';
import {
  FinanceService,
  FinanceServiceError,
  nextFinanceUpdateAt,
} from './financeService';
import { buildMoneyCatsBaseline, type MoneyCatsBaseline } from './moneyCatsBaseline';
import type { FinanceRunRecord, MoneyCatsSyncPaths } from './moneyCatsSync';

function baseline(): MoneyCatsBaseline {
  const db = new Database(':memory:');
  try {
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
    return buildMoneyCatsBaseline(db, {
      asOf: '2026-08-25',
      generatedAt: '2026-08-25T02:00:00.000Z',
      source: {
        sizeBytes: 2_000,
        modifiedAt: '2026-08-25T01:00:00.000Z',
        sha256: 'private-source-hash',
      },
    });
  } finally {
    db.close();
  }
}

describe('Finance API service', () => {
  const temporaryDirectories: string[] = [];
  const servers: Array<{ close: (callback: (error?: Error) => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => error ? reject(error) : resolve());
    })));
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function paths(): Promise<MoneyCatsSyncPaths> {
    const root = await mkdtemp(join(tmpdir(), 'finance-service-test-'));
    temporaryDirectories.push(root);
    return {
      source: join(root, 'user_database.db'),
      allowedRoot: root,
      currentOutput: join(root, 'current.json'),
      baselineOutput: join(root, 'baseline.json'),
      lastRunOutput: join(root, 'last-run.json'),
      lockPath: join(root, 'sync.lock'),
    };
  }

  it('calculates the next local 10:00 update boundary', () => {
    expect(nextFinanceUpdateAt(new Date('2026-08-25T01:59:59.000Z')))
      .toBe('2026-08-25T10:00:00+08:00');
    expect(nextFinanceUpdateAt(new Date('2026-08-25T02:00:00.000Z')))
      .toBe('2026-08-26T10:00:00+08:00');
  });

  it('returns only aggregate DTOs and never exposes source hashes, paths, or transaction notes', async () => {
    const files = await paths();
    const current = baseline();
    await writeFile(files.currentOutput, JSON.stringify(current));
    await writeFile(files.lastRunOutput, JSON.stringify({
      status: 'success',
      trigger: 'launchd',
      startedAt: '2026-08-25T02:00:00.000Z',
      finishedAt: '2026-08-25T02:00:03.000Z',
      asOf: '2026-08-25',
      rowsRead: 2,
      sourceHash: 'must-not-leak',
      rawDbPath: '/private/user_database.db',
      transactionNote: 'must-not-leak',
    }));
    const service = new FinanceService({
      paths: files,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });
    const app = express();
    registerFinanceRoutes(app, { service });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const overviewResponse = await fetch(`http://127.0.0.1:${port}/api/finance/overview`);
    const overview = await overviewResponse.json() as Record<string, unknown>;
    expect(overviewResponse.status).toBe(200);
    expect(overview).toMatchObject({
      asOf: '2026-08-25',
      currency: 'CNY',
      runtimeStatus: {
        status: 'ready',
        isStale: false,
        nextScheduledAt: '2026-08-26T10:00:00+08:00',
      },
    });
    expect(overview).toHaveProperty('periods.week.incomeMinor', 5_000);
    expect(overview).toHaveProperty('periods.week.expenseMinor', 1_234);
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain('private-source-hash');
    expect(serialized).not.toContain('/private/user_database.db');
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('metricDefinition');

    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/finance/status`);
    const status = await statusResponse.json() as Record<string, unknown>;
    expect(statusResponse.status).toBe(200);
    expect(status).toMatchObject({
      status: 'ready',
      syncing: false,
      currentData: { asOf: '2026-08-25', totalRows: 2 },
      lastRun: { status: 'success', rowsRead: 2 },
    });
    expect(JSON.stringify(status)).not.toContain('sourceHash');
  });

  it('prevents API re-entry and marks a retained baseline stale after a failed run', async () => {
    const files = await paths();
    const current = baseline();
    await writeFile(files.currentOutput, JSON.stringify(current));
    await writeFile(files.lastRunOutput, JSON.stringify({
      status: 'failed',
      trigger: 'launchd',
      startedAt: '2026-08-25T04:00:00.000Z',
      finishedAt: '2026-08-25T04:00:01.000Z',
      errorCode: 'FINANCE_SOURCE_BUSY',
    }));
    let resolveSync: ((value: { run: FinanceRunRecord; baseline: MoneyCatsBaseline }) => void) | undefined;
    const service = new FinanceService({
      paths: files,
      now: () => new Date('2026-08-25T05:00:00.000Z'),
      syncRunner: () => new Promise((resolve) => { resolveSync = resolve; }),
    });

    const before = await service.getStatus();
    expect(before).toMatchObject({ status: 'error', isStale: true, errorCode: 'FINANCE_SOURCE_BUSY' });
    const first = service.sync();
    await expect(service.sync()).rejects.toMatchObject({
      code: 'FINANCE_SYNC_ALREADY_RUNNING',
      httpStatus: 409,
    } satisfies Partial<FinanceServiceError>);
    expect((await service.getStatus()).status).toBe('syncing');

    const run: FinanceRunRecord = {
      status: 'success',
      trigger: 'api',
      startedAt: '2026-08-25T05:00:00.000Z',
      finishedAt: '2026-08-25T05:00:03.000Z',
      asOf: '2026-08-25',
      rowsRead: 2,
    };
    resolveSync?.({ run, baseline: current });
    const result = await first;
    expect(result).toMatchObject({ run: { trigger: 'api' }, overview: { runtimeStatus: { status: 'ready' } } });
  });

  it('returns an honest unavailable status before the first successful baseline', async () => {
    const service = new FinanceService({
      paths: await paths(),
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(await service.getStatus()).toMatchObject({
      status: 'unavailable',
      syncing: false,
      isStale: true,
      currentData: null,
    });
    await expect(service.getOverview()).rejects.toMatchObject({
      code: 'FINANCE_DATA_UNAVAILABLE',
      httpStatus: 503,
    } satisfies Partial<FinanceServiceError>);
  });
});
