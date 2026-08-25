import type Database from 'better-sqlite3';

export const FINANCE_TIMEZONE = 'Asia/Shanghai';
export const FINANCE_SCHEMA_VERSION = 'moneycats-baseline-v1';

export type FinancePeriodKey = 'week' | 'month' | 'year';

export interface FinancePeriodSummary {
  from: string;
  to: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  refundIncomeMinor: number;
  netSpendingMinor: number;
  incomeCount: number;
  expenseCount: number;
  transactionCount: number;
}

export interface FinanceDailyPoint {
  date: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

export interface FinanceCategoryPoint {
  category: string;
  expenseMinor: number;
  transactionCount: number;
}

export interface MoneyCatsBaseline {
  schemaVersion: string;
  generatedAt: string;
  asOf: string;
  timezone: string;
  currency: 'CNY';
  source: {
    label: 'MoneyCats 本地备份';
    fileName: 'user_database.db';
    sizeBytes: number;
    modifiedAt: string;
    sha256: string;
    firstTransactionDate: string | null;
    latestTransactionDate: string | null;
    latestTransactionAt: string | null;
    totalRows: number;
    includedRows: number;
  };
  metricDefinition: {
    factTable: 'bookkeep';
    weekStartsOn: 'monday';
    incomeRule: 'costcome=1';
    expenseRule: 'costcome=0';
    exclusionRule: 'COALESCE(nocost,0)=1';
    transferRule: 'transfer table excluded';
    refundRule: 'gross cashflow retained; refund income also reported separately';
  };
  periods: Record<FinancePeriodKey, FinancePeriodSummary>;
  currentMonthDaily: FinanceDailyPoint[];
  currentMonthExpenseTop: FinanceCategoryPoint[];
  quality: {
    quickCheck: 'ok';
    duplicateIdRows: number;
    blankIdRows: number;
    invalidDateRows: number;
    futureRows: number;
    invalidAmountRows: number;
    invalidDirectionRows: number;
    excludedNoCostRows: number;
    currencies: string[];
  };
}

interface MoneyCatsRow {
  bid: string | null;
  costcome: number | null;
  price: string | null;
  ymdDate: string | null;
  ymdtime: string | null;
  nocost: number | null;
  refund: number | null;
  title: string | null;
  sourcecurrency: string | null;
}

interface NormalizedTransaction {
  id: string;
  direction: 0 | 1;
  amountMinor: number;
  date: string;
  isRefund: boolean;
  category: string;
}

export interface MoneyCatsSourceMetadata {
  sizeBytes: number;
  modifiedAt: string;
  sha256: string;
}

const REQUIRED_COLUMNS = [
  'bid',
  'costcome',
  'price',
  'ymdDate',
  'ymdtime',
  'nocost',
  'refund',
  'title',
  'sourcecurrency',
];

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseYmd(value: string): Date {
  if (!YMD_PATTERN.test(value)) throw new Error('FINANCE_INVALID_DATE');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (formatYmd(date) !== value) throw new Error('FINANCE_INVALID_DATE');
  return date;
}

function formatYmd(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(value: string, amount: number): string {
  const date = parseYmd(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return formatYmd(date);
}

function earlierDate(current: string | null, candidate: string): string {
  return current == null || candidate < current ? candidate : current;
}

function laterDate(current: string | null, candidate: string): string {
  return current == null || candidate > current ? candidate : current;
}

function startOfWeek(value: string): string {
  const date = parseYmd(value);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return addDays(value, -daysSinceMonday);
}

function startOfMonth(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function startOfYear(value: string): string {
  return `${value.slice(0, 4)}-01-01`;
}

function parseMoneyMinor(value: string | null): number | null {
  if (value == null) return null;
  const normalized = value.trim().replaceAll(',', '');
  const match = normalized.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const whole = Number(match[1]);
  if (!Number.isSafeInteger(whole)) return null;
  const decimal = match[2] ?? '';
  const firstTwo = (decimal + '00').slice(0, 2);
  let minor = whole * 100 + Number(firstTwo);
  if (decimal.length > 2 && Number(decimal[2]) >= 5) minor += 1;
  return Number.isSafeInteger(minor) ? minor : null;
}

function summarize(
  rows: NormalizedTransaction[],
  from: string,
  to: string,
): FinancePeriodSummary {
  const selected = rows.filter((row) => row.date >= from && row.date <= to);
  let incomeMinor = 0;
  let expenseMinor = 0;
  let refundIncomeMinor = 0;
  let incomeCount = 0;
  let expenseCount = 0;

  for (const row of selected) {
    if (row.direction === 1) {
      incomeMinor += row.amountMinor;
      incomeCount += 1;
      if (row.isRefund) refundIncomeMinor += row.amountMinor;
    } else {
      expenseMinor += row.amountMinor;
      expenseCount += 1;
    }
  }

  return {
    from,
    to,
    incomeMinor,
    expenseMinor,
    netMinor: incomeMinor - expenseMinor,
    refundIncomeMinor,
    netSpendingMinor: expenseMinor - refundIncomeMinor,
    incomeCount,
    expenseCount,
    transactionCount: selected.length,
  };
}

function toLocalIso(unixSeconds: string | null): string | null {
  if (!unixSeconds || !/^\d+$/.test(unixSeconds)) return null;
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: FINANCE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date).replace(' ', 'T') + '+08:00';
}

export function localDateFor(date = new Date(), timezone = FINANCE_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function buildMoneyCatsBaseline(
  db: Database.Database,
  options: {
    asOf: string;
    generatedAt: string;
    source: MoneyCatsSourceMetadata;
  },
): MoneyCatsBaseline {
  parseYmd(options.asOf);

  const quickCheck = db.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') throw new Error('FINANCE_SOURCE_INTEGRITY_FAILED');

  const table = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bookkeep'
  `).get() as { name?: string } | undefined;
  if (!table) throw new Error('FINANCE_SCHEMA_UNSUPPORTED');

  const columns = new Set(
    (db.prepare('PRAGMA table_info(bookkeep)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (REQUIRED_COLUMNS.some((column) => !columns.has(column))) {
    throw new Error('FINANCE_SCHEMA_UNSUPPORTED');
  }

  const rawRows = db.prepare(`
    SELECT bid, costcome, price, ymdDate, ymdtime,
           COALESCE(nocost, 0) AS nocost,
           COALESCE(refund, 0) AS refund,
           title,
           sourcecurrency
    FROM bookkeep
  `).all() as MoneyCatsRow[];

  const idCounts = new Map<string, number>();
  const currencies = new Set<string>();
  const validRows: NormalizedTransaction[] = [];
  let blankIdRows = 0;
  let invalidDateRows = 0;
  let futureRows = 0;
  let invalidAmountRows = 0;
  let invalidDirectionRows = 0;
  let excludedNoCostRows = 0;
  let firstTransactionDate: string | null = null;
  let latestTransactionDate: string | null = null;
  let latestTransactionAt: string | null = null;
  let latestTransactionSeconds = -1;

  for (const row of rawRows) {
    const id = row.bid?.trim() ?? '';
    if (!id) blankIdRows += 1;
    else idCounts.set(id, (idCounts.get(id) ?? 0) + 1);

    const date = row.ymdDate ?? '';
    try {
      parseYmd(date);
    } catch {
      invalidDateRows += 1;
      continue;
    }

    firstTransactionDate = earlierDate(firstTransactionDate, date);
    latestTransactionDate = laterDate(latestTransactionDate, date);
    if (date > options.asOf) futureRows += 1;

    const timestamp = Number(row.ymdtime);
    if (Number.isFinite(timestamp) && timestamp > latestTransactionSeconds) {
      latestTransactionSeconds = timestamp;
      latestTransactionAt = toLocalIso(row.ymdtime);
    }

    const amountMinor = parseMoneyMinor(row.price);
    if (amountMinor == null || amountMinor <= 0) {
      invalidAmountRows += 1;
      continue;
    }
    if (row.costcome !== 0 && row.costcome !== 1) {
      invalidDirectionRows += 1;
      continue;
    }
    const currency = row.sourcecurrency?.trim();
    if (currency) currencies.add(currency);
    if (row.nocost === 1) {
      excludedNoCostRows += 1;
      continue;
    }
    if (!id) continue;

    validRows.push({
      id,
      direction: row.costcome,
      amountMinor,
      date,
      isRefund: row.refund === 1,
      category: row.title?.trim() || '未分类',
    });
  }

  const duplicateIdRows = [...idCounts.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  const throughRows = validRows.filter((row) => row.date <= options.asOf);
  const weekFrom = startOfWeek(options.asOf);
  const monthFrom = startOfMonth(options.asOf);
  const yearFrom = startOfYear(options.asOf);
  const periods = {
    week: summarize(throughRows, weekFrom, options.asOf),
    month: summarize(throughRows, monthFrom, options.asOf),
    year: summarize(throughRows, yearFrom, options.asOf),
  } satisfies Record<FinancePeriodKey, FinancePeriodSummary>;

  const dailyMap = new Map<string, { incomeMinor: number; expenseMinor: number }>();
  for (const row of throughRows) {
    if (row.date < monthFrom) continue;
    const current = dailyMap.get(row.date) ?? { incomeMinor: 0, expenseMinor: 0 };
    if (row.direction === 1) current.incomeMinor += row.amountMinor;
    else current.expenseMinor += row.amountMinor;
    dailyMap.set(row.date, current);
  }
  const currentMonthDaily: FinanceDailyPoint[] = [];
  for (let date = monthFrom; date <= options.asOf; date = addDays(date, 1)) {
    const value = dailyMap.get(date) ?? { incomeMinor: 0, expenseMinor: 0 };
    currentMonthDaily.push({
      date,
      incomeMinor: value.incomeMinor,
      expenseMinor: value.expenseMinor,
      netMinor: value.incomeMinor - value.expenseMinor,
    });
  }

  const categoryMap = new Map<string, { expenseMinor: number; transactionCount: number }>();
  for (const row of throughRows) {
    if (row.date < monthFrom || row.direction !== 0) continue;
    const current = categoryMap.get(row.category) ?? { expenseMinor: 0, transactionCount: 0 };
    current.expenseMinor += row.amountMinor;
    current.transactionCount += 1;
    categoryMap.set(row.category, current);
  }
  const currentMonthExpenseTop = [...categoryMap.entries()]
    .map(([category, value]) => ({ category, ...value }))
    .sort((left, right) => right.expenseMinor - left.expenseMinor)
    .slice(0, 8);

  return {
    schemaVersion: FINANCE_SCHEMA_VERSION,
    generatedAt: options.generatedAt,
    asOf: options.asOf,
    timezone: FINANCE_TIMEZONE,
    currency: 'CNY',
    source: {
      label: 'MoneyCats 本地备份',
      fileName: 'user_database.db',
      sizeBytes: options.source.sizeBytes,
      modifiedAt: options.source.modifiedAt,
      sha256: options.source.sha256,
      firstTransactionDate,
      latestTransactionDate,
      latestTransactionAt,
      totalRows: rawRows.length,
      includedRows: validRows.length,
    },
    metricDefinition: {
      factTable: 'bookkeep',
      weekStartsOn: 'monday',
      incomeRule: 'costcome=1',
      expenseRule: 'costcome=0',
      exclusionRule: 'COALESCE(nocost,0)=1',
      transferRule: 'transfer table excluded',
      refundRule: 'gross cashflow retained; refund income also reported separately',
    },
    periods,
    currentMonthDaily,
    currentMonthExpenseTop,
    quality: {
      quickCheck: 'ok',
      duplicateIdRows,
      blankIdRows,
      invalidDateRows,
      futureRows,
      invalidAmountRows,
      invalidDirectionRows,
      excludedNoCostRows,
      currencies: [...currencies].sort(),
    },
  };
}
