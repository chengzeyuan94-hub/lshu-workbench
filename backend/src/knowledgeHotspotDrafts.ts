import type Database from 'better-sqlite3';

export const KNOWLEDGE_HOTSPOT_DRAFT_PAGE_SIZE = 20;
export const KNOWLEDGE_HOTSPOT_DRAFT_MAX_PAGE_SIZE = 100;

export type KnowledgeHotspotGenerationMode = 'single' | 'batch' | 'retry';

export interface KnowledgeHotspotDraftSourceSnapshot {
  articleId: string;
  title: string;
  url?: string | null;
  author?: string | null;
  publishedAtMs?: number | null;
}

export interface SaveKnowledgeHotspotDraftInput {
  source: KnowledgeHotspotDraftSourceSnapshot;
  draft: string;
  generationMode?: KnowledgeHotspotGenerationMode;
  requestId?: string | null;
}

/** Public history row. request_id deliberately never crosses this boundary. */
export interface KnowledgeHotspotDraftItem {
  id: number;
  article_id: string;
  source_title: string;
  source_url: string;
  source_author: string;
  source_published_at_ms: number | null;
  draft: string;
  generation_mode: KnowledgeHotspotGenerationMode;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeHotspotDraftListQuery {
  page: number;
  pageSize: number;
  keyword: string;
}

export interface KnowledgeHotspotDraftListResult {
  items: KnowledgeHotspotDraftItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export class KnowledgeHotspotDraftError extends Error {
  constructor(
    public readonly code: 'DRAFT_VALIDATION_FAILED' | 'DRAFT_REQUEST_CONFLICT',
    message: string,
    public readonly status: 400 | 409,
  ) {
    super(message);
    this.name = 'KnowledgeHotspotDraftError';
  }
}

interface KnowledgeHotspotDraftDbRow {
  id: number;
  article_id: string;
  source_title: string;
  source_url: string;
  source_author: string;
  source_published_at_ms: number | null;
  draft_text: string;
  generation_mode: string;
  request_id: string | null;
  created_at: string;
  updated_at: string;
}

const GENERATION_MODES = new Set<KnowledgeHotspotGenerationMode>(['single', 'batch', 'retry']);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function validation(message: string): never {
  throw new KnowledgeHotspotDraftError('DRAFT_VALIDATION_FAILED', message, 400);
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) validation(`${label}不能为空`);
  const text = value.trim();
  if (text.length > maxLength) validation(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function optionalText(value: unknown, label: string, maxLength: number): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') validation(`${label}格式不正确`);
  const text = value.trim();
  if (text.length > maxLength) validation(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function safeHttpUrl(value: unknown): string {
  const text = optionalText(value, '文章来源链接', 2048);
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function normalizeKnowledgeHotspotGenerationMode(
  value: unknown,
): KnowledgeHotspotGenerationMode {
  if (value === undefined || value === null || value === '') return 'single';
  if (typeof value !== 'string' || !GENERATION_MODES.has(value as KnowledgeHotspotGenerationMode)) {
    validation('generation_mode 仅支持 single、batch 或 retry');
  }
  return value as KnowledgeHotspotGenerationMode;
}

export function normalizeKnowledgeHotspotRequestId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') validation('request_id 格式不正确');
  const requestId = value.trim();
  if (!requestId || requestId.length > 128 || !REQUEST_ID_PATTERN.test(requestId)) {
    validation('request_id 只能包含字母、数字、点、下划线、冒号或短横线，且不超过 128 个字符');
  }
  return requestId;
}

function positiveInteger(value: unknown, label: string, fallback: number, max?: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = Array.isArray(value) ? '' : String(value).trim();
  if (!/^\d+$/.test(raw)) validation(`${label} 必须是正整数`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) validation(`${label} 必须是正整数`);
  if (max !== undefined && parsed > max) validation(`${label} 不能超过 ${max}`);
  return parsed;
}

export function normalizeKnowledgeHotspotDraftListQuery(input: {
  page?: unknown;
  pageSize?: unknown;
  keyword?: unknown;
} = {}): KnowledgeHotspotDraftListQuery {
  const page = positiveInteger(input.page, 'page', 1);
  const pageSize = positiveInteger(
    input.pageSize,
    'pageSize',
    KNOWLEDGE_HOTSPOT_DRAFT_PAGE_SIZE,
    KNOWLEDGE_HOTSPOT_DRAFT_MAX_PAGE_SIZE,
  );
  if (Array.isArray(input.keyword)) validation('keyword 格式不正确');
  const keyword = optionalText(input.keyword, 'keyword', 200);
  return { page, pageSize, keyword };
}

function publishedAtMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    validation('source_published_at_ms 格式不正确');
  }
  return value;
}

function publicRow(row: KnowledgeHotspotDraftDbRow): KnowledgeHotspotDraftItem {
  return {
    id: row.id,
    article_id: row.article_id,
    source_title: row.source_title,
    source_url: row.source_url,
    source_author: row.source_author,
    source_published_at_ms: row.source_published_at_ms,
    draft: row.draft_text,
    generation_mode: normalizeKnowledgeHotspotGenerationMode(row.generation_mode),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function ensureKnowledgeHotspotDraftSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_hotspot_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id TEXT NOT NULL,
      source_title TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      source_author TEXT NOT NULL DEFAULT '',
      source_published_at_ms INTEGER,
      draft_text TEXT NOT NULL,
      generation_mode TEXT NOT NULL DEFAULT 'single'
        CHECK (generation_mode IN ('single', 'batch', 'retry')),
      request_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_hotspot_drafts_article_created
      ON knowledge_hotspot_drafts (article_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_hotspot_drafts_created
      ON knowledge_hotspot_drafts (created_at DESC, id DESC);
  `);
}

export function createKnowledgeHotspotDraftRepository(
  db: Database.Database,
  options: { now?: () => string } = {},
) {
  ensureKnowledgeHotspotDraftSchema(db);
  const now = options.now ?? (() => new Date().toISOString());
  const byId = db.prepare('SELECT * FROM knowledge_hotspot_drafts WHERE id = ?');
  const byRequestId = db.prepare('SELECT * FROM knowledge_hotspot_drafts WHERE request_id = ?');
  const insert = db.prepare(`
    INSERT INTO knowledge_hotspot_drafts (
      article_id, source_title, source_url, source_author, source_published_at_ms,
      draft_text, generation_mode, request_id, created_at, updated_at
    ) VALUES (
      @articleId, @sourceTitle, @sourceUrl, @sourceAuthor, @sourcePublishedAtMs,
      @draft, @generationMode, @requestId, @createdAt, @updatedAt
    )
  `);

  const saveTransaction = db.transaction((input: SaveKnowledgeHotspotDraftInput): KnowledgeHotspotDraftItem => {
    const articleId = requiredText(input.source?.articleId, '文章 ID', 200);
    const sourceTitle = requiredText(input.source?.title, '文章来源标题', 500);
    const sourceUrl = safeHttpUrl(input.source?.url);
    const sourceAuthor = optionalText(input.source?.author, '文章来源作者', 200);
    const sourcePublishedAtMs = publishedAtMs(input.source?.publishedAtMs);
    const draft = requiredText(input.draft, '朋友圈正文草稿', 50_000);
    const generationMode = normalizeKnowledgeHotspotGenerationMode(input.generationMode);
    const requestId = normalizeKnowledgeHotspotRequestId(input.requestId);

    if (requestId) {
      const existing = byRequestId.get(requestId) as KnowledgeHotspotDraftDbRow | undefined;
      if (existing) {
        if (existing.article_id !== articleId) {
          throw new KnowledgeHotspotDraftError(
            'DRAFT_REQUEST_CONFLICT',
            'request_id 已用于另一篇文章',
            409,
          );
        }
        return publicRow(existing);
      }
    }

    const timestamp = now();
    const result = insert.run({
      articleId,
      sourceTitle,
      sourceUrl,
      sourceAuthor,
      sourcePublishedAtMs,
      draft,
      generationMode,
      requestId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const stored = byId.get(Number(result.lastInsertRowid)) as KnowledgeHotspotDraftDbRow | undefined;
    if (!stored) throw new Error('朋友圈草稿持久化后无法读取');
    return publicRow(stored);
  });

  return {
    save(input: SaveKnowledgeHotspotDraftInput): KnowledgeHotspotDraftItem {
      try {
        return saveTransaction(input);
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        const requestId = normalizeKnowledgeHotspotRequestId(input.requestId);
        if (requestId && typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
          const existing = byRequestId.get(requestId) as KnowledgeHotspotDraftDbRow | undefined;
          if (existing && existing.article_id === String(input.source?.articleId ?? '').trim()) {
            return publicRow(existing);
          }
        }
        throw error;
      }
    },

    findByRequestId(requestIdInput: unknown): KnowledgeHotspotDraftItem | null {
      const requestId = normalizeKnowledgeHotspotRequestId(requestIdInput);
      if (!requestId) return null;
      const row = byRequestId.get(requestId) as KnowledgeHotspotDraftDbRow | undefined;
      return row ? publicRow(row) : null;
    },

    list(queryInput: Partial<KnowledgeHotspotDraftListQuery> = {}): KnowledgeHotspotDraftListResult {
      const query = normalizeKnowledgeHotspotDraftListQuery(queryInput);
      const where = query.keyword
        ? `WHERE source_title LIKE @keyword ESCAPE '\\'
             OR source_author LIKE @keyword ESCAPE '\\'
             OR draft_text LIKE @keyword ESCAPE '\\'`
        : '';
      const params = query.keyword ? { keyword: `%${escapeLike(query.keyword)}%` } : {};
      const total = (db.prepare(`SELECT COUNT(*) AS count FROM knowledge_hotspot_drafts ${where}`)
        .get(params) as { count: number }).count;
      const rows = db.prepare(`
        SELECT * FROM knowledge_hotspot_drafts
        ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT @limit OFFSET @offset
      `).all({
        ...params,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      }) as KnowledgeHotspotDraftDbRow[];

      return {
        items: rows.map(publicRow),
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      };
    },
  };
}

export type KnowledgeHotspotDraftRepository = ReturnType<typeof createKnowledgeHotspotDraftRepository>;
