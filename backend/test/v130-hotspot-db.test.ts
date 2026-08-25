import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== V1.3 DB 层去重与待办防重复测试 =====
// 用临时数据库目录隔离，避免污染真实 workbench.db。
// db.ts 在首次 import 时读取 WORKBENCH_DATA_DIR，因此须在 import 前设置。

let dbDir: string;
let db: typeof import('../src/db');

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'wb-hotspot-'));
  // 关键：在模块首次加载前设置环境变量，让 db.ts 指向临时目录
  const old = process.env.WORKBENCH_DATA_DIR;
  process.env.WORKBENCH_DATA_DIR = dbDir;
  db = await import('../src/db');
  if (old === undefined) delete process.env.WORKBENCH_DATA_DIR;
  else process.env.WORKBENCH_DATA_DIR = old;
});

afterAll(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

describe('V1.3 热点来源初始化', () => {
  it('自动 upsert 默认来源（虎嗅APP / 36氪）', () => {
    const srcs = db.getAllHotspotSources();
    expect(srcs.some((s) => s.source_key === 'wechat:huxiu')).toBe(true);
    expect(srcs.some((s) => s.source_key === 'wechat:36kr')).toBe(true);
  });
});

describe('V1.3 文章入库去重', () => {
  const source = () => db.getHotspotSourceByKey('wechat:huxiu')!;
  const url =
    'http://mp.weixin.qq.com/s?__biz=Mzg5NTEwMjc2OA==&mid=2247512345&idx=1&sn=abcdef1234567890';

  it('首次插入 → inserted；再次同文 → duplicate，不重复插件', () => {
    const srcId = source().id;
    const k = 'w_' + Array(24).fill('a').join('');
    const first = db.upsertHotspotArticle({
      source_id: srcId,
      external_key: k,
      title: '测试文章',
      url,
      publish_time: '2026-08-23 10:00:00',
    });
    expect(first.status).toBe('inserted');

    const second = db.upsertHotspotArticle({
      source_id: srcId,
      external_key: k,
      title: '测试文章',
      url,
      publish_time: '2026-08-23 10:00:00',
    });
    expect(second.status).toBe('duplicate');
    expect(second.id).toBe(first.id);
  });

  it('不同 external_key → 独立入库', () => {
    const srcId = source().id;
    const r = db.upsertHotspotArticle({
      source_id: srcId,
      external_key: 'w_' + Array(24).fill('b').join(''),
      title: '另一篇',
      url,
      publish_time: '2026-08-23 11:00:00',
    });
    expect(r.status).toBe('inserted');
  });

  it('正文更新：写入 body_hash 后重复调用不再抓正文（body_pending 复位）', () => {
    const srcId = source().id;
    const r = db.upsertHotspotArticle({
      source_id: srcId,
      external_key: 'w_' + Array(24).fill('c').join(''),
      title: '正文测试',
      url,
      publish_time: '2026-08-23 12:00:00',
    });
    expect(r.status).toBe('inserted');
    db.updateHotspotArticleBody(r.id, { body_text: '这是合并后的正文内容，用于测试。', body_hash: 'hash-1', too_short: false });
    const after = db.getHotspotArticle(r.id);
    expect(after!.body_ready).toBe(1);
    expect(after!.body_pending).toBe(0);
    expect(after!.body_hash).toBe('hash-1');
    // 正文过短场景
    db.markArticleBodyPending(r.id, '失败');
    const pending = db.getHotspotArticle(r.id);
    expect(pending!.body_pending).toBe(1);
    expect(pending!.body_ready).toBe(0);
  });
});

describe('V1.3 抓取运行记录', () => {
  it('createFetchRun → finishFetchRun 渲染状态', () => {
    const runId = db.createFetchRun(1, 'manual');
    const run = db.getRecentFetchRuns(1)[0];
    expect(run.status).toBe('running');
    db.finishFetchRun(runId, { article_found: 3, inserted: 2, updated: 0, duplicate: 1, body_fetched: 2, status: 'ok' });
    const after = db.getRecentFetchRuns(1)[0];
    expect(after.status).toBe('ok');
    expect(after.inserted).toBe(2);
    expect(after.duplicate).toBe(1);
  });
});
