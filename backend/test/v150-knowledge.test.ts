import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getKnowledgeDocuments,
  getKnowledgeStatus,
  chatKnowledge,
  extractHotspotDraftBody,
  generateKnowledgeHotspot,
  generateKnowledgeHotspotWithSource,
  invalidateKnowledgeCache,
  KnowledgeServiceError,
} from '../src/knowledgeClient';

// V1.5 知识库客户端白名单与边界测试：
// - 只访问固定路由，不成为任意 URL 代理
// - source_path / 密钥字段不出现在 documents/status 响应
// - 问题长度 8000、历史 12 条、缓存与失效
// 所有网络调用均 mock，不访问真实知识库服务。

function jsonResponse(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}

describe('V1.5 知识库客户端白名单与字段裁剪', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    invalidateKnowledgeCache();
    vi.stubEnv('KNOWLEDGE_BASE_URL', 'http://127.0.0.1:8765');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('getKnowledgeDocuments 只裁剪公开字段，不暴露 source_path/API Key', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      documents: [
        { id: 'doc-1', name: '公开.md', uploaded_at: '2026-08-23', characters: 100, chunks: 2, source_path: '/Users/example/私人路径', api_key: 'secret' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const docs = await getKnowledgeDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toEqual({ id: 'doc-1', name: '公开.md', uploaded_at: '2026-08-23', characters: 100, chunks: 2 });
    expect(JSON.stringify(docs)).not.toContain('source_path');
    expect(JSON.stringify(docs)).not.toContain('api_key');
    // 白名单：只能请求 /api/documents
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8765/api/documents');
  });

  it('getKnowledgeStatus 只请求固定 /api/status 并标记缓存状态', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ documents: 271, chunks: 3121, configured: false, llm_model: '', embedding_model: '', reranker_model: '', retrieval_context_chars: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await getKnowledgeStatus();
    expect(first.cached).toBe(false);
    expect(first.online ?? true).toBe(true);
    expect(first.configured).toBe(false);
    const second = await getKnowledgeStatus();
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8765/api/status');
  });

  it('上传/删除后缓存失效：下次 status 重新请求', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ documents: 1, chunks: 1, configured: true, llm_model: 'gpt', embedding_model: 'bge', reranker_model: 'bge-reranker', retrieval_context_chars: 10 }));
    vi.stubGlobal('fetch', fetchMock);
    await getKnowledgeStatus();
    invalidateKnowledgeCache();
    await getKnowledgeStatus();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('V1.5 知识库输入边界', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('问题超过 8000 字返回 400，不静默截断', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const longQuestion = '字'.repeat(8001);
    await expect(chatKnowledge(longQuestion, [])).rejects.toMatchObject({ code: 'QUESTION_TOO_LONG', status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('历史上下文只保留最近 12 条（6 轮）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ answer: 'ok', sources: [], retrieved_characters: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, content: `消息${i}` }));
    await chatKnowledge('问题', history);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { question: string; history: Array<{ role: string; content: string }> };
    expect(body.question).toBe('问题');
    expect(body.history).toHaveLength(12);
    expect(body.history[0].content).toBe('消息8');
    expect(body.history[11].content).toBe('消息19');
  });

  it('离线错误归一化为 503 KNOWLEDGE_SERVICE_OFFLINE', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(chatKnowledge('问题', [])).rejects.toMatchObject({ code: 'KNOWLEDGE_SERVICE_OFFLINE', status: 503 });
  });
});

describe('热点朋友圈草稿公开边界', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubEnv('KNOWLEDGE_BASE_URL', 'http://127.0.0.1:8765');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('只提取最后一个【朋友圈草稿】后的正文并移除思考块', () => {
    const raw = '<think>不能公开的内部分析</think>\n【写作角度】先讲机制\n【朋友圈草稿】\n这才是应该展示的正文。';
    expect(extractHotspotDraftBody(raw)).toBe('这才是应该展示的正文。');
  });

  it('纯正文可以通过，推理式回答与未闭合标签必须拒绝', () => {
    expect(extractHotspotDraftBody('这是一段已经由上游收口的朋友圈正文。')).toBe('这是一段已经由上游收口的朋友圈正文。');
    expect(() => extractHotspotDraftBody('好的，用户给了热点资料，我需要先分析一下。')).toThrowError(KnowledgeServiceError);
    expect(() => extractHotspotDraftBody('<think>没有闭合')).toThrowError(KnowledgeServiceError);
  });

  it('工作台生成接口只返回 draft，不透传文章、知识库引用或检索信息', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      article: { title: '不应公开的上游对象' },
      draft: '<analysis>秘密推理</analysis>\n【写作角度】角度\n【朋友圈草稿】正文只保留这一段。',
      rag_sources: [{ document_name: '私有知识库.md', heading: '章节', score: 0.9 }],
      retrieved_characters: 9000,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateKnowledgeHotspot('article-1');
    expect(result).toEqual({ draft: '正文只保留这一段。' });
    expect(Object.keys(result)).toEqual(['draft']);
    expect(JSON.stringify(result)).not.toContain('秘密推理');
    expect(JSON.stringify(result)).not.toContain('私有知识库');
  });

  it('持久化专用生成只保留安全文章来源快照，不保留正文、评分或知识库引用', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      article: {
        article_id: 'article-safe',
        title: 'AI 行业观察',
        url: 'https://example.com/article-safe',
        author: '36氪',
        published_at_ms: 1_777_000_000_000,
        content: '不应持久化的完整文章正文',
        scores: { fit: 99 },
        source_path: '/Users/example/private',
      },
      draft: '朋友圈最终正文。',
      rag_sources: [{ document_name: '私有知识库.md' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateKnowledgeHotspotWithSource('article-safe');
    expect(result).toEqual({
      draft: '朋友圈最终正文。',
      source: {
        article_id: 'article-safe',
        title: 'AI 行业观察',
        url: 'https://example.com/article-safe',
        author: '36氪',
        published_at_ms: 1_777_000_000_000,
      },
    });
    expect(JSON.stringify(result)).not.toContain('完整文章正文');
    expect(JSON.stringify(result)).not.toContain('scores');
    expect(JSON.stringify(result)).not.toContain('私有知识库');
    expect(JSON.stringify(result)).not.toContain('source_path');
  });

  it('持久化专用生成拒绝缺失或错配的 article_id，避免草稿挂错来源', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      article: { article_id: 'article-other', title: '另一篇文章' },
      draft: '正文。',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateKnowledgeHotspotWithSource('article-requested')).rejects.toMatchObject({
      code: 'KNOWLEDGE_INVALID_RESPONSE',
      status: 502,
    });
  });

  it('上游只有写作角度或空草稿时返回 502，而不是把原文交给页面', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ draft: '【写作角度】只有分析，没有最终正文。' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateKnowledgeHotspot('article-2')).rejects.toMatchObject({
      code: 'KNOWLEDGE_INVALID_RESPONSE',
      status: 502,
    });
  });
});
