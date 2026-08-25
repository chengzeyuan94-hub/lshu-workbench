import { readFile } from 'node:fs/promises';
import {
  FINANCE_SCHEMA_VERSION,
  FINANCE_TIMEZONE,
  localDateFor,
  type FinanceCategoryPoint,
  type FinanceDailyPoint,
  type FinancePeriodSummary,
  type MoneyCatsBaseline,
} from './moneyCatsBaseline';
import {
  resolveMoneyCatsSyncPaths,
  runMoneyCatsSync,
  type FinanceRunRecord,
  type MoneyCatsSyncOptions,
  type MoneyCatsSyncPaths,
  type MoneyCatsSyncResult,
} from './moneyCatsSync';

export type FinanceRuntimeState = 'ready' | 'stale' | 'syncing' | 'unavailable' | 'error';

interface FailedRunRecord {
  status: 'failed';
  trigger: string;
  startedAt: string;
  finishedAt: string;
  errorCode: string;
}

type StoredRunRecord = FinanceRunRecord | FailedRunRecord;

export interface FinanceRuntimeStatus {
  status: FinanceRuntimeState;
  lastRunAt: string | null;
  nextScheduledAt: string;
  isStale: boolean;
  errorCode?: string;
}

export interface FinanceOverview {
  schemaVersion: string;
  generatedAt: string;
  asOf: string;
  timezone: string;
  currency: 'CNY';
  source: {
    label: string;
    fileName: string;
    sizeBytes: number;
    modifiedAt: string;
    firstTransactionDate: string | null;
    latestTransactionDate: string | null;
    latestTransactionAt: string | null;
    totalRows: number;
    includedRows: number;
  };
  periods: {
    week: FinancePeriodSummary;
    month: FinancePeriodSummary;
    year: FinancePeriodSummary;
  };
  currentMonthDaily: FinanceDailyPoint[];
  currentMonthExpenseTop: FinanceCategoryPoint[];
  quality: MoneyCatsBaseline['quality'];
  runtimeStatus: FinanceRuntimeStatus;
}

export interface FinanceStatusResponse extends FinanceRuntimeStatus {
  syncing: boolean;
  lastRun: StoredRunRecord | null;
  currentData: {
    generatedAt: string;
    asOf: string;
    sourceModifiedAt: string;
    latestTransactionAt: string | null;
    totalRows: number;
  } | null;
}

export class FinanceServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

type SyncRunner = (options: MoneyCatsSyncOptions) => Promise<MoneyCatsSyncResult>;

export interface FinanceServiceOptions {
  paths?: Partial<MoneyCatsSyncPaths>;
  now?: () => Date;
  syncRunner?: SyncRunner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

const PERIOD_MINOR_FIELDS = [
  'incomeMinor',
  'expenseMinor',
  'netMinor',
  'refundIncomeMinor',
  'netSpendingMinor',
] as const;

const PERIOD_COUNT_FIELDS = ['incomeCount', 'expenseCount', 'transactionCount'] as const;

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isPeriod(value: unknown): value is FinancePeriodSummary {
  if (!isRecord(value) || typeof value.from !== 'string' || typeof value.to !== 'string') return false;
  return [...PERIOD_MINOR_FIELDS, ...PERIOD_COUNT_FIELDS].every((field) => isSafeInteger(value[field]));
}

function isMoneyCatsBaseline(value: unknown): value is MoneyCatsBaseline {
  if (!isRecord(value)) return false;
  return value.schemaVersion === FINANCE_SCHEMA_VERSION
    && typeof value.generatedAt === 'string'
    && typeof value.asOf === 'string'
    && value.timezone === FINANCE_TIMEZONE
    && value.currency === 'CNY'
    && isRecord(value.source)
    && isRecord(value.periods)
    && isPeriod(value.periods.week)
    && isPeriod(value.periods.month)
    && isPeriod(value.periods.year)
    && Array.isArray(value.currentMonthDaily)
    && value.currentMonthDaily.every((point) => isRecord(point)
      && typeof point.date === 'string'
      && isSafeInteger(point.incomeMinor)
      && isSafeInteger(point.expenseMinor)
      && isSafeInteger(point.netMinor))
    && Array.isArray(value.currentMonthExpenseTop)
    && value.currentMonthExpenseTop.every((point) => isRecord(point)
      && typeof point.category === 'string'
      && isSafeInteger(point.expenseMinor)
      && isSafeInteger(point.transactionCount))
    && isRecord(value.quality);
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^FINANCE_[A-Z0-9_]+$/.test(value)
    ? value
    : undefined;
}

function sanitizeRun(value: unknown): StoredRunRecord | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  const trigger = typeof value.trigger === 'string' ? value.trigger.slice(0, 40) : 'unknown';
  const startedAt = typeof value.startedAt === 'string' ? value.startedAt : '';
  const finishedAt = typeof value.finishedAt === 'string' ? value.finishedAt : '';
  if (!startedAt || !finishedAt) return null;
  if (status === 'success') {
    if (
      typeof value.asOf !== 'string'
      || !Number.isSafeInteger(value.rowsRead)
      || Number(value.rowsRead) < 0
    ) return null;
    return {
      status,
      trigger,
      startedAt,
      finishedAt,
      asOf: value.asOf,
      rowsRead: Number(value.rowsRead),
    };
  }
  if (status === 'failed') {
    return {
      status,
      trigger,
      startedAt,
      finishedAt,
      errorCode: safeErrorCode(value.errorCode) ?? 'FINANCE_SYNC_FAILED',
    };
  }
  return null;
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function dateParts(date: Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: FINANCE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour') };
}

export function nextFinanceUpdateAt(now = new Date()): string {
  const parts = dateParts(now);
  const todayAtTenUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 2, 0, 0);
  const nextUtc = now.getTime() < todayAtTenUtc ? todayAtTenUtc : todayAtTenUtc + 24 * 60 * 60 * 1000;
  const next = new Date(nextUtc);
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: FINANCE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(next);
  return `${ymd}T10:00:00+08:00`;
}

function runtimeStatus(
  baseline: MoneyCatsBaseline | null,
  run: StoredRunRecord | null,
  syncing: boolean,
  now: Date,
): FinanceRuntimeStatus {
  const staleByDate = baseline ? baseline.asOf !== localDateFor(now) : true;
  const failed = run?.status === 'failed';
  const isStale = staleByDate || failed || !baseline;
  let status: FinanceRuntimeState;
  if (syncing) status = 'syncing';
  else if (!baseline) status = failed ? 'error' : 'unavailable';
  else if (failed) status = 'error';
  else status = isStale ? 'stale' : 'ready';
  return {
    status,
    lastRunAt: run?.finishedAt ?? null,
    nextScheduledAt: nextFinanceUpdateAt(now),
    isStale,
    ...(failed ? { errorCode: run.errorCode } : {}),
  };
}

function publicPeriod(period: FinancePeriodSummary): FinancePeriodSummary {
  return {
    from: period.from,
    to: period.to,
    incomeMinor: period.incomeMinor,
    expenseMinor: period.expenseMinor,
    netMinor: period.netMinor,
    refundIncomeMinor: period.refundIncomeMinor,
    netSpendingMinor: period.netSpendingMinor,
    incomeCount: period.incomeCount,
    expenseCount: period.expenseCount,
    transactionCount: period.transactionCount,
  };
}

function publicOverview(
  baseline: MoneyCatsBaseline,
  run: StoredRunRecord | null,
  syncing: boolean,
  now: Date,
): FinanceOverview {
  return {
    schemaVersion: baseline.schemaVersion,
    generatedAt: baseline.generatedAt,
    asOf: baseline.asOf,
    timezone: baseline.timezone,
    currency: baseline.currency,
    source: {
      label: 'MoneyCats 本地备份',
      fileName: 'user_database.db',
      sizeBytes: baseline.source.sizeBytes,
      modifiedAt: baseline.source.modifiedAt,
      firstTransactionDate: baseline.source.firstTransactionDate,
      latestTransactionDate: baseline.source.latestTransactionDate,
      latestTransactionAt: baseline.source.latestTransactionAt,
      totalRows: baseline.source.totalRows,
      includedRows: baseline.source.includedRows,
    },
    periods: {
      week: publicPeriod(baseline.periods.week),
      month: publicPeriod(baseline.periods.month),
      year: publicPeriod(baseline.periods.year),
    },
    currentMonthDaily: baseline.currentMonthDaily.map((point) => ({
      date: point.date,
      incomeMinor: point.incomeMinor,
      expenseMinor: point.expenseMinor,
      netMinor: point.netMinor,
    })),
    currentMonthExpenseTop: baseline.currentMonthExpenseTop.map((point) => ({
      category: point.category,
      expenseMinor: point.expenseMinor,
      transactionCount: point.transactionCount,
    })),
    quality: {
      quickCheck: baseline.quality.quickCheck,
      duplicateIdRows: baseline.quality.duplicateIdRows,
      blankIdRows: baseline.quality.blankIdRows,
      invalidDateRows: baseline.quality.invalidDateRows,
      futureRows: baseline.quality.futureRows,
      invalidAmountRows: baseline.quality.invalidAmountRows,
      invalidDirectionRows: baseline.quality.invalidDirectionRows,
      excludedNoCostRows: baseline.quality.excludedNoCostRows,
      currencies: [...baseline.quality.currencies],
    },
    runtimeStatus: runtimeStatus(baseline, run, syncing, now),
  };
}

export class FinanceService {
  private readonly paths: MoneyCatsSyncPaths;
  private readonly now: () => Date;
  private readonly syncRunner: SyncRunner;
  private syncing = false;

  constructor(options: FinanceServiceOptions = {}) {
    this.paths = resolveMoneyCatsSyncPaths(options.paths);
    this.now = options.now ?? (() => new Date());
    this.syncRunner = options.syncRunner ?? runMoneyCatsSync;
  }

  private async currentBaseline(): Promise<MoneyCatsBaseline | null> {
    const value = await readJson(this.paths.currentOutput);
    return isMoneyCatsBaseline(value) ? value : null;
  }

  private async lastRun(): Promise<StoredRunRecord | null> {
    return sanitizeRun(await readJson(this.paths.lastRunOutput));
  }

  async getOverview(): Promise<FinanceOverview> {
    const [baseline, run] = await Promise.all([this.currentBaseline(), this.lastRun()]);
    if (!baseline) {
      throw new FinanceServiceError('FINANCE_DATA_UNAVAILABLE', 503, '财务数据尚不可用，请先更新账本');
    }
    return publicOverview(baseline, run, this.syncing, this.now());
  }

  async getStatus(): Promise<FinanceStatusResponse> {
    const [baseline, run] = await Promise.all([this.currentBaseline(), this.lastRun()]);
    return {
      ...runtimeStatus(baseline, run, this.syncing, this.now()),
      syncing: this.syncing,
      lastRun: run,
      currentData: baseline ? {
        generatedAt: baseline.generatedAt,
        asOf: baseline.asOf,
        sourceModifiedAt: baseline.source.modifiedAt,
        latestTransactionAt: baseline.source.latestTransactionAt,
        totalRows: baseline.source.totalRows,
      } : null,
    };
  }

  async sync(): Promise<{ run: FinanceRunRecord; overview: FinanceOverview }> {
    if (this.syncing) {
      throw new FinanceServiceError('FINANCE_SYNC_ALREADY_RUNNING', 409, '账本正在更新，请稍后再试');
    }
    this.syncing = true;
    try {
      const result = await this.syncRunner({
        trigger: 'api',
        paths: this.paths,
        now: this.now,
      });
      return {
        run: result.run,
        overview: publicOverview(result.baseline, result.run, false, this.now()),
      };
    } catch (error) {
      const code = safeErrorCode(error instanceof Error ? error.message : undefined);
      if (code === 'FINANCE_SYNC_ALREADY_RUNNING') {
        throw new FinanceServiceError(code, 409, '账本正在更新，请稍后再试');
      }
      throw new FinanceServiceError('FINANCE_SYNC_FAILED', 500, '账本更新失败，已保留上一次成功数据');
    } finally {
      this.syncing = false;
    }
  }
}
