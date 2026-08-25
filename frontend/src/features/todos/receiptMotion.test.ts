import { describe, expect, it } from 'vitest';
import { RECEIPT_FEED_JITTER, RECEIPT_PRINT_DURATION_MS, RECEIPT_PRINT_MODEL } from './receiptMotion';

describe('receipt print motion', () => {
  it('uses an eight-second paper journey', () => {
    expect(RECEIPT_PRINT_DURATION_MS).toBe(8000);
    expect(RECEIPT_PRINT_MODEL.durationMs).toBe(8000);
  });

  it('keeps the full receipt composed and reveals ink only at the printer slot', () => {
    expect(RECEIPT_PRINT_MODEL.contentMode).toBe('precomposed');
    expect(RECEIPT_PRINT_MODEL.revealMode).toBe('printer-slot-mask');
  });

  it('adds only a restrained mechanical jitter while the paper is feeding', () => {
    expect(RECEIPT_PRINT_MODEL.feedMotion).toBe('subtle-mechanical-jitter');
    expect(RECEIPT_FEED_JITTER.horizontalPx).toBeLessThanOrEqual(1);
    expect(RECEIPT_FEED_JITTER.verticalPx).toBeLessThanOrEqual(0.5);
    expect(RECEIPT_FEED_JITTER.periodMs).toBe(260);
  });
});
