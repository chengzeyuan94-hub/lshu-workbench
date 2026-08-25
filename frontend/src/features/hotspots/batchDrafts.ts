export const MAX_BATCH_DRAFTS = 4;
export const MAX_BATCH_DRAFT_CONCURRENCY = 2;

export type BatchDraftStatus = 'queued' | 'running' | 'success' | 'error';

export interface BatchDraftTopic {
  articleId: string;
  title: string;
}

export interface BatchDraftGeneration {
  draft: string;
}

export type BatchDraftItem<T extends BatchDraftTopic = BatchDraftTopic> = T & {
  status: BatchDraftStatus;
  draft?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type BatchDraftGenerator = (articleId: string) => Promise<BatchDraftGeneration>;
export type BatchDraftUpdateHandler<T extends BatchDraftTopic = BatchDraftTopic> = (items: BatchDraftItem<T>[]) => void;

export interface HotspotBatchInput<T extends BatchDraftTopic = BatchDraftTopic> {
  topics: readonly T[];
  generate: BatchDraftGenerator;
  onUpdate?: BatchDraftUpdateHandler<T>;
}

export class BatchDraftValidationError extends Error {
  readonly code: 'BATCH_SIZE_INVALID' | 'ARTICLE_ID_REQUIRED' | 'DUPLICATE_ARTICLE_ID';

  constructor(
    code: BatchDraftValidationError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'BatchDraftValidationError';
    this.code = code;
  }
}

function normalizedTopics<T extends BatchDraftTopic>(topics: readonly T[]): T[] {
  if (topics.length < 1 || topics.length > MAX_BATCH_DRAFTS) {
    throw new BatchDraftValidationError(
      'BATCH_SIZE_INVALID',
      `请选择 1–${MAX_BATCH_DRAFTS} 篇选题`,
    );
  }

  const normalized = topics.map((topic) => ({
    ...topic,
    articleId: String(topic.articleId ?? '').trim(),
    title: String(topic.title ?? '').trim(),
  })) as T[];
  if (normalized.some((topic) => !topic.articleId)) {
    throw new BatchDraftValidationError('ARTICLE_ID_REQUIRED', '选题缺少文章 ID');
  }

  const ids = normalized.map((topic) => topic.articleId);
  if (new Set(ids).size !== ids.length) {
    throw new BatchDraftValidationError('DUPLICATE_ARTICLE_ID', '同一篇选题不能重复生成');
  }
  return normalized;
}

function publicError(error: unknown): Pick<BatchDraftItem, 'errorCode' | 'errorMessage'> {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      errorCode: typeof code === 'string' && code ? code : undefined,
      errorMessage: error.message || '生成失败，请重试',
    };
  }
  return { errorMessage: '生成失败，请重试' };
}

/**
 * 最多两路并发生成朋友圈草稿。
 *
 * - 输入和输出始终保持同一顺序；
 * - 每篇独立进入 queued/running/success/error；
 * - 单篇失败只落在自己的结果中，不会终止其余任务；
 * - onUpdate 每次收到新的数组快照，调用方可以安全地直接 setState。
 */
export async function runHotspotDraftBatch<T extends BatchDraftTopic>(
  input: HotspotBatchInput<T>,
): Promise<BatchDraftItem<T>[]> {
  const { topics, generate, onUpdate } = input;
  const safeTopics = normalizedTopics(topics);
  const items: BatchDraftItem<T>[] = safeTopics.map((topic) => ({
    ...topic,
    status: 'queued',
  }));
  const emit = () => onUpdate?.(items.map((item) => ({ ...item })));
  emit();

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      item.status = 'running';
      delete item.draft;
      delete item.errorCode;
      delete item.errorMessage;
      emit();

      try {
        const generated = await generate(item.articleId);
        const draft = typeof generated?.draft === 'string' ? generated.draft.trim() : '';
        if (!draft) throw new Error('模型没有返回可展示的朋友圈正文，请重试');
        item.status = 'success';
        item.draft = draft;
      } catch (error) {
        item.status = 'error';
        Object.assign(item, publicError(error));
      }
      emit();
    }
  };

  const workerCount = Math.min(MAX_BATCH_DRAFT_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return items.map((item) => ({ ...item }));
}

/** 位置参数兼容入口；页面新代码优先使用 runHotspotDraftBatch。 */
export function generateBatchDrafts<T extends BatchDraftTopic>(
  topics: readonly T[],
  generate: BatchDraftGenerator,
  onUpdate?: BatchDraftUpdateHandler<T>,
): Promise<BatchDraftItem<T>[]> {
  return runHotspotDraftBatch({ topics, generate, onUpdate });
}
