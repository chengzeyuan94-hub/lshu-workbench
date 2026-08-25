import { describe, expect, it, vi } from 'vitest';
import {
  BatchDraftValidationError,
  generateBatchDrafts,
  runHotspotDraftBatch,
  type BatchDraftItem,
  type BatchDraftTopic,
} from './batchDrafts';

function topic(articleId: string): BatchDraftTopic {
  return { articleId, title: `选题 ${articleId}` };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('generateBatchDrafts', () => {
  it('提供对象参数的 runHotspotDraftBatch 页面入口', async () => {
    const result = await runHotspotDraftBatch({
      topics: [{ articleId: 'a', title: 'A', score: 92 }],
      generate: async () => ({ draft: '正文 A' }),
    });
    expect(result[0]).toMatchObject({ articleId: 'a', score: 92, status: 'success', draft: '正文 A' });
  });

  it('只接受 1–4 篇选题', async () => {
    const generate = vi.fn(async () => ({ draft: '正文' }));

    await expect(generateBatchDrafts([], generate)).rejects.toMatchObject({
      code: 'BATCH_SIZE_INVALID',
    });
    await expect(
      generateBatchDrafts(['1', '2', '3', '4', '5'].map(topic), generate),
    ).rejects.toBeInstanceOf(BatchDraftValidationError);
    expect(generate).not.toHaveBeenCalled();

    await expect(generateBatchDrafts([topic('1')], generate)).resolves.toMatchObject([
      { articleId: '1', status: 'success', draft: '正文' },
    ]);
  });

  it('拒绝空 ID 与重复文章 ID', async () => {
    const generate = vi.fn(async () => ({ draft: '正文' }));

    await expect(generateBatchDrafts([topic('  ')], generate)).rejects.toMatchObject({
      code: 'ARTICLE_ID_REQUIRED',
    });
    await expect(generateBatchDrafts([topic('same'), topic(' same ')], generate)).rejects.toMatchObject({
      code: 'DUPLICATE_ARTICLE_ID',
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('最大并发为 2，并在乱序完成时保持输入顺序', async () => {
    const gates = new Map(['a', 'b', 'c', 'd'].map((id) => [id, deferred<{ draft: string }>()]));
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const generate = vi.fn(async (articleId: string) => {
      calls.push(articleId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await gates.get(articleId)!.promise;
      } finally {
        active -= 1;
      }
    });

    const resultPromise = generateBatchDrafts(['a', 'b', 'c', 'd'].map(topic), generate);
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b']));
    expect(maxActive).toBe(2);

    gates.get('b')!.resolve({ draft: '正文 b' });
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b', 'c']));
    gates.get('c')!.resolve({ draft: '正文 c' });
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b', 'c', 'd']));
    gates.get('d')!.resolve({ draft: '正文 d' });
    gates.get('a')!.resolve({ draft: '正文 a' });

    const result = await resultPromise;
    expect(maxActive).toBe(2);
    expect(result.map((item) => item.articleId)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.map((item) => item.draft)).toEqual(['正文 a', '正文 b', '正文 c', '正文 d']);
  });

  it('逐项发出 queued/running/success 状态快照', async () => {
    const snapshots: BatchDraftItem[][] = [];
    const result = await generateBatchDrafts(
      [topic('a'), topic('b')],
      async (articleId) => ({ draft: `正文 ${articleId}` }),
      (items) => snapshots.push(items),
    );

    expect(snapshots[0].map((item) => item.status)).toEqual(['queued', 'queued']);
    for (const articleId of ['a', 'b']) {
      expect(snapshots.some((items) => {
        const item = items.find((candidate) => candidate.articleId === articleId);
        return item?.status === 'running';
      })).toBe(true);
    }
    expect(result.map((item) => item.status)).toEqual(['success', 'success']);
    expect(snapshots.at(-1)?.map((item) => item.status)).toEqual(['success', 'success']);
  });

  it('单项失败不会终止其他选题，并保留错误 code', async () => {
    const calls: string[] = [];
    const generate = vi.fn(async (articleId: string) => {
      calls.push(articleId);
      if (articleId === 'b') {
        const error = new Error('上游暂时不可用') as Error & { code?: string };
        error.code = 'KNOWLEDGE_SERVICE_OFFLINE';
        throw error;
      }
      return { draft: `正文 ${articleId}` };
    });

    const result = await generateBatchDrafts(['a', 'b', 'c', 'd'].map(topic), generate);

    expect(calls).toHaveLength(4);
    expect(result.map((item) => item.status)).toEqual(['success', 'error', 'success', 'success']);
    expect(result[1]).toMatchObject({
      articleId: 'b',
      errorCode: 'KNOWLEDGE_SERVICE_OFFLINE',
      errorMessage: '上游暂时不可用',
    });
    expect(result[2].draft).toBe('正文 c');
  });

  it('空正文只使当前项失败', async () => {
    const result = await generateBatchDrafts(
      [topic('empty'), topic('ok')],
      async (articleId) => ({ draft: articleId === 'empty' ? '   ' : '有效正文' }),
    );

    expect(result[0]).toMatchObject({ status: 'error' });
    expect(result[0].errorMessage).toMatch(/没有返回/);
    expect(result[1]).toMatchObject({ status: 'success', draft: '有效正文' });
  });
});
