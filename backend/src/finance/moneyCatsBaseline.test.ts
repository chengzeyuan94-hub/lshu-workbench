import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMoneyCatsBaseline } from './moneyCatsBaseline';

describe('MoneyCats finance baseline', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('uses local calendar periods, cents, refunds, and excludes no-cost rows', () => {
    db = new Database(':memory:');
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
    `);
    const insert = db.prepare(`
      INSERT INTO bookkeep
        (bid, costcome, price, ymdDate, ymdtime, nocost, refund, title, sourcecurrency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '¥')
    `);
    insert.run('expense-week', 0, '12.34', '2026-08-24', '1787529600', 0, 0, '伙食');
    insert.run('income-month', 1, '100.00', '2026-08-03', '1785686400', 0, 0, '工资');
    insert.run('refund-year', 1, '5.67', '2026-01-02', '1767283200', 0, 1, '退款');
    insert.run('excluded', 0, '999.00', '2026-08-25', '1787616000', 1, 0, '不计入');
    insert.run('future', 0, '20.00', '2026-08-26', '1787702400', 0, 0, '伙食');

    const baseline = buildMoneyCatsBaseline(db, {
      asOf: '2026-08-25',
      generatedAt: '2026-08-25T02:00:00.000Z',
      source: { sizeBytes: 123, modifiedAt: '2026-08-25T01:00:00.000Z', sha256: 'abc' },
    });

    expect(baseline.periods.week).toMatchObject({
      from: '2026-08-24',
      to: '2026-08-25',
      incomeMinor: 0,
      expenseMinor: 1234,
      netMinor: -1234,
      transactionCount: 1,
    });
    expect(baseline.periods.month).toMatchObject({
      incomeMinor: 10_000,
      expenseMinor: 1234,
      netMinor: 8766,
    });
    expect(baseline.periods.year).toMatchObject({
      incomeMinor: 10_567,
      expenseMinor: 1234,
      refundIncomeMinor: 567,
      netSpendingMinor: 667,
    });
    expect(baseline.quality.excludedNoCostRows).toBe(1);
    expect(baseline.quality.futureRows).toBe(1);
    expect(baseline.currentMonthExpenseTop[0]).toMatchObject({
      category: '伙食',
      expenseMinor: 1234,
    });
  });
});

