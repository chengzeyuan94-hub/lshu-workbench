import crypto from 'node:crypto';
import {
  getCimiAccount,
  getTodayArticles,
  getArticleBody,
  normalizeWechatUrl,
  wechatExternalKey,
  countCjkChars,
  getCallStats,
  CIMIDATA_PRICE,
  CimiError,
} from './cimidata';
import { cleanWechatHtml, hasDangerousHtml } from './htmlCleaner';
import {
  getAllHotspotSources,
  getHotspotSource,
  updateHotspotSourceInfo,
  markHotspotFetch,
  upsertHotspotArticle,
  updateHotspotArticleBody,
  markArticleBodyPending,
  createFetchRun,
  finishFetchRun,
  type HotspotSourceRow,
} from './db';

// sync 防重入：进程内锁
let syncing = false;
export function isSyncing(): boolean {
  return syncing;
}

function hashBody(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
}

type CallKind = 'token' | 'account_info' | 'current' | 'body' | 'long2short';

function diffCalls(before: ReturnType<typeof getCallStats>, after: ReturnType<typeof getCallStats>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ['token', 'account_info', 'current', 'body', 'long2short'] as CallKind[]) {
    const n = after[key] - before[key];
    if (n > 0) out[key] = n;
  }
  return out;
}

function callsCost(calls: Record<string, number>): number {
  return (
    (calls.account_info ?? 0) * CIMIDATA_PRICE.account_info +
    (calls.current ?? 0) * CIMIDATA_PRICE.current +
    (calls.body ?? 0) * CIMIDATA_PRICE.body +
    (calls.long2short ?? 0) * CIMIDATA_PRICE.long2short
  );
}

/**
 * 抓取单个来源的当天发文并入库。
 * 返回该来源的运行统计。即使某来源失败也不阻断整体。
 */
export async function syncOneSource(source: HotspotSourceRow, triggeredBy: string): Promise<{
  status: 'ok' | 'error';
  article_found: number;
  inserted: number;
  updated: number;
  duplicate: number;
  body_fetched: number;
  error_message?: string;
}> {
  const runId = createFetchRun(source.id, triggeredBy);
  const beforeCalls = getCallStats();
  const stats = {
    article_found: 0,
    inserted: 0,
    updated: 0,
    duplicate: 0,
    body_fetched: 0,
    status: 'ok' as 'ok' | 'error',
  };

  try {
    const nickname = source.source_key === 'wechat:huxiu' ? '虎嗅APP' : source.source_key === 'wechat:36kr' ? '36氪' : source.display_name;

    // 1. 初始化公众号信息（biz/wxid），非阻塞失败
    try {
      const account = await getCimiAccount(nickname);
      if (account) {
        updateHotspotSourceInfo(source.id, {
          biz: account.biz || undefined,
          wxid: account.id || undefined,
          avatar: account.avatar || undefined,
          signature: account.signature || undefined,
          fans: account.fans,
        });
      }
    } catch (e) {
      // 公众号信息拉取失败不阻断当天发文
      console.warn(`[hotspot] ${nickname} 公众号信息失败：${(e as Error).message}`);
    }

    // 2. 当天发文
    const articles = await getTodayArticles(nickname);
    stats.article_found = articles.length;

    // 3. 逐条去重入库
    for (const art of articles) {
      const normalizedUrl = normalizeWechatUrl(art.url);
      const externalKey = wechatExternalKey(art.url);
      const result = upsertHotspotArticle({
        source_id: source.id,
        external_key: externalKey,
        title: art.title,
        url: normalizedUrl,
        digest: art.digest ?? null,
        author: art.author ?? null,
        publish_time: art.publish_time ?? null,
      });
      if (result.status === 'inserted') {
        stats.inserted += 1;
      } else {
        stats.duplicate += 1;
      }

      // 4. 正文：新入库，或已入库但正文未就绪（duplicate 且 body_pending）的文章补抓正文
      //    使初次入库时正文失败（如 detail 报 1002）的文章可在后续同步重试
      const needBody = result.status === 'inserted' || result.bodyPending === true;
      if (needBody) {
        try {
          const body = await getArticleBody(normalizedUrl);
          if (body && body.html && !hasDangerousHtml(body.html)) {
            const clean = cleanWechatHtml(body.html);
            const cjk = countCjkChars(clean.text);
            updateHotspotArticleBody(result.id, {
              body_text: clean.text,
              body_hash: hashBody(clean.text),
              too_short: cjk < 200,
            });
            stats.body_fetched += 1;
          } else {
            markArticleBodyPending(result.id, '正文为空或含危险 HTML');
          }
        } catch (e) {
          markArticleBodyPending(result.id, (e as Error).message);
        }
      }
    }

    markHotspotFetch(source.id, stats.article_found);
    const calls = diffCalls(beforeCalls, getCallStats());
    finishFetchRun(runId, { ...stats, article_found: stats.article_found, cost: callsCost(calls), calls });
    return { status: 'ok', article_found: stats.article_found, inserted: stats.inserted, updated: stats.updated, duplicate: stats.duplicate, body_fetched: stats.body_fetched };
  } catch (e) {
    const msg = (e as Error).message;
    stats.status = 'error';
    const calls = diffCalls(beforeCalls, getCallStats());
    finishFetchRun(runId, { ...stats, status: 'error', error_message: msg, cost: callsCost(calls), calls });
    return { status: 'error', article_found: stats.article_found, inserted: stats.inserted, updated: stats.updated, duplicate: stats.duplicate, body_fetched: stats.body_fetched, error_message: msg };
  }
}

/**
 * 遍历所有启用来源执行一次完整同步。
 * 单来源失败不阻断其他来源。返回汇总。
 */
export async function runHotspotSync(triggeredBy: string): Promise<{
  syncStarted: boolean;
  total: number;
  sources: Array<{ source: string; status: string; article_found: number; inserted: number; duplicate: number; body_fetched: number; error_message?: string }>;
}> {
  if (syncing) {
    return { syncStarted: false, total: 0, sources: [] };
  }
  syncing = true;
  try {
    const sources = getAllHotspotSources().filter((s) => s.enabled === 1);
    const results: Array<{ source: string; status: string; article_found: number; inserted: number; duplicate: number; body_fetched: number; error_message?: string }> = [];
    for (const source of sources) {
      try {
        const r = await syncOneSource(source, triggeredBy);
        results.push({ source: source.display_name, ...r });
      } catch (e) {
        results.push({ source: source.display_name, status: 'error', article_found: 0, inserted: 0, duplicate: 0, body_fetched: 0, error_message: (e as Error).message });
      }
    }
    return { syncStarted: true, total: sources.length, sources: results };
  } finally {
    syncing = false;
  }
}

export { CimiError };
