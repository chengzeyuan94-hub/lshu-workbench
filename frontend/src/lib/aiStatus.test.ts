import { describe, expect, it } from 'vitest';
import { aiErrorLabel, formatAiRunSummary } from './aiStatus';

describe('AI 运行摘要', () => {
  it('不再把整轮统称为模型返回格式不符合要求', () => {
    expect(aiErrorLabel('AI_SCHEMA_INVALID')).toBeNull();
    expect(formatAiRunSummary({
      actionable: 0,
      review: 0,
      rejected: 159,
      schemaFailedBatches: 2,
      deferred: 522,
    })).toBe('成功分析 159 · 非待办 159 · 格式失败 2 批 · 延后 522');
  });
});
