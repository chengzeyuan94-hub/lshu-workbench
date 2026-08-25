import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedupeCandidates, inferCandidates } from '../src/services/todoInference';
import { fingerprintSource } from '../src/services/hash';
import type { StandardizedItem, TodoCandidate } from '../src/connectors/types';

let dbDir: string;
let productivity: typeof import('../src/db')['productivity'];

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'wb-v200-inf-'));
  process.env.WORKBENCH_DATA_DIR = dbDir;
  ({ productivity } = await import('../src/db'));
});

afterAll(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

function item(partial: Partial<StandardizedItem> & Pick<StandardizedItem, 'sourceType' | 'sourceExternalId' | 'title'>): StandardizedItem {
  return {
    status: 'open',
    sourceFingerprint: fingerprintSource(partial.sourceType, partial.sourceExternalId),
    payload: {},
    ...partial,
  };
}

describe('跨来源合并与稳定去重', () => {
  it('相同 source_type + external_id 只保留一条', () => {
    const a = item({ sourceType: 'things', sourceExternalId: 't1', title: '推进丝路' });
    const b = item({ sourceType: 'things', sourceExternalId: 't1', title: '推进丝路（重复）' });
    const out = inferCandidates([a, b]);
    expect(out.filter((c) => c.sourceExternalId === 't1')).toHaveLength(1);
  });

  it('相同 fingerprint 去重', () => {
    const fp = fingerprintSource('things', 't2');
    const cands: TodoCandidate[] = [
      { title: 'A', sourceType: 'things', sourceExternalId: 't2', sourceFingerprint: fp, reason: '1', evidenceSummaries: ['1'], suggestedPriority: 'high', estimatedMinutes: 45, confidence: 0.8 },
      { title: 'B', sourceType: 'things', sourceExternalId: 't2b', sourceFingerprint: fp, reason: '2', evidenceSummaries: ['2'], suggestedPriority: 'medium', estimatedMinutes: 45, confidence: 0.7 },
    ];
    const out = dedupeCandidates(cands);
    expect(out).toHaveLength(1);
    expect(out[0].evidenceSummaries).toContain('2');
  });

  it('同一项目两个无 due 的 Things 任务保持两条，不模糊合并', () => {
    const things = item({ sourceType: 'things', sourceExternalId: 'th-unique-a', title: '推进丝路', project: '项目A' });
    const first = productivity.upsertCandidate({
      title: things.title,
      sourceType: 'things',
      sourceExternalId: things.sourceExternalId,
      sourceFingerprint: things.sourceFingerprint,
      reason: 'Things 今天',
      evidenceSummaries: ['Things'],
      suggestedPriority: 'high',
      estimatedMinutes: 45,
      confidence: 0.86,
      project: '项目A',
      cluster: '项目A',
    });
    const desktopExt = `cluster:proj-a-${Date.now()}`;
    const second = productivity.upsertCandidate({
      title: '整理桌面文件',
      sourceType: 'desktop',
      sourceExternalId: desktopExt,
      sourceFingerprint: fingerprintSource('desktop', desktopExt),
      reason: '桌面文件更新',
      evidenceSummaries: ['desktop'],
      suggestedPriority: 'high',
      estimatedMinutes: 90,
      confidence: 0.58,
      project: '项目A',
      cluster: '项目A',
    });
    expect(second.todoId).not.toBe(first.todoId);
    expect(second.action).toBe('created');
  });
});
