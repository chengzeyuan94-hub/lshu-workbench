import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createKnowledgeHotspotDraftRepository,
  ensureKnowledgeHotspotDraftSchema,
  KnowledgeHotspotDraftError,
  normalizeKnowledgeHotspotDraftListQuery,
} from '../src/knowledgeHotspotDrafts';

describe('朋友圈草稿 SQLite 仓储', () => {
  let db: Database.Database;
  let clockIndex: number;

  beforeEach(() => {
    db = new Database(':memory:');
    clockIndex = 0;
  });

  afterEach(() => {
    db.close();
  });

  function repo() {
    return createKnowledgeHotspotDraftRepository(db, {
      now: () => `2026-08-25T10:00:0${clockIndex++}.000Z`,
    });
  }

  function input(articleId: string, draft: string, requestId?: string) {
    return {
      source: {
        articleId,
        title: `标题 ${articleId}`,
        url: `https://example.com/${articleId}`,
        author: '36氪',
        publishedAtMs: 1_777_000_000_000,
      },
      draft,
      generationMode: 'batch' as const,
      requestId,
    };
  }

  it('schema 初始化幂等，且不依赖全局 workbench 数据库', () => {
    expect(() => ensureKnowledgeHotspotDraftSchema(db)).not.toThrow();
    expect(() => ensureKnowledgeHotspotDraftSchema(db)).not.toThrow();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain('knowledge_hotspot_drafts');
  });

  it('同一文章可保存多个历史版本，按最新生成顺序返回', () => {
    const drafts = repo();
    const first = drafts.save(input('article-1', '第一版'));
    const second = drafts.save({ ...input('article-1', '第二版'), generationMode: 'retry' });

    expect(first.id).not.toBe(second.id);
    const list = drafts.list({ page: 1, pageSize: 20, keyword: '' });
    expect(list.items.map((item) => item.draft)).toEqual(['第二版', '第一版']);
    expect(list.items[0].generation_mode).toBe('retry');
    expect(list.total).toBe(2);
    expect(list.totalPages).toBe(1);
  });

  it('request_id 对同一文章幂等，对另一篇文章明确冲突', () => {
    const drafts = repo();
    const first = drafts.save(input('article-1', '原始正文', 'batch-42:article-1'));
    const repeated = drafts.save(input('article-1', '不应覆盖', 'batch-42:article-1'));

    expect(repeated).toEqual(first);
    expect(drafts.list().total).toBe(1);
    expect(() => drafts.save(input('article-2', '另一篇', 'batch-42:article-1')))
      .toThrowError(KnowledgeHotspotDraftError);
    expect(() => drafts.save(input('article-2', '另一篇', 'batch-42:article-1')))
      .toThrow(/另一篇文章/);
  });

  it('历史公开字段不含 request_id，并裁掉不安全 URL scheme', () => {
    const drafts = repo();
    const saved = drafts.save({
      ...input('article-1', '公开正文', 'single-1'),
      source: {
        ...input('article-1', '公开正文').source,
        url: 'file:///Users/example/private.txt',
      },
    });

    expect(saved.source_url).toBe('');
    expect(Object.keys(saved)).not.toContain('request_id');
    expect(JSON.stringify(drafts.list())).not.toContain('single-1');
  });

  it('分页稳定，keyword 可搜索标题、作者和正文', () => {
    const drafts = repo();
    drafts.save(input('a', '普通正文'));
    drafts.save({
      ...input('b', '包含洞察的正文'),
      source: { ...input('b', '').source, title: 'AI 产品新闻', author: '虎嗅' },
    });
    drafts.save({
      ...input('c', '第三条'),
      source: { ...input('c', '').source, title: '消费观察', author: '作者甲' },
    });

    expect(drafts.list({ page: 1, pageSize: 2, keyword: '' })).toMatchObject({
      total: 3,
      page: 1,
      pageSize: 2,
      totalPages: 2,
    });
    expect(drafts.list({ page: 2, pageSize: 2, keyword: '' }).items.map((item) => item.article_id))
      .toEqual(['a']);
    expect(drafts.list({ page: 1, pageSize: 20, keyword: 'AI 产品' }).items.map((item) => item.article_id))
      .toEqual(['b']);
    expect(drafts.list({ page: 1, pageSize: 20, keyword: '虎嗅' }).items.map((item) => item.article_id))
      .toEqual(['b']);
    expect(drafts.list({ page: 1, pageSize: 20, keyword: '洞察' }).items.map((item) => item.article_id))
      .toEqual(['b']);
  });

  it('查询边界拒绝非法页码、超过 100 的 pageSize 与数组 keyword', () => {
    expect(() => normalizeKnowledgeHotspotDraftListQuery({ page: '0' })).toThrow(/page/);
    expect(() => normalizeKnowledgeHotspotDraftListQuery({ pageSize: '101' })).toThrow(/100/);
    expect(() => normalizeKnowledgeHotspotDraftListQuery({ keyword: ['a', 'b'] })).toThrow(/keyword/);
    expect(normalizeKnowledgeHotspotDraftListQuery()).toEqual({ page: 1, pageSize: 20, keyword: '' });
  });
});
