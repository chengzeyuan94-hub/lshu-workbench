import { execFile } from 'node:child_process';
import type { CreatorMetric, CreatorNoteDetail, CreatorProfile, DetailRow, NotePerformance, XhsPeriod } from './types';

// 只读白名单：固定命令 + 固定参数，绝不允许前端传入任意 shell 命令
type ReadonlyCommand =
  | 'creator-profile'
  | 'creator-stats'
  | 'creator-notes'
  | 'creator-note-detail'
  | 'creator-notes-summary'
  | 'user'
  | 'whoami';

const READONLY_WHITELIST: ReadonlyCommand[] = [
  'creator-profile',
  'creator-stats',
  'creator-notes',
  'creator-note-detail',
  'creator-notes-summary',
  'user',
  'whoami',
];

const OPENCLI = process.env.OPENCLI_BIN || 'opencli';

// 允许的 stats 周期白名单
const STATS_PERIODS: XhsPeriod[] = ['seven', 'thirty'];

export interface OpencliError {
  code: 'NOT_FOUND' | 'BRIDGE' | 'LOGIN' | 'TIMEOUT' | 'OTHER';
  message: string;
}

/**
 * 使用 execFile 非 Shell 方式执行，参数固定白名单 argv，杜绝命令注入。
 * 绝不拼接 shell 字符串。
 */
function runExecFile(
  args: string[],
  timeoutMs = 90000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      OPENCLI,
      args,
      { maxBuffer: 30 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
}

function classifyError(err: NodeJS.ErrnoException, stderr: string): OpencliError {
  const msg = (err.message || '') + ' ' + stderr;
  if (err.code === 'ENOENT' || /command not found|not found/i.test(msg)) {
    return { code: 'NOT_FOUND', message: '未找到 OpenCLI。请确认已安装 opencli 并加入 PATH。' };
  }
  if (/bridge|chrome|connection|ECONN|daemon|connect/i.test(msg)) {
    return { code: 'BRIDGE', message: '浏览器桥接或 daemon 不可用。请确认 Chrome 扩展已连接、OpenCLI daemon 在运行。' };
  }
  if (/login|not logged|auth|unauthorized/i.test(msg)) {
    return { code: 'LOGIN', message: '小红书登录态失效。请用 opencli xiaohongshu login 重新登录。' };
  }
  if (err.code === 'ETIMEDOUT' || /timed?out/i.test(msg)) {
    return { code: 'TIMEOUT', message: 'OpenCLI 调用超时，请稍后重试。' };
  }
  return { code: 'OTHER', message: 'OpenCLI 调用失败：' + msg.slice(0, 300) };
}

// 规范化 profile
function normalizeProfile(raw: unknown): CreatorProfile | null {
  if (Array.isArray(raw)) {
    const map = new Map<string, unknown>();
    for (const item of raw) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.field === 'string') map.set(obj.field, obj.value);
      }
    }
    const num = (v: unknown) => (typeof v === 'number' ? v : parseInt(String(v ?? '0'), 10) || 0);
    return {
      name: String(map.get('Name') ?? ''),
      followers: num(map.get('Followers')),
      following: num(map.get('Following')),
      likesCollects: num(map.get('Likes & Collects')),
      creatorLevel: num(map.get('Creator Level')),
      levelProgress: String(map.get('Level Progress') ?? ''),
      bio: String(map.get('Bio') ?? ''),
      raw: { ...map },
    };
  }
  return null;
}

// 规范化 metrics（保留原始字段名与原始 total，供前端逐字段校验）
function normalizeMetrics(raw: unknown): CreatorMetric[] {
  const metricKeyMap: Record<string, string> = {
    观看数: 'views',
    平均观看时长: 'avg_view_time',
    主页访问: 'home_views',
    点赞数: 'likes',
    收藏数: 'collects',
    评论数: 'comments',
    弹幕数: 'danmaku',
    分享数: 'shares',
    涨粉数: 'new_followers',
  };

  if (!Array.isArray(raw)) return [];
  const result: CreatorMetric[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const metricName = String(obj.metric ?? '');
    const trendStr = String(obj.trend ?? '');
    const trend = trendStr === '-' ? [] : trendStr.split('→').map((s) => parseInt(s.trim(), 10) || 0);
    const key = metricKeyMap[metricName.split(' ')[0]] ?? metricName;
    const total = typeof obj.total === 'number' ? obj.total : parseInt(String(obj.total ?? '0'), 10) || 0;
    result.push({
      key,
      label: metricName,
      total,
      trend,
      rawName: metricName,
      rawTotal: total,
    });
  }
  return result;
}

// 规范化 notes
function normalizeNotes(raw: unknown): NotePerformance[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const obj = (item ?? {}) as Record<string, unknown>;
      const views = typeof obj.views === 'number' ? obj.views : parseInt(String(obj.views ?? '0'), 10) || 0;
      const collects = typeof obj.collects === 'number' ? obj.collects : parseInt(String(obj.collects ?? '0'), 10) || 0;
      return {
        id: String(obj.id ?? ''),
        rank: typeof obj.rank === 'number' ? obj.rank : parseInt(String(obj.rank ?? '0'), 10) || 0,
        title: String(obj.title ?? ''),
        date: String(obj.date ?? ''),
        views,
        likes: typeof obj.likes === 'number' ? obj.likes : parseInt(String(obj.likes ?? '0'), 10) || 0,
        collects,
        comments: typeof obj.comments === 'number' ? obj.comments : parseInt(String(obj.comments ?? '0'), 10) || 0,
        url: typeof obj.url === 'string' ? obj.url : undefined,
        collectRate: views > 0 ? (collects / views) * 100 : 0,
        lowPerformance: views > 0 && views < 500,
      };
    })
    .filter((n) => n.id);
}

async function safeCall(args: string[]): Promise<unknown> {
  const { stdout } = await runExecFile(args);
  if (!stdout.trim()) {
    throw new Error('empty output');
  }
  return JSON.parse(stdout);
}

export interface XhsLiveData {
  profile: CreatorProfile | null;
  notes: NotePerformance[];
  periods: Record<XhsPeriod, { period: XhsPeriod; metrics: CreatorMetric[] }>;
}

/**
 * 一次同步：并发拉取 profile、notes、seven stats、thirty stats。
 * 仅使用只读白名单命令。
 */
export async function fetchLiveXhs(): Promise<XhsLiveData> {
  try {
    const [profileRaw, notesRaw, sevenRaw, thirtyRaw] = await Promise.all([
      safeCall(['xiaohongshu', 'creator-profile', '-f', 'json']),
      safeCall(['xiaohongshu', 'creator-notes', '--limit', '20', '-f', 'json']),
      safeCall(['xiaohongshu', 'creator-stats', '--period', 'seven', '-f', 'json']),
      safeCall(['xiaohongshu', 'creator-stats', '--period', 'thirty', '-f', 'json']),
    ]);

    return {
      profile: normalizeProfile(profileRaw),
      notes: normalizeNotes(notesRaw),
      periods: {
        seven: { period: 'seven', metrics: normalizeMetrics(sevenRaw) },
        thirty: { period: 'thirty', metrics: normalizeMetrics(thirtyRaw) },
      },
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const stderr = (err as unknown as { stderr?: string }).stderr ?? '';
    throw classifyError(err, stderr);
  }
}

// ===== 单篇笔记详情解析 =====

// 校验小红书笔记 ID（16 位十六进制，允许 32 位）
export function isValidNoteId(id: string): boolean {
  return /^[0-9a-fA-F]{16,32}$/.test(id);
}

function parseNum(s: string): number | undefined {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

function parsePercent(s: string): number | undefined {
  // "54.5%" / "8.1%" → 54.5
  const m = /([\d.]+)\s*%/.exec(s);
  return m ? parseFloat(m[1]) : undefined;
}

// 解析 "2026-05-14=1831 | 2026-05-15=15124" → [{date,value}]
function parseTrendExtra(extra: string): Array<{ date: string; value: number }> {
  const out: Array<{ date: string; value: number }> = [];
  const parts = extra.split('|');
  for (const p of parts) {
    const m = /(\d{4}-\d{2}-\d{2})\s*=\s*([\d.]+)/.exec(p.trim());
    if (m) out.push({ date: m[1], value: parseFloat(m[2]) });
  }
  return out;
}

// 解析 "05-14 18:00=77 | 05-14 19:00=57" → [{dateTime,value}]
function parseHourlyExtra(extra: string): Array<{ dateTime: string; value: number }> {
  const out: Array<{ dateTime: string; value: number }> = [];
  const parts = extra.split('|');
  for (const p of parts) {
    const m = /(\d{2}-\d{2} \d{2}:\d{2})\s*=\s*([\d.]+)/.exec(p.trim());
    if (m) out.push({ dateTime: m[1], value: parseFloat(m[2]) });
  }
  return out;
}

// 解析观看来源 extra "曝光 61487 · 观看 4654 · 互动 382"
function parseTrafficExtra(extra: string): { impressions?: number; views?: number; engagements?: number } {
  const out: { impressions?: number; views?: number; engagements?: number } = {};
  let m = /曝光\s*([\d.]+)/.exec(extra);
  if (m) out.impressions = parseFloat(m[1]);
  m = /观看\s*([\d.]+)/.exec(extra);
  if (m) out.views = parseFloat(m[1]);
  m = /互动\s*([\d.]+)/.exec(extra);
  if (m) out.engagements = parseFloat(m[1]);
  return out;
}

export function parseNoteDetailRows(rows: DetailRow[]): Omit<CreatorNoteDetail, 'noteId' | 'fetchedAt' | 'source' | 'rawRows'> {
  const basic: CreatorNoteDetail['basic'] = {};
  const engagement: CreatorNoteDetail['engagement'] = {};
  const dailyTrends: Record<string, Array<{ date: string; value: number }>> = {};
  const hourlyTrends: Record<string, Array<{ dateTime: string; value: number }>> = {};
  const trafficSources: CreatorNoteDetail['trafficSources'] = [];
  const audience: CreatorNoteDetail['audience'] = {
    gender: [],
    ages: [],
    cities: [],
    interests: [],
  };
  let title: string | undefined;
  let publishedAt: string | undefined;

  for (const row of rows) {
    const { section, metric, value, extra } = row;
    if (section === '笔记信息') {
      if (metric === 'title') title = value;
      if (metric === 'published_at') publishedAt = value;
    } else if (section === '基础数据') {
      if (metric === '曝光数') basic.impressions = parseNum(value);
      else if (metric === '观看数') basic.views = parseNum(value);
      else if (metric === '封面点击率') basic.coverClickRate = parsePercent(value);
      else if (metric === '平均观看时长') {
        // "19.2秒" → 19.2
        basic.avgViewTimeSeconds = parseFloat(value) || undefined;
      } else if (metric === '涨粉数') basic.newFollowers = parseNum(value);
    } else if (section === '互动数据') {
      if (metric === '点赞数') engagement.likes = parseNum(value);
      else if (metric === '收藏数') engagement.collects = parseNum(value);
      else if (metric === '评论数') engagement.comments = parseNum(value);
      else if (metric === '分享数') engagement.shares = parseNum(value);
    } else if (section === '趋势数据') {
      if (metric.startsWith('按小时/')) {
        const name = metric.replace('按小时/', '');
        hourlyTrends[name] = parseHourlyExtra(extra);
      } else if (metric.startsWith('按天/')) {
        const name = metric.replace('按天/', '');
        dailyTrends[name] = parseTrendExtra(extra);
      }
    } else if (section === '观看来源') {
      trafficSources.push({
        name: metric,
        percent: parsePercent(value) ?? 0,
        ...parseTrafficExtra(extra),
      });
    } else if (section === '观众画像') {
      const idx = metric.indexOf('/');
      if (idx > 0) {
        const dim = metric.slice(0, idx);
        const name = metric.slice(idx + 1);
        const item = { name, percent: parsePercent(value) ?? 0 };
        if (dim === '性别') audience.gender.push(item);
        else if (dim === '年龄') audience.ages.push(item);
        else if (dim === '城市') audience.cities.push(item);
        else if (dim === '兴趣') audience.interests.push(item);
      }
    }
  }

  return { basic, engagement, dailyTrends, hourlyTrends, trafficSources, audience, title, publishedAt };
}

/**
 * 拉取单篇笔记详情。固定参数 execFile 调用，noteId 白名单校验。
 */
export async function fetchNoteDetail(noteId: string): Promise<Omit<CreatorNoteDetail, 'fetchedAt' | 'source'>> {
  if (!isValidNoteId(noteId)) {
    const err: OpencliError = { code: 'OTHER', message: '非法的笔记 ID，已拒绝请求。' };
    throw err;
  }
  try {
    const raw = await safeCall(['xiaohongshu', 'creator-note-detail', noteId, '-f', 'json']);
    const rows = Array.isArray(raw) ? (raw as DetailRow[]) : [];
    return {
      noteId,
      rawRows: rows,
      ...parseNoteDetailRows(rows),
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const stderr = (err as unknown as { stderr?: string }).stderr ?? '';
    throw classifyError(err, stderr);
  }
}

// ===== 账号身份验证（V1.2）=====

export interface LoginAccount {
  loggedIn: boolean;
  username?: string;
  followers?: number;
}

/**
 * 获取当前登录的账号信息（whoami）。
 * OpenCLI bridge 冷启动首次调用会偶发超时（OpenCLI 自身默认 60s timeout），
 * 这里重试一次以提升稳定性。
 */
export async function fetchWhoami(): Promise<LoginAccount> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await safeCall(['xiaohongshu', 'whoami', '-f', 'json']);
      const o = (raw ?? {}) as Record<string, unknown>;
      return {
        loggedIn: o.logged_in === true,
        username: typeof o.username === 'string' ? o.username : undefined,
        followers: typeof o.followers === 'number' ? o.followers : undefined,
      };
    } catch (e) {
      lastErr = e;
      const err = e as NodeJS.ErrnoException;
      const stderr = (err as unknown as { stderr?: string }).stderr ?? '';
      // 冷启动超时重试；非超时错误直接抛
      if (classifyError(err, stderr).code !== 'TIMEOUT') break;
    }
  }
  const err = lastErr as NodeJS.ErrnoException;
  const stderr = (err as unknown as { stderr?: string }).stderr ?? '';
  throw classifyError(err, stderr);
}

/**
 * 获取目标公开用户主页的笔记 ID 集合（user <userId>）。
 */
export async function fetchPublicUserNotes(userId: string): Promise<string[]> {
  const safe = userId.replace(/[^0-9a-zA-Z]/g, '');
  if (!safe) throw Object.assign(new Error('非法用户 ID'), { code: 'OTHER' });
  try {
    const raw = await safeCall(['xiaohongshu', 'user', safe, '-f', 'json']);
    if (!Array.isArray(raw)) return [];
    const ids: string[] = [];
    for (const item of raw) {
      const o = (item ?? {}) as Record<string, unknown>;
      if (typeof o.id === 'string' && /^[0-9a-fA-F]{16,32}$/.test(o.id)) ids.push(o.id);
    }
    return ids;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const stderr = (err as unknown as { stderr?: string }).stderr ?? '';
    throw classifyError(err, stderr);
  }
}

export interface AccountVerification {
  ok: boolean;
  status: 'verified' | 'mismatch' | 'unconnected' | 'unknown';
  displayName?: string;
  loginFollowers?: number;
  publicNotesCount?: number;
  creatorNotesCount?: number;
  intersectionCount?: number;
  message?: string;
}

/**
 * 账号身份验证：创建者中心账号名必须匹配目标 displayName，
 * 且 creator-notes 与目标公开主页笔记必须存在 ID 交集。
 * 不依赖名称唯一性（名称可重复），必须验证笔记 ID 交集。
 */
export async function verifyAccountIdentity(opts: {
  targetDisplayName: string;
  targetPublicUserId: string;
}): Promise<AccountVerification> {
  // 1. 当前登录账号
  let whoami: LoginAccount;
  try {
    whoami = await fetchWhoami();
  } catch (e) {
    return { ok: false, status: 'unconnected', message: `无法获取登录态：${(e as Error).message}` };
  }
  if (!whoami.loggedIn || !whoami.username) {
    return { ok: false, status: 'unconnected', message: 'OpenCLI 当前未登录小红书或有登录态异常（whoami）。' };
  }

  // 2. 当前登录账号名是否与目标一致（名称不唯一，作为第一道弱校验，仅提示）
  const nameMatch = whoami.username === opts.targetDisplayName;

  // 3. creator-notes 的笔记 ID 集合
  let creatorNotesIds: string[] = [];
  let creatorNotesCount = 0;
  try {
    const raw = await safeCall(['xiaohongshu', 'creator-notes', '--limit', '20', '-f', 'json']);
    if (Array.isArray(raw)) {
      creatorNotesIds = (raw as Array<{ id?: string }>)
        .map((n) => String(n.id ?? ''))
        .filter((id) => /^[0-9a-fA-F]{16,32}$/.test(id));
      creatorNotesCount = creatorNotesIds.length;
    }
  } catch {
    // 拉取失败不阻断，交集可能为空会判定为 mismatch/unknown
  }

  // 4. 目标公开主页笔记 ID 集合
  let publicNotesIds: string[] = [];
  let publicNotesCount = 0;
  try {
    publicNotesIds = await fetchPublicUserNotes(opts.targetPublicUserId);
    publicNotesCount = publicNotesIds.length;
  } catch {
    // 同上
  }

  // 5. 计算交集
  const pubSet = new Set(publicNotesIds);
  const intersection = creatorNotesIds.filter((id) => pubSet.has(id));
  const intersectionCount = intersection.length;

  // 6. 判定：名称匹配 且 交集>0 → verified；否则 mismatch/unknown
  if (nameMatch && intersectionCount > 0) {
    return {
      ok: true,
      status: 'verified',
      displayName: whoami.username,
      loginFollowers: whoami.followers,
      publicNotesCount,
      creatorNotesCount,
      intersectionCount,
      message: `账号验证通过：名称「${whoami.username}」匹配，creator 与公开主页笔记交集 ${intersectionCount} 篇。`,
    };
  }

  if (!nameMatch) {
    return {
      ok: false,
      status: 'mismatch',
      displayName: whoami.username,
      loginFollowers: whoami.followers,
      publicNotesCount,
      creatorNotesCount,
      intersectionCount,
      message: `账号不匹配：OpenCLI 当前登录「${whoami.username}」，预期「${opts.targetDisplayName}」。`,
    };
  }

  // 名称匹配但无交集 → 疑似同名但非目标账号，视为 mismatch（名称不具备唯一性）
  return {
    ok: false,
    status: 'mismatch',
    displayName: whoami.username,
    loginFollowers: whoami.followers,
    publicNotesCount,
    creatorNotesCount,
    intersectionCount,
    message: `账号无法确认：名称「${whoami.username}」匹配，但 creator 与公开主页笔记无交集（交集 ${intersectionCount} 篇），疑似非目标账号。`,
  };
}

// 导出只读白名单供后端固定参数使用
export const READONLY_COMMANDS = READONLY_WHITELIST;
export const ALLOWED_STATS_PERIODS = STATS_PERIODS;

// 类型 re-export（方便其他模块 import）
export type { CreatorProfile, CreatorMetric, NotePerformance };
export type { CreatorNoteDetail, DetailRow } from './types';
