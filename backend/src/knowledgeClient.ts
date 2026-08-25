// ============================================================
// 本地知识库服务客户端（V1.4 知识大脑接入）
// 外部服务：L叔线下课知识库项目（自定义 Python HTTP 服务，仅标准库）
//   默认地址 127.0.0.1:8765，由 python3 app.py 启动，零第三方依赖
// 安全原则（P0）：
//   - 白名单代理：只转发本文件声明的固定路径，绝不实现任意 URL 转发
//   - 不解析/不缓存上游的 source_path（内部路径）与 API Key 等敏感字段
//   - 上游离线时返回 503 code=KNOWLEDGE_SERVICE_OFFLINE，不抛原始堆栈
//   - 文档/状态缓存 60s，避免每次请求都让上游重载 267MB JSON
// ============================================================

/** 上游超时（ms）：chat/upload/hotspots 涉及向量检索 + Rerank + LLM，需较长超时 */
const TIMEOUT = {
  status: 15_000,
  documents: 30_000,
  chat: 180_000,
  upload: 180_000,
  delete: 30_000,
  hotspots: 180_000,
} as const;

/** 状态与文档缓存 TTL（ms）：上游每次读 267MB JSON，故默认缓存 60s */
const CACHE_TTL = 60_000;

export class KnowledgeServiceError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 503) {
    super(message);
    this.name = 'KnowledgeServiceError';
    this.code = code;
    this.status = status;
  }
}

/** 简化的上游返回类型（只声明我们用得到的字段） */
export interface KnowledgeStatus {
  documents: number;
  chunks: number;
  configured: boolean;
  llm_model: string;
  embedding_model: string;
  reranker_model: string;
  retrieval_context_chars: number;
}

export interface KnowledgeDocument {
  id: string;
  name: string;
  uploaded_at: string;
  characters: number;
  chunks: number;
}

export interface KnowledgeChatSource {
  document_name: string;
  heading: string;
  score: number;
  excerpt: string;
}

export interface KnowledgeChatResult {
  answer: string;
  sources: KnowledgeChatSource[];
  retrieved_characters: number;
}

export interface KnowledgeHotspotArticle {
  article_id: string;
  title: string;
  url: string;
  published_at_ms: number | null;
  author: string;
  summary: string;
  content_length: number;
  fact: string;
  angle: string;
  audience: string;
  format: string;
  action: string;
  evidence_gap: string;
  risk: string;
  scores: Record<string, number>;
  risk_deduction: number;
  score: number;
  decision: string;
}

export interface KnowledgeHotspotList {
  fetched_at: string | null;
  articles: KnowledgeHotspotArticle[];
}

export interface KnowledgeHotspotStatus {
  fetched_at: string | null;
  articles: number;
  top_five: KnowledgeHotspotArticle[];
}

export interface KnowledgeGenerateResult {
  draft: string;
}

/** 生成成功后仅供本机持久化使用的安全来源快照。 */
export interface KnowledgeHotspotGeneratedSource {
  article_id: string;
  title: string;
  url: string;
  author: string;
  published_at_ms: number | null;
}

export interface KnowledgeGenerateWithSourceResult extends KnowledgeGenerateResult {
  source: KnowledgeHotspotGeneratedSource;
}

export interface KnowledgeUploadResult {
  document: KnowledgeDocument;
  message: string;
}

function baseUrl(): string {
  return (process.env.KNOWLEDGE_BASE_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
}

/** 是否配置了外部知识库服务（用于设置页判断） */
export function isKnowledgeConfigured(): boolean {
  return !!process.env.KNOWLEDGE_BASE_URL;
}

// ===== 缓存 =====
interface CacheEntry {
  value: unknown;
  expiresAt: number;
  createdAt: number;
}
const cache = new Map<string, CacheEntry>();
function getCached<T>(key: string): T | null {
  const entry = getCachedEntry<T>(key);
  return entry ? entry.value : null;
}
function getCachedEntry<T>(key: string): { value: T; createdAt: number } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return { value: entry.value as T, createdAt: entry.createdAt };
}
function setCached(key: string, value: unknown): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL, createdAt: Date.now() });
}
/** 上传/删除文档后调用，使 status/documents 缓存失效 */
export function invalidateKnowledgeCache(): void {
  cache.delete('status');
  cache.delete('documents');
}

// ===== 底层请求（白名单 + 超时 + 错误归一化）=====
async function rawRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'DELETE';
    jsonBody?: unknown;
    form?: FormData;
    timeout: number;
  }
): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout);
  try {
    const init: RequestInit = {
      method: options.method || 'GET',
      signal: controller.signal,
    };
    if (options.jsonBody !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(options.jsonBody);
    } else if (options.form !== undefined) {
      init.body = options.form; // 由浏览器/Node 自动设置 multipart boundary
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // 上游返回非 JSON（如代理错误页），归一化为离线错误
      throw new KnowledgeServiceError(
        'KNOWLEDGE_SERVICE_OFFLINE',
        '知识库服务返回了非预期的响应，可能已离线。',
        503
      );
    }
    // 上游 app.py 用 send_error_json 返回 {"error": ...}，且可能带非 2xx 状态码
    if (!res.ok || typeof json.error === 'string') {
      const status = res.status >= 400 ? res.status : 400;
      const msg = typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
      // 数据未找到单独区分，其余一律视为服务异常
      throw new KnowledgeServiceError('KNOWLEDGE_ERROR', msg, status);
    }
    return json as T;
  } catch (e) {
    if (e instanceof KnowledgeServiceError) throw e;
    // 超时或连接失败 → 统一归一化为"服务离线"
    const isAbort = e instanceof Error && e.name === 'AbortError';
    const msg = isAbort
      ? `知识库服务响应超时（超过 ${Math.round(options.timeout / 1000)}s），可能正在处理大文件或已无响应。`
      : `无法连接知识库服务（${baseUrl()}）：请确认已通过 start.sh 或手动启动。`;
    throw new KnowledgeServiceError('KNOWLEDGE_SERVICE_OFFLINE', msg, 503);
  } finally {
    clearTimeout(timer);
  }
}

// ===== 白名单接口 =====

/** GET /api/status（限时 15s，缓存 60s） */
export async function getKnowledgeStatus(): Promise<KnowledgeStatus & { cached: boolean; checkedAt: string }> {
  const cached = getCachedEntry<KnowledgeStatus>('status');
  if (cached) {
    return { ...cached.value, cached: true, checkedAt: new Date(cached.createdAt).toISOString() };
  }
  const data = await rawRequest<KnowledgeStatus>('/api/status', { method: 'GET', timeout: TIMEOUT.status });
  setCached('status', data);
  return { ...data, cached: false, checkedAt: new Date().toISOString() };
}

/** GET /api/documents（限时 30s，缓存 60s；裁剪 source_path 等内部字段） */
export async function getKnowledgeDocuments(): Promise<KnowledgeDocument[]> {
  const cached = getCached<KnowledgeDocument[]>('documents');
  if (cached) return cached;
  const data = await rawRequest<{ documents: Array<Record<string, unknown>> }>('/api/documents', {
    method: 'GET',
    timeout: TIMEOUT.documents,
  });
  // P0：只暴露公开字段，剔除 source_path 等内部路径信息
  const safe = (data.documents || []).map((doc) => ({
    id: String(doc.id ?? ''),
    name: String(doc.name ?? ''),
    uploaded_at: String(doc.uploaded_at ?? ''),
    characters: Number(doc.characters ?? 0),
    chunks: Number(doc.chunks ?? 0),
  }));
  setCached('documents', safe);
  return safe;
}

/** POST /api/chat（限时 180s；history 最多 6 轮 12 条，单条最长 4000 字） */
export async function chatKnowledge(question: string, history: Array<{ role: string; content: string }>): Promise<KnowledgeChatResult> {
  if (String(question).length > 8000) {
    throw new KnowledgeServiceError('QUESTION_TOO_LONG', '问题最多 8000 字，请精简后再提问', 400);
  }
  // 历史上下文：最近 6 轮，即最多 12 条 user/assistant 消息；单条内容限制 4000 字
  const safeHistory = (Array.isArray(history) ? history : []).slice(-12).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message.content ?? '').slice(0, 4000),
  }));
  return rawRequest<KnowledgeChatResult>('/api/chat', {
    method: 'POST',
    jsonBody: { question: String(question), history: safeHistory },
    timeout: TIMEOUT.chat,
  });
}

/** POST /api/upload（multipart，限时 180s；仅 .md ≤10MB） */
export async function uploadKnowledge(file: Buffer | Blob | File, filename: string): Promise<KnowledgeUploadResult> {
  const form = new FormData();
  if (Buffer.isBuffer(file)) {
    // Node 后端用 Blob 包装 Buffer，FormData 才能正确构建 multipart
    const blob = new Blob([new Uint8Array(file)], { type: 'text/markdown' });
    form.append('file', blob, filename);
  } else {
    form.append('file', file, filename);
  }
  const result = await rawRequest<KnowledgeUploadResult>('/api/upload', {
    method: 'POST',
    form,
    timeout: TIMEOUT.upload,
  });
  invalidateKnowledgeCache();
  return result;
}

/** DELETE /api/documents/:id（限时 30s） */
export async function deleteKnowledgeDocument(id: string): Promise<{ message: string }> {
  const result = await rawRequest<{ message: string }>(`/api/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    timeout: TIMEOUT.delete,
  });
  invalidateKnowledgeCache();
  return result;
}

/** GET /api/hotspots/status（限时 180s） */
export async function getKnowledgeHotspotStatus(): Promise<KnowledgeHotspotStatus> {
  return rawRequest<KnowledgeHotspotStatus>('/api/hotspots/status', { method: 'GET', timeout: TIMEOUT.hotspots });
}

/** GET /api/hotspots/articles（限时 180s） */
export async function getKnowledgeHotspotArticles(): Promise<KnowledgeHotspotList> {
  return rawRequest<KnowledgeHotspotList>('/api/hotspots/articles', { method: 'GET', timeout: TIMEOUT.hotspots });
}

/** POST /api/hotspots/refresh（限时 180s；抓取并评分 20 篇） */
export async function refreshKnowledgeHotspots(): Promise<KnowledgeHotspotList & { message: string }> {
  return rawRequest<KnowledgeHotspotList & { message: string }>('/api/hotspots/refresh', {
    method: 'POST',
    timeout: TIMEOUT.hotspots,
  });
}

const PRIVATE_REASONING_BLOCK = /<\s*(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const PRIVATE_REASONING_FENCE = /```\s*(?:analysis|reasoning|think)\b[\s\S]*?```/gi;
const PRIVATE_REASONING_TAG = /<\s*\/?\s*(?:think|analysis|reasoning)\b[^>]*>/i;
const PRIVATE_REASONING_COPY = /(?:^|\n)\s*(?:好的[，,]\s*用户|先(?:看|想|分析)一下|我需要(?:先|按|来)|写作(?:要求|思路)|草稿(?:开始|想法)|(?:【|\[)?(?:思考过程|推理过程|分析过程|链路分析)(?:】|\])?\s*[:：]?)/i;
const HOTSPOT_DRAFT_MARKER = /【朋友圈(?:正文)?草稿】|(?:^|\n)\s*朋友圈(?:正文)?草稿\s*[:：]/gim;

/**
 * 热点生成结果的公开边界：只允许最终朋友圈正文通过。
 * 上游历史版本可能同时返回写作角度，甚至在 content 为空时回退 reasoning_content；
 * 因此这里必须确定性截取正文并拒绝任何残留的私有推理格式。
 */
export function extractHotspotDraftBody(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new KnowledgeServiceError('KNOWLEDGE_INVALID_RESPONSE', '模型没有返回可展示的朋友圈正文，请重试。', 502);
  }

  let text = raw
    .replace(/\r\n?/g, '\n')
    .replace(PRIVATE_REASONING_BLOCK, '')
    .replace(PRIVATE_REASONING_FENCE, '')
    .trim();

  // 未闭合的 think / analysis 标签不能静默穿过边界。
  if (PRIVATE_REASONING_TAG.test(text)) {
    throw new KnowledgeServiceError('KNOWLEDGE_INVALID_RESPONSE', '模型返回格式不完整，请重新生成朋友圈正文。', 502);
  }

  const markers = [...text.matchAll(HOTSPOT_DRAFT_MARKER)];
  if (markers.length > 0) {
    const last = markers[markers.length - 1];
    text = text.slice((last.index ?? 0) + last[0].length);
  } else if (/【写作角度】|(?:^|\n)\s*写作角度\s*[:：]/i.test(text)) {
    throw new KnowledgeServiceError('KNOWLEDGE_INVALID_RESPONSE', '模型没有按要求返回朋友圈正文，请重新生成。', 502);
  }

  text = text
    .replace(/^\s*```(?:markdown|text)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/^\s*[:：\-—]+\s*/, '')
    .trim();

  if (!text || PRIVATE_REASONING_TAG.test(text) || PRIVATE_REASONING_COPY.test(text)) {
    throw new KnowledgeServiceError('KNOWLEDGE_INVALID_RESPONSE', '模型没有返回可展示的朋友圈正文，请重试。', 502);
  }
  return text;
}

async function requestKnowledgeHotspotGeneration(articleId: string): Promise<Record<string, unknown>> {
  return rawRequest<Record<string, unknown>>('/api/hotspots/generate', {
    method: 'POST',
    jsonBody: { article_id: String(articleId).trim() },
    timeout: TIMEOUT.hotspots,
  });
}

function generatedSource(raw: unknown, requestedArticleId: string): KnowledgeHotspotGeneratedSource {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new KnowledgeServiceError('KNOWLEDGE_INVALID_RESPONSE', '热点文章来源信息缺失，请刷新后重试。', 502);
  }
  const article = raw as Record<string, unknown>;
  const articleId = typeof article.article_id === 'string' ? article.article_id.trim() : '';
  const title = typeof article.title === 'string' ? article.title.trim() : '';
  if (!articleId || articleId !== requestedArticleId || !title) {
    throw new KnowledgeServiceError('KNOWLEDGE_INVALID_RESPONSE', '热点文章来源信息不一致，请刷新后重试。', 502);
  }
  const publishedAt = article.published_at_ms;
  return {
    article_id: articleId,
    title,
    url: typeof article.url === 'string' ? article.url.trim() : '',
    author: typeof article.author === 'string' ? article.author.trim() : '',
    published_at_ms: typeof publishedAt === 'number' && Number.isSafeInteger(publishedAt) && publishedAt >= 0
      ? publishedAt
      : null,
  };
}

/** POST /api/hotspots/generate（body {article_id}，限时 180s） */
export async function generateKnowledgeHotspot(articleId: string): Promise<KnowledgeGenerateResult> {
  const upstream = await requestKnowledgeHotspotGeneration(articleId);
  return { draft: extractHotspotDraftBody(upstream.draft) };
}

/**
 * 路由持久化专用版本：一次上游调用同时得到正文与严格裁剪的文章元数据。
 * 公开 HTTP 响应仍由路由收口成唯一字段 draft。
 */
export async function generateKnowledgeHotspotWithSource(
  articleIdInput: string,
): Promise<KnowledgeGenerateWithSourceResult> {
  const articleId = String(articleIdInput).trim();
  const upstream = await requestKnowledgeHotspotGeneration(articleId);
  return {
    draft: extractHotspotDraftBody(upstream.draft),
    source: generatedSource(upstream.article, articleId),
  };
}
