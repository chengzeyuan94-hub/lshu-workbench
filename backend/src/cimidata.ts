import crypto from 'node:crypto';

// ============================================================
// 次幂数据 API 客户端
// 权威 schema 参考：https://github.com/oychao1988/cimi-data-mcp
// 接口要点：
//   POST /api/token             body:{app_id,app_secret} → data.access_token
//   POST /api/v2/accounts/search body:{nickname|biz}      公众号信息
//   POST /api/v2/articles/current body:{nickname|biz}    当天发文
//   POST /api/v3/articles/detail  body:{url}             正文（HTML）
//   access_token 必须作为 QUERY 参数传递，不能放 body。
// ============================================================

function apiHost(): string {
  return (process.env.CIMIDATA_BASE_URL || 'https://www.cimidata.com/').replace(/\/$/, '') + '/';
}
function appId(): string {
  return process.env.CIMIDATA_APP_ID || '';
}
function appSecret(): string {
  return process.env.CIMIDATA_APP_SECRET || '';
}

// 单接口价格（元），用于成本估算与展示
export const CIMIDATA_PRICE = {
  token: 0,
  account_info: 0.04,
  current: 0.04,
  history: 0.05,
  body: 0.01,
  long2short: 0.01,
} as const;

// ===== 错误类型 =====
export class CimiError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'CimiError';
    this.code = code;
  }
}

// API 业务错误码：401 token 缺失/过期；4203/4204 token 失效
const TOKEN_EXPIRED_CODES = new Set([401, 4203, 4204]);

// ===== 内存 Token 缓存 =====
let cachedToken: string | null = null;
let tokenExpiresAt = 0; // epoch ms
let tokenFetching: Promise<string> | null = null;

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2h，官方 token 有效期约 2h，提前刷新
const TOKEN_EARLY_REFRESH_MS = 10 * 60 * 1000; // 提前 10 分钟刷新

export function _resetTokenCacheForTest(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
  tokenFetching = null;
}

function setToken(token: string): void {
  cachedToken = token;
  tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
}

/** 获取 access token（带缓存 + 提前刷新 + 并发合并） */
async function getAccessToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  // 缓存有效且未到期（或未到提前刷新窗口），直接返回
  if (!forceRefresh && cachedToken && now < tokenExpiresAt - TOKEN_EARLY_REFRESH_MS) {
    return cachedToken;
  }
  // 正在获取中则复用
  if (tokenFetching) return tokenFetching;

  tokenFetching = (async () => {
    if (!appId() || !appSecret()) {
      throw new CimiError(450, '次幂数据凭证未配置：请在 backend/.env.local 设置 CIMIDATA_APP_ID / CIMIDATA_APP_SECRET');
    }
    const res = await rawPost<{ access_token: string }>('/api/token', { app_id: appId(), app_secret: appSecret() }, false);
    const token = res?.access_token;
    if (!token) {
      throw new CimiError(450, '次幂 token 接口未返回 access_token');
    }
    setToken(token);
    return token;
  })();

  try {
    return await tokenFetching;
  } finally {
    tokenFetching = null;
  }
}

// ===== 请求基础设施 =====
// 1 QPS 限流
const MIN_INTERVAL_MS = 1000;
let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastRequestAt + MIN_INTERVAL_MS - now;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestAt = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RawResp<T> {
  data: T;
  code?: number;
  msg?: string;
  message?: string;
  balance?: number;
}

async function rawPost<T>(path: string, body: Record<string, unknown>, useToken = true): Promise<T> {
  const url = `${apiHost()}${path.replace(/^\//, '')}`;

  const run = async (token: string | null): Promise<T> => {
    await throttle();
    const query: Record<string, string> = {};
    if (useToken && token) query.access_token = token;
    const qs = new URLSearchParams(query).toString();
    const finalUrl = qs ? `${url}?${qs}` : url;

    let ctl: AbortController | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      ctl = new AbortController();
      timeoutId = setTimeout(() => ctl!.abort(), 15000);
      const res = await fetch(finalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      const json = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return {};
        }
      })() as { data?: T; code?: number; msg?: string; message?: string; balance?: number };

      // 业务错误（非 2xx 也常返回 code）
      const code = json.code ?? res.status;
      if (code !== undefined && code !== 200 && code !== 0) {
        throw new CimiError(Number(code), String(json.msg || json.message || `HTTP ${res.status}`));
      }
      if (!res.ok) {
        throw new CimiError(Number(code || res.status), `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return (json.data ?? (json as unknown as T));
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  // token 过期/失效 → 强制刷新重试一次（最多 2 次）
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const token = useToken ? await getAccessToken(attempt > 0) : null;
      return await run(token);
    } catch (e) {
      lastErr = e;
      if (e instanceof CimiError && TOKEN_EXPIRED_CODES.has(e.code) && useToken && attempt === 0) {
        // 让 token 过期路径触发刷新
        cachedToken = null;
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ===== 指数退避的重试包装（仅供单次真实调用用，避免误用导致多扣费）=====
export async function withRetry<T>(fn: () => Promise<T>, opts: { retries?: number; baseMs?: number } = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseMs = opts.baseMs ?? 1000;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i >= retries) break;
      const backoff = baseMs * Math.pow(2, i);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ===== 领域模型 =====
export interface CimiAccount {
  name: string;
  /** 微信 biz 标识（Mzg...） */
  biz: string;
  /** 公众号唯一 id（fakeid/id 类字段），用于历史文章可分页 */
  id: string;
  avatar?: string;
  signature?: string;
  fans?: number;
}

export interface CimiArticleListItem {
  title: string;
  /** 原文链接 */
  url: string;
  digest?: string;
  publish_time?: string;
  author?: string;
}

export interface CimiArticleBody {
  html: string;
}

// ===== 公众号信息（accounts/search）=====
function pickAccount(data: unknown): CimiAccount | null {
  if (!data) return null;
  const arr = Array.isArray(data) ? data : [data];
  for (const item of arr) {
    const o = (item ?? {}) as Record<string, unknown>;
    const name = String(o.nickname ?? o.name ?? o.nick_name ?? '');
    if (!name) continue;
    const biz = String(o.biz ?? o.__biz ?? o.biz_uin ?? '');
    // 公众号唯一 id：优先 fakeid（微信后台 usr 前缀），其次 id，最后兜底 biz
    let id = String(o.fakeid ?? o.id ?? o.query_id ?? '');
    if (!id) {
      for (const key of Object.keys(o)) {
        if (/fakeid|query_id|^id$/i.test(key) && typeof o[key] === 'string' && o[key]) {
          id = String(o[key]);
          break;
        }
      }
    }
    if (!id) id = biz;
    return {
      name,
      biz,
      id,
      avatar: typeof o.avatar === 'string' ? o.avatar : undefined,
      signature: typeof o.signature === 'string' ? o.signature : undefined,
      fans: typeof o.fans === 'number' ? o.fans : typeof o.follower_count === 'number' ? o.follower_count : undefined,
    };
  }
  return null;
}

export async function getCimiAccount(nickname: string | { nickname?: string; biz?: string }): Promise<CimiAccount | null> {
  const body =
    typeof nickname === 'string' ? { nickname } : (nickname as Record<string, unknown>);
  const out = await rawPost<unknown>('/api/v2/accounts/search', body);
  _recordCall('account_info');
  return pickAccount(out);
}

// ===== 当天发文（articles/current）=====
export async function getTodayArticles(nickname: string | { nickname?: string; biz?: string }): Promise<CimiArticleListItem[]> {
  const body =
    typeof nickname === 'string' ? { nickname } : (nickname as Record<string, unknown>);
  const data = await rawPost<unknown>('/api/v2/articles/current', body);
  _recordCall('current');
  const arr = Array.isArray(data) ? data : (data as { list?: unknown[] })?.list;
  if (!Array.isArray(arr)) return [];
  const items: CimiArticleListItem[] = [];
  for (const it of arr) {
    const o = (it ?? {}) as Record<string, unknown>;
    const title = String(o.title ?? '');
    // 真实 API 返回 content_url；兼容 url/link 备选
    const url = String(o.content_url ?? o.url ?? o.link ?? '');
    if (!title || !url) continue;
    items.push({
      title,
      url,
      digest: typeof o.digest === 'string' ? o.digest : typeof o.summary === 'string' ? o.summary : undefined,
      // 真实 API 返回 published_at；兼容 publish_time/publish_time_text 备选
      publish_time:
        typeof o.published_at === 'string' || typeof o.published_at === 'number'
          ? String(o.published_at)
          : typeof o.publish_time === 'string'
            ? o.publish_time
            : typeof o.publish_time_text === 'string'
              ? o.publish_time_text
              : undefined,
      author: typeof o.author === 'string' ? o.author : undefined,
    });
  }
  return items;
}

// ===== 正文（v2/articles/long2short → v3/articles/detail，返回 HTML）=====
// 次幂要求：微信长链必须先调 long2short 转成短链，detail 才能处理（否则报 code=1002）
export async function shortenArticleUrl(url: string): Promise<string | null> {
  try {
    const data = await rawPost<{ url?: string }>('/api/v2/articles/long2short', { url });
    _recordCall('long2short');
    const short = typeof data?.url === 'string' ? data.url : null;
    // 若返回的是相同长链（未能真正转短），仍回吐原 url，由下游再尝试
    return short && short !== url ? short : url;
  } catch {
    return url; // 转换失败不阻断，回退原 url 让 detail 自己处理
  }
}

export async function getArticleBody(url: string): Promise<CimiArticleBody | null> {
  // 先转短链（长链可能直接报 1002），再抓正文
  const shortUrl = await shortenArticleUrl(url);
  const data = await rawPost<unknown>('/api/v3/articles/detail', { url: shortUrl });
  _recordCall('body');
  if (!data) return null;
  const o = (data as Record<string, unknown>) ?? {};
  const html = String(o.html ?? o.content ?? o.body ?? o.data ?? '');
  return { html };
}

// ===== URL 规范化与去重 =====
// 微信 URL: https://mp.weixin.qq.com/s?__biz=Mzg...&mid=...&idx=...&sn=...#rd
// 用 biz+mid+idx+sn 生成 external_key，剔除 scene/sessionid/xtrack 等跟踪参数。
// 注意：用字符串处理而非 URLSearchParams，以保留 __biz 的 base64 "==" 原样，避免误编码。
export function normalizeWechatUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    const tracked = ['scene', 'sessionid', 'xtrack', 'from', 'chksm', 'ascene', 'devicetype', 'version', 'uin', 'key', 'pass_ticket', 'wxtoken', 'exportkey'];
    for (const p of tracked) u.searchParams.delete(p);
    // 还原 __biz 等 base64 值的 "==" 编码（URL.searchParams 会把 = 编码成 %3D）
    return u.toString().replace(/(%3D)+/g, '==');
  } catch {
    return url.trim();
  }
}

export function wechatExternalKey(url: string): string {
  try {
    const u = new URL(url.trim());
    const mid = u.searchParams.get('mid') ?? '';
    const idx = u.searchParams.get('idx') ?? '';
    const sn = u.searchParams.get('sn') ?? '';
    const biz = u.searchParams.get('__biz') ?? '';
    // 缺任一关键参数时退化为整串 URL 的 sha256
    if (!mid || !sn) {
      return 'u_' + crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
    }
    return 'w_' + crypto.createHash('sha256').update([biz, mid, idx, sn].join('|')).digest('hex').slice(0, 24);
  } catch {
    return 'u_' + crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
  }
}

export function extractWechatBiz(url: string): string {
  try {
    return new URL(url).searchParams.get('__biz') ?? '';
  } catch {
    return '';
  }
}

// ===== 正文长度统计（中文字符数）=====
export function countCjkChars(text: string): number {
  const m = text.match(/[\u3400-\u9FFF]/g);
  return m ? m.length : 0;
}

// ===== 是否有凭证 =====
export function hasCimiCredentials(): boolean {
  return !!(appId() && appSecret());
}

export function getCimiMeta() {
  return {
    hasCredentials: hasCimiCredentials(),
    appIdMasked: appId() ? maskAppId(appId()) : '',
    baseUrl: apiHost(),
  };
}

function maskAppId(id: string): string {
  const len = id.length;
  if (len <= 4) return '*'.repeat(len);
  return id.slice(0, 2) + '*'.repeat(Math.max(0, len - 4)) + id.slice(-2);
}

// ===== 调用统计（供状态页展示成本）=====
let callStats = { token: 0, account_info: 0, current: 0, body: 0, long2short: 0 };
export function _recordCall(kind: keyof typeof callStats): void {
  callStats[kind] += 1;
}
export function getCallStats(): typeof callStats & { estimatedCost: number } {
  const estimatedCost =
    callStats.account_info * CIMIDATA_PRICE.account_info +
    callStats.current * CIMIDATA_PRICE.current +
    callStats.body * CIMIDATA_PRICE.body +
    callStats.long2short * CIMIDATA_PRICE.long2short;
  return { ...callStats, estimatedCost };
}
export function resetCallStats(): void {
  callStats = { token: 0, account_info: 0, current: 0, body: 0, long2short: 0 };
}
