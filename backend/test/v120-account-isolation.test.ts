import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

// ===== V1.2 账号隔离专项测试 =====
// 覆盖：笔记 ID 白名单、单篇详情解析（新账号真实形态）、DB 层按账号隔离（不串号到 legacy）

// ---- 纯函数测试（opencli.ts 不依赖 OpenCLI 的部分）----
import { isValidNoteId, parseNoteDetailRows } from '../src/opencli';

describe('V1.2 账号隔离：笔记 ID 白名单', () => {
  it('接受标准的 16 位十六进制笔记 ID', () => {
    expect(isValidNoteId('6a70417b000000002803181c')).toBe(true);
    expect(isValidNoteId('6a47afbf000000001700aa2f')).toBe(true);
  });

  it('拒绝非十六进制 / 长度不符的非法 ID', () => {
    expect(isValidNoteId('')).toBe(false);
    expect(isValidNoteId('abc')).toBe(false);
    expect(isValidNoteId('zzzzzzzzzzzzzzzz')).toBe(false);
    expect(isValidNoteId('6a70417b000000002803181!')).toBe(false);
  });

  it('拒绝带注入风险的任意字符串', () => {
    expect(isValidNoteId('1; DROP TABLE xhs_note_details')).toBe(false);
    expect(isValidNoteId('../../etc/passwd')).toBe(false);
  });
});

describe('V1.2 账号隔离：单篇笔记详情解析（新账号真实数据形态）', () => {
  const realRows = [
    { section: '笔记信息', metric: 'title', value: '一个人翻身最快方式，做自己的小生意Vol.4', extra: '' },
    { section: '笔记信息', metric: 'published_at', value: '2026-08-03 15:21', extra: '' },
    { section: '基础数据', metric: '曝光数', value: '16931', extra: '粉丝占比 4.5%' },
    { section: '基础数据', metric: '观看数', value: '3671', extra: '' },
    { section: '基础数据', metric: '封面点击率', value: '54.5%', extra: '' },
    { section: '基础数据', metric: '平均观看时长', value: '19.2', extra: '' },
    { section: '基础数据', metric: '涨粉数', value: '12', extra: '' },
    { section: '互动数据', metric: '点赞数', value: '121', extra: '' },
    { section: '互动数据', metric: '收藏数', value: '159', extra: '' },
    { section: '互动数据', metric: '评论数', value: '4', extra: '' },
    { section: '互动数据', metric: '分享数', value: '3', extra: '' },
    { section: '趋势数据', metric: '按天/观看数', value: '', extra: '2026-08-01=1200 | 2026-08-02=1800' },
    { section: '趋势数据', metric: '按小时/观看数', value: '', extra: '08-03 00:00=10 | 08-03 01:00=20' },
    { section: '观看来源', metric: '关注页', value: '55.0%', extra: '曝光 61487 · 观看 4654 · 互动 382' },
    { section: '观众画像', metric: '性别/女', value: '60.0%', extra: '' },
    { section: '观众画像', metric: '年龄/18-24', value: '40.0%', extra: '' },
  ];

  it('解析标题与发布时间', () => {
    const r = parseNoteDetailRows(realRows as never);
    expect(r.title).toBe('一个人翻身最快方式，做自己的小生意Vol.4');
    expect(r.publishedAt).toBe('2026-08-03 15:21');
  });

  it('解析基础数据（曝光/观看/封面点击率/平均时长）', () => {
    const r = parseNoteDetailRows(realRows as never);
    expect(r.basic.impressions).toBe(16931);
    expect(r.basic.views).toBe(3671);
    expect(r.basic.coverClickRate).toBe(54.5);
    expect(r.basic.avgViewTimeSeconds).toBe(19.2);
    expect(r.basic.newFollowers).toBe(12);
  });

  it('解析互动数据（点赞/收藏/评论/分享）', () => {
    const r = parseNoteDetailRows(realRows as never);
    expect(r.engagement.likes).toBe(121);
    expect(r.engagement.collects).toBe(159);
    expect(r.engagement.comments).toBe(4);
    expect(r.engagement.shares).toBe(3);
  });

  it('解析按天与按小时趋势', () => {
    const r = parseNoteDetailRows(realRows as never);
    expect(r.dailyTrends['观看数']).toEqual([
      { date: '2026-08-01', value: 1200 },
      { date: '2026-08-02', value: 1800 },
    ]);
    expect(r.hourlyTrends['观看数']).toEqual([
      { dateTime: '08-03 00:00', value: 10 },
      { dateTime: '08-03 01:00', value: 20 },
    ]);
  });

  it('解析观看来源与观众画像', () => {
    const r = parseNoteDetailRows(realRows as never);
    expect(r.trafficSources[0]).toMatchObject({ name: '关注页', percent: 55, impressions: 61487, views: 4654, engagements: 382 });
    expect(r.audience.gender).toEqual([{ name: '女', percent: 60 }]);
    expect(r.audience.ages).toEqual([{ name: '18-24', percent: 40 }]);
  });
});

// ---- DB 层账号隔离测试（使用独立临时数据目录，不污染真实库）----
// 注意：db.ts 在 import 时即打开数据库。为保证隔离，需要在 import 前设置 WORKBENCH_DATA_DIR。
// 每个测试用独立的临时目录 + vi.resetModules 重新加载 db 模块，避免状态串扰。

describe('V1.2 账号隔离：DB 层查询不串号', () => {
  let dataDir: string;
  let db: typeof import('../src/db');

  const freshDb = async () => {
    // 清空上一次的临时目录（若存在）
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = mkdtempSync(join(tmpdir(), 'xhs-wb-test-'));
    process.env.WORKBENCH_DATA_DIR = dataDir;
    vi.resetModules();
    db = await import('../src/db');
  };

  beforeEach(async () => {
    await freshDb();
    db.upsertAccount({
      account_key: db.TARGET_ACCOUNT_KEY,
      display_name: 'L叔的播客',
      public_profile_url: db.TARGET_ACCOUNT.publicProfileUrl,
      creator_center_url: db.TARGET_ACCOUNT.creatorCenterUrl,
      verification_status: 'verified',
      verified_at: new Date().toISOString(),
      is_active: 1,
    });
  });

  afterAll(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('写入目标账号快照后，getLatestXhsSnapshot(目标) 能取到', () => {
    db.saveXhsSnapshot({
      account_key: db.TARGET_ACCOUNT_KEY,
      synced_at: new Date().toISOString(),
      profile_json: JSON.stringify({ name: 'L叔的播客', followers: 4517 }),
      metrics: [],
      notes: [{ id: '6a70417b000000002803181c', rank: 1, title: '测试笔记', date: '', views: 100, likes: 1, collects: 2, comments: 0 }],
      periods: { seven: { period: 'seven', metrics: [] }, thirty: { period: 'thirty', metrics: [] } },
      source: 'live',
      message: '测试',
    });
    const snap = db.getLatestXhsSnapshot(db.TARGET_ACCOUNT_KEY);
    expect(snap).toBeDefined();
    expect(snap!.account_key).toBe(db.TARGET_ACCOUNT_KEY);
    expect(JSON.parse(snap!.notes_json)[0].id).toBe('6a70417b000000002803181c');
  });

  it('插入 legacy 快照后，按账号查询不会串到 legacy（目标无快照时返回 undefined）', () => {
    // 本测试独立 DB 只写 legacy
    db.saveXhsSnapshot({
      account_key: 'legacy:unscoped-account',
      synced_at: new Date().toISOString(),
      profile_json: JSON.stringify({ name: '旧版示例账号', followers: 12000 }),
      metrics: [],
      notes: [{ id: '69cd22f10000000023020b37', rank: 1, title: '旧', date: '', views: 1, likes: 0, collects: 0, comments: 0 }],
      periods: { seven: { period: 'seven', metrics: [] }, thirty: { period: 'thirty', metrics: [] } },
      source: 'live',
    });
    // 只查目标账号，应返回 undefined（本库尚未给目标写快照）
    expect(db.getLatestXhsSnapshot(db.TARGET_ACCOUNT_KEY)).toBeUndefined();
    // 全局 latest 能取到 legacy，但按账号查询不会——证明隔离
    expect(db.getLatestXhsSnapshotAny()!.account_key).toBe('legacy:unscoped-account');
  });

  it('noteIdBelongsToAccount：旧账号笔记不属于目标账号', () => {
    db.saveXhsSnapshot({
      account_key: db.TARGET_ACCOUNT_KEY,
      synced_at: new Date().toISOString(),
      profile_json: null,
      metrics: [],
      notes: [{ id: '6a70417b000000002803181c', rank: 1, title: '新', date: '', views: 1, likes: 0, collects: 0, comments: 0 }],
      periods: { seven: { period: 'seven', metrics: [] }, thirty: { period: 'thirty', metrics: [] } },
      source: 'live',
      message: null,
    });
    expect(db.noteIdBelongsToAccount(db.TARGET_ACCOUNT_KEY, '6a70417b000000002803181c')).toBe(true);
    // 旧账号 legacy 的笔记 ID 不被目标账号承认 → 串号防护生效
    expect(db.noteIdBelongsToAccount(db.TARGET_ACCOUNT_KEY, '69cd22f10000000023020b37')).toBe(false);
  });
});
