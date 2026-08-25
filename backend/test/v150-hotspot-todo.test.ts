import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// V1.5 P0-3/P1-1/P1-2 数据层测试：
// - 热点文章加入待办事务与去重
// - 抓取运行成本持久化
// - 正文抓取失败原因持久化
// 使用临时数据库目录，不污染真实 workbench.db。

let dbDir: string;
let db: typeof import('../src/db');

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'wb-v150-hotspot-'));
  const old = process.env.WORKBENCH_DATA_DIR;
  process.env.WORKBENCH_DATA_DIR = dbDir;
  db = await import('../src/db');
  if (old === undefined) delete process.env.WORKBENCH_DATA_DIR;
  else process.env.WORKBENCH_DATA_DIR = old;
});

afterAll(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

const url = 'http://mp.weixin.qq.com/s?__biz=Mzg5NTEwMjc2OA==&mid=2247512345&idx=1&sn=abcdef1234567890';

describe('V1.5 热点加入待办事务', () => {
  it('首次加入成功，文章 todo_status 与 todos 写入同时生效', () => {
    const src = db.getHotspotSourceByKey('wechat:huxiu')!;
    const r = db.upsertHotspotArticle({ source_id: src.id, external_key: 'w_' + 'a'.repeat(24), title: '加入待办事务测试', url, publish_time: '2026-08-23 10:00:00' });
    const result = db.addHotspotArticleToTodo(r.id);
    expect(result.status).toBe('added');
    expect(result.todoId).toBeTruthy();
    const article = db.getHotspotArticle(r.id);
    expect(article!.todo_status).toBe('added');
    const todo = db.getTodos().find((t) => t.source_path === url);
    expect(todo).toBeTruthy();
    expect(todo!.cluster).toContain(`热点雷达·文章#${r.id}`);
  });

  it('重复加入返回 already，不重复写入 todos', () => {
    const src = db.getHotspotSourceByKey('wechat:huxiu')!;
    const r = db.upsertHotspotArticle({ source_id: src.id, external_key: 'w_' + 'b'.repeat(24), title: '重复加入测试', url: url + '&scene=2', publish_time: '2026-08-23 11:00:00' });
    expect(db.addHotspotArticleToTodo(r.id).status).toBe('added');
    const before = db.getTodos().filter((t) => t.source_path === url + '&scene=2').length;
    const second = db.addHotspotArticleToTodo(r.id);
    expect(second.status).toBe('already');
    const after = db.getTodos().filter((t) => t.source_path === url + '&scene=2').length;
    expect(before).toBe(1);
    expect(after).toBe(1);
  });

  it('文章不存在返回 not_found', () => {
    expect(db.addHotspotArticleToTodo(99999999).status).toBe('not_found');
  });
});

describe('V1.5 成本与正文错误持久化', () => {
  it('finishFetchRun 写入 cost/calls，getHotspotCostTotal 累计不归零', () => {
    const runId = db.createFetchRun(null, 'scheduler:2026-08-23:13:30');
    db.finishFetchRun(runId, {
      article_found: 8, inserted: 8, updated: 0, duplicate: 0, body_fetched: 8, status: 'ok',
      cost: 0.32,
      calls: { account_info: 2, current: 2, long2short: 8, body: 8 },
    });
    const run = db.getRecentFetchRuns(1)[0];
    expect(run.cost).toBeCloseTo(0.32, 3);
    expect(JSON.parse(run.calls_json).long2short).toBe(8);
    expect(db.getHotspotCostTotal()).toBeCloseTo(0.32, 3);
    expect(db.getHotspotCallTotals()).toMatchObject({ account_info: 2, current: 2, long2short: 8, body: 8 });
    expect(db.getHotspotCallTotals().estimatedCost).toBeCloseTo(0.32, 3);
  });

  it('markArticleBodyPending 持久化失败原因，不再 void message', () => {
    const src = db.getHotspotSourceByKey('wechat:36kr')!;
    const r = db.upsertHotspotArticle({ source_id: src.id, external_key: 'w_' + 'c'.repeat(24), title: '正文失败原因测试', url: url + '&scene=3', publish_time: '2026-08-23 12:00:00' });
    db.markArticleBodyPending(r.id, 'detail 接口 code=1002');
    const article = db.getHotspotArticle(r.id)!;
    expect(article.body_pending).toBe(1);
    expect(article.body_error).toBe('detail 接口 code=1002');
  });
});
