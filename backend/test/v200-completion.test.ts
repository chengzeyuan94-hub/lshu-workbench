import { describe, expect, it } from 'vitest';
import { scoreCompletion, shouldAutoComplete } from '../src/services/completionReconciler';

describe('自动完成高/中/低置信度与撤销抑制', () => {
  it('Things completed 是强证据，可自动完成（需开关）', () => {
    const d = scoreCompletion([{ type: 'things_completed', strength: 'strong', summary: 'Things 已完成', fingerprint: 'fp-1' }]);
    expect(d.decision).toBe('completed');
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
    expect(shouldAutoComplete(d, false)).toBe(false);
    expect(shouldAutoComplete(d, true)).toBe(true);
  });

  it('中置信度只标疑似完成', () => {
    const d = scoreCompletion([
      { type: 'file_changed', strength: 'weak', summary: '文件改了' },
      { type: 'chat_done_ambiguous', strength: 'weak', summary: '聊天说做好了' },
    ]);
    expect(d.decision).toBe('suspected_done');
    expect(d.confidence).toBeGreaterThanOrEqual(0.65);
    expect(d.confidence).toBeLessThan(0.9);
    expect(shouldAutoComplete(d, true)).toBe(false);
  });

  it('日历结束不能单独完成', () => {
    const d = scoreCompletion([{ type: 'calendar_block_ended', strength: 'weak', summary: '时间块结束' }]);
    expect(d.decision).toBe('progress_only');
    expect(d.confidence).toBeLessThan(0.65);
  });

  it('撤销后同一 fingerprint 不得立刻再次自动完成', () => {
    const d = scoreCompletion([{ type: 'things_completed', strength: 'strong', summary: 'Things 已完成', fingerprint: 'fp-1' }]);
    expect(shouldAutoComplete(d, true, ['fp-1'])).toBe(false);
    expect(shouldAutoComplete(d, true, [])).toBe(true);
  });
});
