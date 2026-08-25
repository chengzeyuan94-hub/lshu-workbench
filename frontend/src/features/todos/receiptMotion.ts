export const RECEIPT_PRINT_DURATION_MS = 8000;

export const RECEIPT_FEED_JITTER = {
  horizontalPx: 1,
  verticalPx: 0.5,
  periodMs: 260,
} as const;

/**
 * The receipt is a fully composed sheet before it moves. Ink is revealed only
 * by the fixed printer-slot mask as each strip of paper exits the machine.
 * There are intentionally no per-row or per-character delays: once a strip is
 * below the slot it must already be completely printed.
 */
export const RECEIPT_PRINT_MODEL = {
  durationMs: RECEIPT_PRINT_DURATION_MS,
  contentMode: 'precomposed',
  revealMode: 'printer-slot-mask',
  feedMotion: 'subtle-mechanical-jitter',
} as const;
