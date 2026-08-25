import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ===== V1.3 热点雷达专项测试 =====
// 覆盖：URL 规范化与去重、正文清洗、危险 HTML 防护、CJK 统计、Token 缓存与过期重试、正文抓取去重
// 说明：网络调用通过 vi.stubGlobal('fetch') 模拟，不产生任何真实次幂计费。

// ---- 纯函数：URL 规范化 / 去重 ----
import {
  normalizeWechatUrl,
  wechatExternalKey,
  extractWechatBiz,
  countCjkChars,
} from '../src/cimidata';

describe('V1.3 URL 规范化与去重', () => {
  const baseUrl =
    'http://mp.weixin.qq.com/s?__biz=Mzg5NTEwMjc2OA==&mid=2247512345&idx=1&sn=abcdef1234567890';

  it('保留核心参数，剔除跟踪参数（scene/sessionid/xtrack/from 等）', () => {
    const dirty =
      baseUrl +
      '&scene=21&sessionid=xyz&xtrack=123&from=singlemessage&chksm=aaa&ascene=1&devicetype=iPhone';
    const clean = normalizeWechatUrl(dirty);
    expect(clean).toContain('__biz=Mzg5NTEwMjc2OA==');
    expect(clean).toContain('mid=2247512345');
    expect(clean).toContain('sn=abcdef1234567890');
    expect(clean).not.toContain('scene');
    expect(clean).not.toContain('sessionid');
    expect(clean).not.toContain('xtrack');
    expect(clean).not.toContain('chksm');
  });

  it('剔除 #rd 锚点', () => {
    const clean = normalizeWechatUrl(baseUrl + '#rd');
    expect(clean).not.toContain('#rd');
  });

  it('同一篇文章不同跟踪参数 → 相同 external_key（去重核心）', () => {
    const a = baseUrl + '&scene=1';
    const b = baseUrl + '&scene=2&from=timeline';
    expect(wechatExternalKey(a)).toBe(wechatExternalKey(b));
  });

  it('不同文章 → 不同 external_key', () => {
    const a = baseUrl;
    const b = baseUrl.replace('mid=2247512345', 'mid=2247512346');
    expect(wechatExternalKey(a)).not.toBe(wechatExternalKey(b));
  });

  it('缺 mid/sn 时退化为整串 URL 哈希', () => {
    const badUrl = 'http://mp.weixin.qq.com/s?__biz=Mzg5NTEwMjc2OA==';
    const key = wechatExternalKey(badUrl);
    expect(key.startsWith('u_')).toBe(true);
  });

  it('提取 __biz', () => {
    expect(extractWechatBiz(baseUrl)).toBe('Mzg5NTEwMjc2OA==');
  });
});

describe('V1.3 CJK 字符统计', () => {
  it('统计中文字符数', () => {
    expect(countCjkChars('你好世界')).toBe(4);
    expect(countCjkChars('hello 世界 123')).toBe(2);
    expect(countCjkChars('')).toBe(0);
  });
});

// ---- 正文清洗（纯函数）----
import { cleanWechatHtml, hasDangerousHtml } from '../src/htmlCleaner';

describe('V1.3 正文清洗', () => {
  it('剥离 script/style，保留正文段落', () => {
    const html =
      '<div><script>var a=1;</script><p>这是第一段正文。</p><style>.x{color:red}</style><p>这是第二段。</p></div>';
    const r = cleanWechatHtml(html);
    expect(r.text).toContain('这是第一段正文。');
    expect(r.text).toContain('这是第二段。');
    expect(r.text).not.toContain('var a=');
    expect(r.text).not.toContain('.x{color');
  });

  it('过滤噪音行（阅读原文/长按识别/微信扫一扫）', () => {
    const html =
      '<p>正文内容</p><p>阅读原文</p><p>长按识别二维码</p><p>微信扫一扫</p><p>完整建议的加粗</p>';
    const r = cleanWechatHtml(html);
    expect(r.text).toContain('正文内容');
    expect(r.text).not.toContain('阅读原文');
    expect(r.text).not.toContain('长按识别');
    expect(r.text).not.toContain('微信扫一扫');
  });

  it('屏蔽危险 HTML（script/iframe/embed）', () => {
    expect(hasDangerousHtml('<script>alert(1)</script>')).toBe(true);
    expect(hasDangerousHtml('<iframe src="http://evil"></iframe>')).toBe(true);
    expect(hasDangerousHtml('<p>正常正文</p>')).toBe(false);
  });

  it('无 HTML 标签的纯文本也能退化产出', () => {
    const r = cleanWechatHtml(
      '这是没有任何 HTML 标签的一段很长的文字。它包含多个中文句子。用于测试退化到按句切分的逻辑。'
    );
    expect(r.text.length).toBeGreaterThan(0);
  });
});

// ---- Token 缓存与过期重试（mock fetch）----
import { _resetTokenCacheForTest, getTodayArticles, getCimiAccount, getArticleBody, shortenArticleUrl } from '../src/cimidata';

describe('V1.3 Token 缓存与过期重试（mock 网络）', () => {
  // 记录业务接口被调用的次数
  let businessCalls: number;
  // 记录 token 请求次数
  let tokenCalls: number;

  beforeEach(() => {
    _resetTokenCacheForTest();
    businessCalls = 0;
    tokenCalls = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubEnv('CIMIDATA_APP_ID', 'test-app-id');
    vi.stubEnv('CIMIDATA_APP_SECRET', 'test-app-secret');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('token 有效期缓存：多次业务调用只请求一次 token', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { body?: string }) => {
      const bodyStr = opts?.body ?? '';
      // 判断是 token 请求还是业务请求
      if (bodyStr.includes('app_secret')) {
        tokenCalls += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { access_token: 'token-A' } }) };
      }
      // 业务接口 /array/search
      if (url.includes('/accounts/search')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ nickname: '虎嗅APP', biz: 'Mzg5NTEwMjc2OA==', fakeid: 'usr_abc123' }] }) };
      }
      // 业务接口 /articles/current
      if (url.includes('/articles/current')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { list: [] } }) };
      }
      throw new Error('unexpected url: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    // 调用两次做业务：calls token 只应一次（因为缓存）
    const acc = await getCimiAccount('虎嗅APP');
    const _articles = await getTodayArticles('虎嗅APP');
    expect(acc?.name).toBe('虎嗅APP');
    expect(acc?.biz).toBe('Mzg5NTEwMjc2OA==');
    expect(acc?.id).toBe('usr_abc123');
    expect(tokenCalls).toBe(1);
  });

  it('token 过期（4204）→ 强制刷新 → 重试成功', async () => {
    // 第一次业务调用返回 4204（token 失效），触发刷新后第二次成功
    let callIdx = 0;
    const fetchMock = vi.fn(async (url: string, opts?: { body?: string }) => {
      const bodyStr = opts?.body ?? '';
      if (bodyStr.includes('app_secret')) {
        tokenCalls += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { access_token: `token-${tokenCalls}` } }) };
      }
      // 业务接口（current）第一次返回 4204
      if (url.includes('/articles/current')) {
        callIdx += 1;
        businessCalls += 1;
        if (callIdx === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ code: 4204, msg: 'token 已过期' }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { list: [{ title: '测试文', url: 'http://mp.weixin.qq.com/s?__biz=Mzg5NTEwMjc2OA==&mid=1&idx=1&sn=abc' }] } }) };
      }
      throw new Error('unexpected url: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const articles = await getTodayArticles('虎嗅APP');
    expect(businessCalls).toBe(2); // 第一次 4204，第二次成功
    expect(tokenCalls).toBe(2); // 初始 token + 刷新 token
    expect(articles.length).toBe(1);
    expect(articles[0].title).toBe('测试文');
  });

  it('单来源失败不阻断：获取文章的 id 字段为 fakeid', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { body?: string }) => {
      const bodyStr = opts?.body ?? '';
      if (bodyStr.includes('app_secret')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { access_token: 'token-A' } }) };
      }
      if (url.includes('/accounts/search')) {
        // 返回无 fakeid，仅有 id 字段
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ nickname: '36氪', biz: 'Mzg5NTEwMjc2OA==', id: 'usr_999' }] }) };
      }
      throw new Error('unexpected: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const acc = await getCimiAccount('36氪');
    expect(acc?.id).toBe('usr_999');
  });
});

describe('V1.3 真实 schema 兼容（本轮回测回归）', () => {
  beforeEach(() => {
    _resetTokenCacheForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubEnv('CIMIDATA_APP_ID', 'test-app-id');
    vi.stubEnv('CIMIDATA_APP_SECRET', 'test-app-secret');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('articles/current 返回数组且用 content_url 字段时能解析（真实 schema）', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { body?: string }) => {
      const bodyStr = opts?.body ?? '';
      if (bodyStr.includes('app_secret')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { access_token: 'token-A' } }) };
      }
      if (url.includes('/articles/current')) {
        // 真实返回：data 直接是数组，字段 content_url / published_at / idx
        return {
          ok: true, status: 200, text: async () =>
            JSON.stringify({
              code: 200, msg: 'success', data: [
                {
                  title: '月薪3500，想拿大结果',
                  content_url: 'https://mp.weixin.qq.com/s?__biz=MTQzMjE1NjQwMQ==&mid=2656195999&idx=1&sn=2a60dee6efb47fb6',
                  digest: '全民跑步进入大结果时代',
                  published_at: '2026-08-23T12:31:19',
                  idx: 1,
                },
              ],
            }),
        };
      }
      throw new Error('unexpected: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const articles = await getTodayArticles('虎嗅APP');
    expect(articles.length).toBe(1);
    expect(articles[0].title).toBe('月薪3500，想拿大结果');
    // 必须取到 content_url 而不是空（本轮修复点）
    expect(articles[0].url).toBe('https://mp.weixin.qq.com/s?__biz=MTQzMjE1NjQwMQ==&mid=2656195999&idx=1&sn=2a60dee6efb47fb6');
    expect(articles[0].publish_time).toBe('2026-08-23T12:31:19');
  });

  it('v2/long2short → v3/articles/detail 链路：detail 前先转短链（真实正文链路）', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, opts?: { body?: string }) => {
      const bodyStr = opts?.body ?? '';
      calls.push(url);
      if (bodyStr.includes('app_secret')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { access_token: 'token-A' } }) };
      }
      // long2short：返回短链
      if (url.includes('/long2short')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { url: 'https://mp.weixin.qq.com/s/short-abc123' } }) };
      }
      // detail：返回正文 HTML
      if (url.includes('/articles/detail')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { html: '<div class="rich_media_content"><p>正文第一段。</p><p>正文第二段。</p></div>' } }) };
      }
      throw new Error('unexpected: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const body = await getArticleBody('https://mp.weixin.qq.com/s?__biz=MTQzMjE1NjQwMQ==&mid=1&idx=1&sn=abc');
    // 确认先调了 long2short，再调 detail
    expect(calls.some((u) => u.includes('/long2short'))).toBe(true);
    expect(body?.html).toContain('正文第一段');
  });

  it('shortenArticleUrl：转短失败回退原 url，不抛异常', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { body?: string }) => {
      const bodyStr = opts?.body ?? '';
      if (bodyStr.includes('app_secret')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { access_token: 'token-A' } }) };
      }
      if (url.includes('/long2short')) {
        // 返回相同长链（未能真正转短）
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { url: 'https://mp.weixin.qq.com/s?__biz=MTQzMjE1NjQwMQ==&mid=1&idx=1&sn=abc' } }) };
      }
      throw new Error('unexpected: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await shortenArticleUrl('https://mp.weixin.qq.com/s?__biz=MTQzMjE1NjQwMQ==&mid=1&idx=1&sn=abc');
    // 未真正转短时回退原 url
    expect(result).toBe('https://mp.weixin.qq.com/s?__biz=MTQzMjE1NjQwMQ==&mid=1&idx=1&sn=abc');
  });
});
