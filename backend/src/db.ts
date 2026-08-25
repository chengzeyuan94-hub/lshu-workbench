import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClusterSummary, ScanFile, CreatorMetric, NotePerformance } from './types';
import { createProductivityRepos, migrateProductivityV2 } from './productivitySchema';
import { ensureProductivityV3 } from './productivitySchemaV3';
import { ensureProductivityV31 } from './productivitySchemaV31';
import { ensureProductivityV4 } from './productivitySchemaV4';
import { fingerprintSource } from './services/hash';
import { ensurePrivateDir, ensurePrivateFile } from './config/filePermissions';
import { publicSettings as projectPublicSettings } from './config/settingsPolicy';
import {
  createKnowledgeHotspotDraftRepository,
  ensureKnowledgeHotspotDraftSchema,
} from './knowledgeHotspotDrafts';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.WORKBENCH_DATA_DIR || __dirname + '/../data';
export const DB_PATH = DATA_DIR + '/workbench.db';

ensurePrivateDir(DATA_DIR);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
ensurePrivateFile(DB_PATH);
ensurePrivateFile(DB_PATH + '-wal');
ensurePrivateFile(DB_PATH + '-shm');

// ===== Schema 初始化 =====
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scan_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scanned_at TEXT NOT NULL,
    root_dir TEXT NOT NULL,
    file_count INTEGER NOT NULL,
    skipped_count INTEGER NOT NULL,
    clusters_json TEXT NOT NULL,
    files_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source_path TEXT NOT NULL,
    cluster TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS xhs_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_key TEXT NOT NULL DEFAULT '',
    synced_at TEXT NOT NULL,
    profile_json TEXT,
    metrics_json TEXT NOT NULL,
    notes_json TEXT NOT NULL,
    source TEXT NOT NULL,
    message TEXT
  );

  CREATE TABLE IF NOT EXISTS xhs_note_details (
    account_key TEXT NOT NULL,
    note_id TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    source TEXT NOT NULL,
    message TEXT,
    PRIMARY KEY (account_key, note_id)
  );

  CREATE TABLE IF NOT EXISTS xhs_accounts (
    account_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    public_profile_url TEXT,
    creator_center_url TEXT,
    verification_status TEXT NOT NULL DEFAULT 'unknown',
    verified_at TEXT,
    last_sync_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 0
  );

  -- ===== V1.3 热点雷达（次幂数据）=====
  CREATE TABLE IF NOT EXISTS hotspot_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    account_biz TEXT NOT NULL DEFAULT '',
    account_wxid TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    signature TEXT,
    fans INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_fetch_at TEXT,
    last_article_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS hotspot_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    external_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    digest TEXT,
    author TEXT,
    publish_time TEXT,
    fetched_at TEXT NOT NULL,
    body_text TEXT,
    body_ready INTEGER NOT NULL DEFAULT 0,
    body_too_short INTEGER NOT NULL DEFAULT 0,
    body_pending INTEGER NOT NULL DEFAULT 1,
    body_hash TEXT,
    body_error TEXT,
    read_status TEXT NOT NULL DEFAULT 'unread',
    todo_status TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES hotspot_sources (id)
  );

  CREATE TABLE IF NOT EXISTS hotspot_fetch_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER,
    triggered_by TEXT NOT NULL DEFAULT 'manual',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    article_found INTEGER NOT NULL DEFAULT 0,
    inserted INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    duplicate INTEGER NOT NULL DEFAULT 0,
    body_fetched INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    cost REAL NOT NULL DEFAULT 0,
    calls_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (source_id) REFERENCES hotspot_sources (id)
  );
`);

// ===== 兼容迁移：为旧库 xhs_snapshots 补 periods_json 列 =====
{
  const cols = db.prepare(`PRAGMA table_info(xhs_snapshots)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'periods_json')) {
    db.exec(`ALTER TABLE xhs_snapshots ADD COLUMN periods_json TEXT`);
  }
  // account_key 列兼容迁移
  if (!cols.some((c) => c.name === 'account_key')) {
    db.exec(`ALTER TABLE xhs_snapshots ADD COLUMN account_key TEXT NOT NULL DEFAULT ''`);
  }
}

// ===== 重建 xhs_note_details 为 (account_key, note_id) 复合主键 =====
// 旧表主键为 note_id 单列。表已以新 schema 创建时会被 IF NOT EXISTS 跳过，此处仅当旧结构存在时重建。
{
  // 检查旧表是否存在且仍为旧主键结构（没有 account_key 列）
  const detailCols = db.prepare(`PRAGMA table_info(xhs_note_details)`).all() as { name: string }[];
  if (detailCols.length > 0 && !detailCols.some((c) => c.name === 'account_key')) {
    db.exec(`
      CREATE TABLE xhs_note_details_v120_old (
        note_id TEXT PRIMARY KEY,
        fetched_at TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT
      );
      INSERT INTO xhs_note_details_v120_old (note_id, fetched_at, detail_json, source, message)
        SELECT note_id, fetched_at, detail_json, source, message FROM xhs_note_details;
      DROP TABLE xhs_note_details;
      CREATE TABLE xhs_note_details (
        account_key TEXT NOT NULL,
        note_id TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT,
        PRIMARY KEY (account_key, note_id)
      );
      DROP TABLE xhs_note_details_v120_old;
    `);
  }
}

// ===== 旧数据归属账户迁移（事务） =====
// 旧快照与旧笔记详情无 account_key，统一归入 legacy:unscoped-account。
// 仅迁移到尚未归属到任何 account_key 的行，避免重复。绝不删除旧数据。
const LEGACY_ACCOUNT_KEY = 'legacy:unscoped-account';
{
  const snapCols = db.prepare(`PRAGMA table_info(xhs_snapshots)`).all() as { name: string }[];
  const hasAccKey = snapCols.some((c) => c.name === 'account_key');
  if (hasAccKey) {
    const migrate = db.transaction(() => {
      // 快照：account_key 为空的旧行 → legacy
      db.prepare(
        `UPDATE xhs_snapshots SET account_key = ? WHERE account_key = '' OR account_key IS NULL`
      ).run(LEGACY_ACCOUNT_KEY);
    });
    migrate();
  }
  // 笔记详情：account_key 字段新增后旧行会带空字符串（若迁移前曾 ALTER 添加过），
  // 但我们的重建已把 account_key 设为 NOT NULL，旧数据在重建时已丢弃。
  // 若存在 account_key 为空的行（例如 ALTER 路径），归入 legacy。
  const detailCols = db.prepare(`PRAGMA table_info(xhs_note_details)`).all() as { name: string }[];
  if (detailCols.some((c) => c.name === 'account_key')) {
    db.prepare(
      `UPDATE xhs_note_details SET account_key = ? WHERE account_key = '' OR account_key IS NULL`
    ).run(LEGACY_ACCOUNT_KEY);
  }
}

// ===== 索引 =====
{
  const idx = db.prepare(`PRAGMA index_list(xhs_snapshots)`).all() as { name: string }[];
  if (!idx.some((i) => i.name === 'idx_xhs_snapshots_account_synced')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_xhs_snapshots_account_synced ON xhs_snapshots (account_key, synced_at)`);
  }
  const dIdx = db.prepare(`PRAGMA index_list(xhs_note_details)`).all() as { name: string }[];
  if (!dIdx.some((i) => i.name === 'idx_xhs_note_details_account')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_xhs_note_details_account ON xhs_note_details (account_key, note_id)`);
  }
}

// ===== V1.5 热点雷达列迁移（幂等） =====
{
  const haCols = db.prepare(`PRAGMA table_info(hotspot_articles)`).all() as { name: string }[];
  if (!haCols.some((c) => c.name === 'body_error')) {
    db.exec(`ALTER TABLE hotspot_articles ADD COLUMN body_error TEXT`);
  }
  const runCols = db.prepare(`PRAGMA table_info(hotspot_fetch_runs)`).all() as { name: string }[];
  if (!runCols.some((c) => c.name === 'cost')) {
    db.exec(`ALTER TABLE hotspot_fetch_runs ADD COLUMN cost REAL NOT NULL DEFAULT 0`);
  }
  if (!runCols.some((c) => c.name === 'calls_json')) {
    db.exec(`ALTER TABLE hotspot_fetch_runs ADD COLUMN calls_json TEXT NOT NULL DEFAULT '{}'`);
  }
}

// ===== V1.3 热点雷达索引 =====
{
  const hIdx = db.prepare(`PRAGMA index_list(hotspot_articles)`).all() as { name: string }[];
  if (!hIdx.some((i) => i.name === 'idx_hotspot_articles_source_publish')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_hotspot_articles_source_publish ON hotspot_articles (source_id, publish_time DESC)`);
  }
  if (!hIdx.some((i) => i.name === 'idx_hotspot_articles_publish')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_hotspot_articles_publish ON hotspot_articles (publish_time DESC)`);
  }
  if (!hIdx.some((i) => i.name === 'idx_hotspot_articles_read')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_hotspot_articles_read ON hotspot_articles (read_status)`);
  }
  const sIdx = db.prepare(`PRAGMA index_list(hotspot_sources)`).all() as { name: string }[];
  if (!sIdx.some((i) => i.name === 'idx_hotspot_sources_enabled')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_hotspot_sources_enabled ON hotspot_sources (enabled)`);
  }
}

// ===== 账号常量（V1.2 目标账号）=====
export const TARGET_ACCOUNT_KEY = process.env.XHS_ACCOUNT_KEY || '000000000000000000000001';
export const TARGET_ACCOUNT = {
  accountKey: TARGET_ACCOUNT_KEY,
  displayName: process.env.XHS_DISPLAY_NAME || '请配置创作者账号',
  publicUserId: TARGET_ACCOUNT_KEY,
  publicProfileUrl: `https://www.xiaohongshu.com/user/profile/${TARGET_ACCOUNT_KEY}`,
  creatorCenterUrl: 'https://creator.xiaohongshu.com/new/home',
};

// ===== 设置 =====
const DEFAULT_SETTINGS = {
  scanRoot: process.env.WORKBENCH_SCAN_ROOT || `${homedir()}/Desktop`,
  excludedDirs: [
    'node_modules',
    '.git',
    '.DS_Store',
    '.localized',
    'cache',
    'dist',
    'build',
    'out',
    '__pycache__',
    '.venv',
    'venv',
    'Library',
    'tmp',
    'temp',
  ],
  refreshMinutes: 30,
  privacyNotice:
    '本工作台仅在本机运行。桌面扫描仅读取文件路径、名称、类型、大小、修改时间与必要的文本摘要。小红书数据仅通过本机已安装的 OpenCLI 以只读方式同步，结果保存在本地 SQLite。只有在显式开启 AI 分析后，经过脱敏与裁剪的飞书/桌面片段才会发送给 DeepSeek；首次使用 AI 今日规划还会单独确认，仅发送一次性固化的工作画像、今天的脱敏事项标题与固定忙碌时间，不发送原始文件路径、正文或聊天记录。',
  hotspotScheduleTimes: ['13:30', '20:30'],
  hotspotAutoEnabled: false,
  autoScheduleEnabled: false,
  autoCompleteEnabled: false,
  thingsEnabled: false,
  feishuEnabled: false,
  desktopEnabled: false,
  calendarEnabled: false,
  feishuChatAllowlist: [] as string[],
  feishuP2pEnabled: false,
  feishuAllowAll: false,
  timezone: 'Asia/Shanghai',
  workDays: [1, 2, 3, 4, 5],
  workStart: '09:30',
  workEnd: '18:30',
  lunchStart: '12:00',
  lunchEnd: '13:30',
  bufferMinutes: 15,
  minBlockMinutes: 45,
  maxBlockMinutes: 120,
  idleReserveRatio: 0.2,
  aiAnalysisEnabled: false,
  aiPlanningConsent: false,
  aiAutoSyncEnabled: false,
  blockAllDayHolidays: false,
};

export function getSettings(): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

export function publicSettings(): Record<string, unknown> {
  return projectPublicSettings(getSettings(), DEFAULT_SETTINGS);
}

export function updateSettings(patch: Record<string, unknown>): Record<string, unknown> {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(patch)) {
    stmt.run(k, JSON.stringify(v));
  }
  return getSettings();
}

// ===== 扫描报告 =====
export function saveScanReport(report: {
  scanned_at: string;
  root_dir: string;
  file_count: number;
  skipped_count: number;
  clusters: ClusterSummary[];
  files: ScanFile[];
}): number {
  const info = db
    .prepare(
      `INSERT INTO scan_reports (scanned_at, root_dir, file_count, skipped_count, clusters_json, files_json)
       VALUES (@scanned_at, @root_dir, @file_count, @skipped_count, @clusters_json, @files_json)`
    )
    .run({
      scanned_at: report.scanned_at,
      root_dir: report.root_dir,
      file_count: report.file_count,
      skipped_count: report.skipped_count,
      clusters_json: JSON.stringify(report.clusters),
      files_json: JSON.stringify(report.files),
    });
  return Number(info.lastInsertRowid);
}

export function getScanReports(limit = 10): ScanReportRow[] {
  return db
    .prepare('SELECT * FROM scan_reports ORDER BY id DESC LIMIT ?')
    .all(limit) as ScanReportRow[];
}

// ===== 待办 =====
export function insertTodos(items: Omit<TodoRow, 'id'>[]): void {
  const stmt = db.prepare(
    `INSERT INTO todos (title, source_path, cluster, priority, reason, status, created_at, updated_at)
     VALUES (@title, @source_path, @cluster, @priority, @reason, @status, @created_at, @updated_at)`
  );
  const tx = db.transaction((list: Omit<TodoRow, 'id'>[]) => {
    for (const t of list) stmt.run(t);
  });
  tx(items);
}

export function getTodos(): TodoRow[] {
  return db
    .prepare(
      `SELECT * FROM todos ORDER BY
         CASE status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
         CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         id DESC`
    )
    .all() as TodoRow[];
}

export function getTodo(id: number): TodoRow | undefined {
  return db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as TodoRow | undefined;
}

export function updateTodo(id: number, patch: Partial<TodoRow>): TodoRow | undefined {
  const existing = getTodo(id);
  if (!existing) return undefined;
  const merged = { ...existing, ...patch, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE todos SET title=@title, source_path=@source_path, cluster=@cluster, priority=@priority,
     reason=@reason, status=@status, updated_at=@updated_at,
     source_type=@source_type, source_external_id=@source_external_id, source_fingerprint=@source_fingerprint,
     lifecycle_status=@lifecycle_status, due_at=@due_at, estimated_minutes=@estimated_minutes,
     planned_start_at=@planned_start_at, planned_end_at=@planned_end_at,
     calendar_event_id=@calendar_event_id, calendar_sync_status=@calendar_sync_status,
     completion_confidence=@completion_confidence, completed_at=@completed_at,
     completion_source=@completion_source, last_seen_at=@last_seen_at,
     origin_mode=@origin_mode, source_status=@source_status, source_freshness=@source_freshness,
     visibility=@visibility, source_readonly=@source_readonly, user_edited_at=@user_edited_at,
     archived_at=@archived_at, archive_reason=@archive_reason
     WHERE id=@id`
  ).run({
    ...merged,
    origin_mode: merged.origin_mode ?? 'legacy',
    source_status: merged.source_status ?? 'open',
    source_freshness: merged.source_freshness ?? 'unknown',
    visibility: merged.visibility ?? 'visible',
    source_readonly: merged.source_readonly ?? 0,
    user_edited_at: merged.user_edited_at ?? null,
    archived_at: merged.archived_at ?? null,
    archive_reason: merged.archive_reason ?? null,
  });
  return getTodo(id);
}

export function clearPendingTodos(): void {
  // 删除所有"待确认"候选，重新扫描时重建（已确认/已忽略的保留，避免重复出现）
  db.prepare(`DELETE FROM todos WHERE status = 'pending'`).run();
}

// 删除重复候选：同一 source_path + 标题 + 待确认状态
export function dedupePendingTodos(): void {
  db.prepare(
    `DELETE FROM todos WHERE status='pending' AND id NOT IN (
       SELECT MIN(id) FROM todos WHERE status='pending' GROUP BY source_path, title
     )`
  ).run();
}

// ===== 小红书快照 =====
export function saveXhsSnapshot(snap: {
  account_key: string;
  synced_at: string;
  profile_json: string | null;
  metrics: CreatorMetric[];
  notes: NotePerformance[];
  periods: Record<string, { period: string; metrics: CreatorMetric[] }>;
  source: string;
  message?: string | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO xhs_snapshots (account_key, synced_at, profile_json, metrics_json, notes_json, source, message, periods_json)
       VALUES (@account_key, @synced_at, @profile_json, @metrics_json, @notes_json, @source, @message, @periods_json)`
    )
    .run({
      account_key: snap.account_key,
      synced_at: snap.synced_at,
      profile_json: snap.profile_json,
      metrics_json: JSON.stringify(snap.metrics),
      notes_json: JSON.stringify(snap.notes),
      source: snap.source,
      message: snap.message ?? null,
      periods_json: JSON.stringify(snap.periods),
    });
  // 更新账号 last_sync_at
  try {
    db.prepare(`UPDATE xhs_accounts SET last_sync_at = @synced_at WHERE account_key = @account_key AND (@synced_at IS NULL OR last_sync_at IS NULL OR last_sync_at < @synced_at)`)
      .run({ synced_at: snap.synced_at, account_key: snap.account_key });
  } catch {
    // 账号行可能尚未插入（首次同步），忽略
  }
  return Number(info.lastInsertRowid);
}

export function getLatestXhsSnapshot(accountKey: string): XhsSnapshotRow | undefined {
  return db
    .prepare('SELECT * FROM xhs_snapshots WHERE account_key = ? ORDER BY id DESC LIMIT 1')
    .get(accountKey) as XhsSnapshotRow | undefined;
}

export function getLatestXhsSnapshotAny(): XhsSnapshotRow | undefined {
  return db
    .prepare('SELECT * FROM xhs_snapshots ORDER BY id DESC LIMIT 1')
    .get() as XhsSnapshotRow | undefined;
}

// 兼容迁移：旧快照只有单组 metrics 时，视为 seven
export function resolveSnapshotPeriods(row: XhsSnapshotRow): {
  synced_at: string;
  source: string;
  profile_json: string | null;
  notes_json: string;
  message: string | null;
  periods: Record<string, { period: string; metrics: CreatorMetric[] }>;
} {
  const profile_json = row.profile_json;
  const notes_json = row.notes_json;
  const message = row.message;

  if (row.periods_json && row.periods_json.trim()) {
    try {
      const parsed = JSON.parse(row.periods_json);
      return { synced_at: row.synced_at, source: row.source, profile_json, notes_json, message, periods: parsed };
    } catch {
      // fallthrough to legacy
    }
  }

  // 旧快照：单组 metrics_json 视为 seven
  const legacyMetrics: CreatorMetric[] = JSON.parse(row.metrics_json || '[]');
  return {
    synced_at: row.synced_at,
    source: row.source,
    profile_json,
    notes_json,
    message,
    periods: {
      seven: { period: 'seven', metrics: legacyMetrics },
    },
  };
}

// ===== 单篇笔记详情缓存 =====
export interface NoteDetailRow {
  account_key: string;
  note_id: string;
  fetched_at: string;
  detail_json: string;
  source: string;
  message: string | null;
}

export function saveNoteDetail(detail: {
  account_key: string;
  note_id: string;
  fetched_at: string;
  detail_json: string;
  source: string;
  message?: string | null;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO xhs_note_details (account_key, note_id, fetched_at, detail_json, source, message)
     VALUES (@account_key, @note_id, @fetched_at, @detail_json, @source, @message)`
  ).run({
    account_key: detail.account_key,
    note_id: detail.note_id,
    fetched_at: detail.fetched_at,
    detail_json: detail.detail_json,
    source: detail.source,
    message: detail.message ?? null,
  });
}

export function getNoteDetail(accountKey: string, noteId: string): NoteDetailRow | undefined {
  return db
    .prepare('SELECT * FROM xhs_note_details WHERE account_key = ? AND note_id = ?')
    .get(accountKey, noteId) as NoteDetailRow | undefined;
}

export function isNoteDetailFresh(fetchedAt: string, ttlMs = 12 * 60 * 60 * 1000): boolean {
  return Date.now() - new Date(fetchedAt).getTime() < ttlMs;
}

// ===== 账号信息（V1.2）=====
export interface AccountRow {
  account_key: string;
  display_name: string;
  public_profile_url: string | null;
  creator_center_url: string | null;
  verification_status: string;
  verified_at: string | null;
  last_sync_at: string | null;
  is_active: number;
}

export function upsertAccount(a: {
  account_key: string;
  display_name: string;
  public_profile_url?: string | null;
  creator_center_url?: string | null;
  verification_status?: string;
  verified_at?: string | null;
  is_active?: number;
}): void {
  db.prepare(
    `INSERT INTO xhs_accounts (account_key, display_name, public_profile_url, creator_center_url, verification_status, verified_at, last_sync_at, is_active)
     VALUES (@account_key, @display_name, @public_profile_url, @creator_center_url, @verification_status, @verified_at, NULL, @is_active)
     ON CONFLICT(account_key) DO UPDATE SET
       display_name=excluded.display_name,
       public_profile_url=excluded.public_profile_url,
       creator_center_url=excluded.creator_center_url,
       verification_status=excluded.verification_status,
       verified_at=excluded.verified_at,
       is_active=excluded.is_active`
  ).run({
    account_key: a.account_key,
    display_name: a.display_name,
    public_profile_url: a.public_profile_url ?? null,
    creator_center_url: a.creator_center_url ?? null,
    verification_status: a.verification_status ?? 'unknown',
    verified_at: a.verified_at ?? null,
    is_active: a.is_active ?? 0,
  });
}

export function getAccount(accountKey: string): AccountRow | undefined {
  return db
    .prepare('SELECT * FROM xhs_accounts WHERE account_key = ?')
    .get(accountKey) as AccountRow | undefined;
}

export function setAccountActive(accountKey: string): void {
  db.prepare('UPDATE xhs_accounts SET is_active = 1 WHERE account_key = ?').run(accountKey);
  db.prepare('UPDATE xhs_accounts SET is_active = 0 WHERE account_key != ?').run(accountKey);
}

export function noteIdBelongsToAccount(accountKey: string, noteId: string): boolean {
  // 校验 note_id 是否属于当前账号的笔记集合（从最新快照的 notes_json 中查）
  const snap = getLatestXhsSnapshot(accountKey);
  if (!snap) return false;
  try {
    const notes = JSON.parse(snap.notes_json || '[]') as { id: string }[];
    return notes.some((n) => n.id === noteId);
  } catch {
    return false;
  }
}

// ===== V1.3 热点雷达数据层 =====

// 默认热点来源（次幂数据支持 nickname 查询；biz 可在抓取后回填）
export const DEFAULT_HOTSPOT_SOURCES = [
  { source_key: 'wechat:huxiu', display_name: '虎嗅APP', nickname: '虎嗅APP' },
  { source_key: 'wechat:36kr', display_name: '36氪', nickname: '36氪' },
] as const;

export interface HotspotSourceRow {
  id: number;
  source_key: string;
  display_name: string;
  account_biz: string;
  account_wxid: string;
  avatar_url: string | null;
  signature: string | null;
  fans: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_fetch_at: string | null;
  last_article_count: number;
  nickname?: string; // 内存态：抓取用 nickname
}

export interface HotspotArticleRow {
  id: number;
  source_id: number;
  external_key: string;
  title: string;
  url: string;
  digest: string | null;
  author: string | null;
  publish_time: string | null;
  fetched_at: string;
  body_text: string | null;
  body_ready: number;
  body_too_short: number;
  body_pending: number;
  body_hash: string | null;
  body_error: string | null;
  read_status: string;
  todo_status: string;
  created_at: string;
  updated_at: string;
}

export interface HotspotFetchRunRow {
  id: number;
  source_id: number | null;
  triggered_by: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  article_found: number;
  inserted: number;
  updated: number;
  duplicate: number;
  body_fetched: number;
  error_message: string | null;
  cost: number;
  calls_json: string;
}

// 确保默认来源存在（幂等 upsert，不覆盖已有的 source_key）
export function ensureHotspotSources(): void {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO hotspot_sources (source_key, display_name, account_biz, account_wxid, enabled, created_at, updated_at)
     VALUES (@source_key, @display_name, '', '', 1, @now, @now)
     ON CONFLICT(source_key) DO NOTHING`
  );
  const tx = db.transaction((list) => {
    for (const s of list) upsert.run({ source_key: s.source_key, display_name: s.display_name, now });
  });
  tx(DEFAULT_HOTSPOT_SOURCES);
}

export function getAllHotspotSources(): HotspotSourceRow[] {
  return db.prepare('SELECT * FROM hotspot_sources ORDER BY id ASC').all() as HotspotSourceRow[];
}

export function getHotspotSource(id: number): HotspotSourceRow | undefined {
  return db.prepare('SELECT * FROM hotspot_sources WHERE id = ?').get(id) as HotspotSourceRow | undefined;
}

export function getHotspotSourceByKey(key: string): HotspotSourceRow | undefined {
  return db.prepare('SELECT * FROM hotspot_sources WHERE source_key = ?').get(key) as HotspotSourceRow | undefined;
}

// 回填公众号信息（biz / wxid / 头像 / 简介 / 粉丝）
export function updateHotspotSourceInfo(id: number, info: { biz?: string; wxid?: string; avatar?: string; signature?: string; fans?: number }): void {
  const now = new Date().toISOString();
  const existing = getHotspotSource(id);
  if (!existing) return;
  db.prepare(
    `UPDATE hotspot_sources SET
       account_biz = COALESCE(@biz, account_biz),
       account_wxid = COALESCE(@wxid, account_wxid),
       avatar_url = COALESCE(@avatar, avatar_url),
       signature = COALESCE(@signature, signature),
       fans = COALESCE(@fans, fans),
       updated_at = @now
     WHERE id = @id`
  ).run({
    id,
    biz: info.biz ?? existing.account_biz,
    wxid: info.wxid ?? existing.account_wxid,
    avatar: info.avatar ?? existing.avatar_url,
    signature: info.signature ?? existing.signature,
    fans: info.fans ?? existing.fans,
    now,
  });
}

export function setHotspotDisabled(id: number, disabled: boolean): void {
  db.prepare('UPDATE hotspot_sources SET enabled = @enabled, updated_at = @now WHERE id = @id').run({
    id,
    enabled: disabled ? 0 : 1,
    now: new Date().toISOString(),
  });
}

// 标记来源本次抓取时间与文章数
export function markHotspotFetch(id: number, count: number): void {
  db.prepare(
    'UPDATE hotspot_sources SET last_fetch_at = @now, last_article_count = @count, updated_at = @now WHERE id = @id'
  ).run({ id, count, now: new Date().toISOString() });
}

// 按 external_key 查找（去重核心）
export function findHotspotArticleByKey(externalKey: string): HotspotArticleRow | undefined {
  return db.prepare('SELECT * FROM hotspot_articles WHERE external_key = ?').get(externalKey) as HotspotArticleRow | undefined;
}

export function getHotspotArticle(id: number): HotspotArticleRow | undefined {
  return db.prepare('SELECT * FROM hotspot_articles WHERE id = ?').get(id) as HotspotArticleRow | undefined;
}

export interface UpsertArticleResult {
  status: 'inserted' | 'duplicate';
  id: number;
  changed: boolean;
  /** duplicate 时暴露现有文章正文是否未就绪（供调用方补抓正文） */
  bodyPending?: boolean;
}

// 插入或识别已知文章；返回三态（inserted / duplicate）
// 注意：正文不在此处抓取（正文由调用方单独 fetch 并更新 body_* 字段）。
export function upsertHotspotArticle(a: {
  source_id: number;
  external_key: string;
  title: string;
  url: string;
  digest?: string | null;
  author?: string | null;
  publish_time?: string | null;
}): UpsertArticleResult {
  const now = new Date().toISOString();
  const existing = findHotspotArticleByKey(a.external_key);
  if (existing) {
    // 更新非正文元数据（标题/链接可能微变），正文与状态不动
    db.prepare(
      `UPDATE hotspot_articles SET
         title = @title, url = @url, digest = COALESCE(@digest, digest),
         author = COALESCE(@author, author), publish_time = COALESCE(@publish_time, publish_time),
         updated_at = @now
       WHERE id = @id`
    ).run({
      id: existing.id,
      title: a.title,
      url: a.url,
      digest: a.digest ?? null,
      author: a.author ?? null,
      publish_time: a.publish_time ?? null,
      now,
    });
    return { status: 'duplicate', id: existing.id, changed: false, bodyPending: existing.body_pending === 1 };
  }
  const info = db
    .prepare(
      `INSERT INTO hotspot_articles
         (source_id, external_key, title, url, digest, author, publish_time, fetched_at, body_ready, body_too_short, body_pending, read_status, todo_status, created_at, updated_at)
       VALUES
         (@source_id, @external_key, @title, @url, @digest, @author, @publish_time, @fetched_at, 0, 0, 1, 'unread', 'none', @now, @now)`
    )
    .run({
      source_id: a.source_id,
      external_key: a.external_key,
      title: a.title,
      url: a.url,
      digest: a.digest ?? null,
      author: a.author ?? null,
      publish_time: a.publish_time ?? null,
      fetched_at: now,
      now,
    });
  return { status: 'inserted', id: Number(info.lastInsertRowid), changed: true };
}

// 更新正文（body_hash 记录正文指纹；正文不变则不重复调用）
export function updateHotspotArticleBody(id: number, body: { body_text: string; body_hash: string; too_short: boolean }): void {
  db.prepare(
    `UPDATE hotspot_articles SET
       body_text = @body_text, body_hash = @body_hash,
       body_ready = @body_ready, body_too_short = @too_short, body_pending = 0,
       body_error = NULL,
       updated_at = @now
     WHERE id = @id`
  ).run({
    id,
    body_text: body.body_text,
    body_hash: body.body_hash,
    body_ready: body.too_short ? 0 : 1,
    too_short: body.too_short ? 1 : 0,
    now: new Date().toISOString(),
  });
}

// 正文抓取失败 → 标记 pending，持久化失败原因，可重试
export function markArticleBodyPending(id: number, message: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE hotspot_articles SET body_pending = 1, body_ready = 0, body_error = @message, updated_at = @now WHERE id = @id`
  ).run({ id, message: message || '未知错误', now });
}

// 更新文章阅读/待办状态
export function updateHotspotArticleStatus(id: number, patch: { read_status?: string; todo_status?: string }): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE hotspot_articles SET
       read_status = COALESCE(@read_status, read_status),
       todo_status = COALESCE(@todo_status, todo_status),
       updated_at = @now
     WHERE id = @id`
  ).run({ id, read_status: patch.read_status ?? null, todo_status: patch.todo_status ?? null, now });
}


// 热点文章加入待办（同一事务：更新文章 todo_status + 写入 todos）
// 去重键基于文章 URL 或文章 ID（source_path 存 URL；cluster 带文章 ID），不只看标题。
export function addHotspotArticleToTodo(id: number): { status: 'added' | 'already' | 'not_found'; todoId?: number } {
  const tx = db.transaction((): { status: 'added' | 'already' | 'not_found'; todoId?: number } => {
    const article = getHotspotArticle(id);
    if (!article) return { status: 'not_found' };
    if (article.todo_status === 'added') return { status: 'already' };

    const now = new Date().toISOString();
    db.prepare(`UPDATE hotspot_articles SET todo_status = 'added', updated_at = @now WHERE id = @id`).run({ id, now });

    // 去重键：URL 优先；cluster 中保留文章 ID，便于追踪与二次去重
    const cluster = `热点雷达·文章#${id}`;
    const existing = db.prepare(
      `SELECT id FROM todos WHERE source_path = @url OR (title = @title AND cluster = @cluster) LIMIT 1`
    ).get({ url: article.url, title: article.title, cluster }) as { id: number } | undefined;
    if (existing) return { status: 'added', todoId: existing.id };

    const info = db.prepare(
      `INSERT INTO todos (title, source_path, cluster, priority, reason, status, created_at, updated_at,
         source_type, source_external_id, source_fingerprint, lifecycle_status, last_seen_at)
       VALUES (@title, @source_path, @cluster, @priority, @reason, @status, @created_at, @updated_at,
         'hotspot', @source_path, @source_fingerprint, 'candidate', @created_at)`
    ).run({
      title: article.title,
      source_path: article.url,
      cluster,
      priority: 'medium',
      reason: `来自热点雷达：${article.title}`,
      status: 'pending',
      created_at: now,
      updated_at: now,
      source_fingerprint: fingerprintSource('hotspot', article.url, article.title),
    });
    return { status: 'added', todoId: Number(info.lastInsertRowid) };
  });
  return tx();
}
// ===== Hotspot 抓取运行记录 =====
export function createFetchRun(sourceId: number | null, triggeredBy: string): number {
  const row = db
    .prepare('INSERT INTO hotspot_fetch_runs (source_id, triggered_by, started_at, status) VALUES (@sid, @tb, @now, \'running\')')
    .run({ sid: sourceId, tb: triggeredBy, now: new Date().toISOString() });
  return Number(row.lastInsertRowid);
}

export function finishFetchRun(id: number, stats: { article_found: number; inserted: number; updated: number; duplicate: number; body_fetched: number; status: string; error_message?: string | null; cost?: number; calls?: Record<string, number> }): void {
  db.prepare(
    `UPDATE hotspot_fetch_runs SET
       finished_at = @now, status = @status, article_found = @article_found,
       inserted = @inserted, updated = @updated, duplicate = @duplicate,
       body_fetched = @body_fetched, error_message = @error_message,
       cost = @cost, calls_json = @calls_json
     WHERE id = @id`
  ).run({
    id,
    now: new Date().toISOString(),
    status: stats.status,
    article_found: stats.article_found,
    inserted: stats.inserted,
    updated: stats.updated,
    duplicate: stats.duplicate,
    body_fetched: stats.body_fetched,
    error_message: stats.error_message ?? null,
    cost: stats.cost ?? 0,
    calls_json: JSON.stringify(stats.calls ?? {}),
  });
}

/** 累计成本（来自持久化抓取运行记录，服务重启后不归零） */
export function getHotspotCostTotal(): number {
  const row = db.prepare('SELECT COALESCE(SUM(cost), 0) AS total FROM hotspot_fetch_runs').get() as { total: number };
  return row.total;
}

/**
 * 累计接口调用次数（来自持久化抓取运行记录）。
 * 不再使用进程内 callStats，避免服务重启后出现“调用 0 次但成本非 0”的矛盾展示。
 */
export function getHotspotCallTotals(): {
  token: number;
  account_info: number;
  current: number;
  body: number;
  long2short: number;
  estimatedCost: number;
} {
  const totals = { token: 0, account_info: 0, current: 0, body: 0, long2short: 0 };
  const rows = db.prepare('SELECT calls_json FROM hotspot_fetch_runs').all() as Array<{ calls_json: string }>;
  for (const row of rows) {
    try {
      const calls = JSON.parse(row.calls_json || '{}') as Record<string, unknown>;
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
        const value = Number(calls[key]);
        if (Number.isFinite(value) && value > 0) totals[key] += value;
      }
    } catch {
      // 兼容旧记录或损坏的 calls_json；成本仍由 cost 列独立累计。
    }
  }
  return { ...totals, estimatedCost: getHotspotCostTotal() };
}

/** 按触发前缀统计抓取运行数量（调度防重，基于持久化记录） */
export function countFetchRunsByTriggerPrefix(prefix: string): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM hotspot_fetch_runs WHERE triggered_by LIKE ?').get(`${prefix}%`) as { c: number };
  return row.c;
}

export function getRecentFetchRuns(limit = 20): HotspotFetchRunRow[] {
  return db.prepare('SELECT * FROM hotspot_fetch_runs ORDER BY id DESC LIMIT ?').all(limit) as HotspotFetchRunRow[];
}

// ===== 列表查询（分页 + 筛选）=====
export interface HotspotListQuery {
  page?: number;
  pageSize?: number;
  sourceKey?: string;
  dateFrom?: string;
  dateTo?: string;
  keyword?: string;
  readStatus?: string;
}

export interface HotspotListResult {
  items: HotspotArticleRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function listHotspotArticles(q: HotspotListQuery = {}): HotspotListResult {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
  const conds: string[] = [];
  const params: Record<string, string | number> = {};

  if (q.sourceKey) {
    conds.push('s.source_key = @sourceKey');
    params.sourceKey = q.sourceKey;
  }
  if (q.dateFrom) {
    conds.push('date(a.publish_time) >= date(@dateFrom)');
    params.dateFrom = q.dateFrom;
  }
  if (q.dateTo) {
    conds.push('date(a.publish_time) <= date(@dateTo)');
    params.dateTo = q.dateTo;
  }
  if (q.keyword) {
    conds.push('(a.title LIKE @kw OR a.digest LIKE @kw OR a.body_text LIKE @kw)');
    params.kw = `%${q.keyword}%`;
  }
  if (q.readStatus) {
    conds.push('a.read_status = @readStatus');
    params.readStatus = q.readStatus;
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const total = (db.prepare(`SELECT COUNT(*) AS c FROM hotspot_articles a JOIN hotspot_sources s ON a.source_id = s.id ${where}`).get(params) as { c: number }).c;
  const offset = (page - 1) * pageSize;
  const items = db
    .prepare(
      `SELECT a.*, s.source_key, s.display_name
       FROM hotspot_articles a JOIN hotspot_sources s ON a.source_id = s.id
       ${where}
       ORDER BY a.publish_time DESC, a.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset }) as HotspotArticleRow[];

  return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** 上海时区今日 YYYY-MM-DD（不用 UTC 日期截断） */
export function shanghaiDateString(d = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// ===== 状态汇总（4 指标 + 成本）=====
export function getHotspotStatus(): {
  todayCount: number;
  totalCount: number;
  unreadCount: number;
  pendingBodyCount: number;
  estimatedCost: number;
  lastFetchAt: string | null;
  sources: HotspotSourceRow[];
} {
  const todayStr = shanghaiDateString();
  const todayCount = (db.prepare(`SELECT COUNT(*) AS c FROM hotspot_articles WHERE date(publish_time) = @today`).get({ today: todayStr }) as { c: number }).c;
  const totalCount = (db.prepare('SELECT COUNT(*) AS c FROM hotspot_articles').get() as { c: number }).c;
  const unreadCount = (db.prepare(`SELECT COUNT(*) AS c FROM hotspot_articles WHERE read_status = 'unread'`).get() as { c: number }).c;
  const pendingBodyCount = (db.prepare(`SELECT COUNT(*) AS c FROM hotspot_articles WHERE body_pending = 1`).get() as { c: number }).c;
  const lastFetchRow = db.prepare('SELECT MAX(started_at) AS last FROM hotspot_fetch_runs').get() as { last: string | null };
  return {
    todayCount,
    totalCount,
    unreadCount,
    pendingBodyCount,
    estimatedCost: getHotspotCostTotal(),
    lastFetchAt: lastFetchRow.last,
    sources: getAllHotspotSources(),
  };
}


// 类型
export interface ScanReportRow {
  id: number;
  scanned_at: string;
  root_dir: string;
  file_count: number;
  skipped_count: number;
  clusters_json: string;
  files_json: string;
}

export interface TodoRow {
  id: number;
  title: string;
  source_path: string;
  cluster: string;
  priority: string;
  reason: string;
  status: string;
  created_at: string;
  updated_at: string;
  source_type?: string;
  source_external_id?: string | null;
  source_fingerprint?: string | null;
  lifecycle_status?: string;
  due_at?: string | null;
  estimated_minutes?: number | null;
  planned_start_at?: string | null;
  planned_end_at?: string | null;
  calendar_event_id?: string | null;
  calendar_sync_status?: string | null;
  completion_confidence?: number | null;
  completed_at?: string | null;
  completion_source?: string | null;
  last_seen_at?: string | null;
  origin_mode?: string;
  source_status?: string;
  source_freshness?: string;
  consecutive_missing_count?: number;
  last_full_seen_at?: string | null;
  inference_confidence?: number | null;
  inference_reason_code?: string | null;
  ai_analysis_id?: number | null;
  action_identity?: string | null;
  action_owner?: string | null;
  source_readonly?: number;
  user_edited_at?: string | null;
  visibility?: string;
  archived_at?: string | null;
  archive_reason?: string | null;
  source_scope?: string | null;
  source_occurred_at?: string | null;
}

export interface XhsSnapshotRow {
  id: number;
  account_key: string;
  synced_at: string;
  profile_json: string | null;
  metrics_json: string;
  notes_json: string;
  source: string;
  message: string | null;
  periods_json: string | null;
}

// ===== 初始化：确保默认热点来源存在 =====
ensureHotspotSources();
ensureKnowledgeHotspotDraftSchema(db);
migrateProductivityV2(db);
ensureProductivityV3(db, {
  skipBackup: Boolean(process.env.VITEST || process.env.NODE_ENV === 'test'),
  backupPath: process.env.VITEST || process.env.NODE_ENV === 'test' ? undefined : DB_PATH + '.v3-pre.bak',
});
ensureProductivityV31(db, {
  skipBackup: Boolean(process.env.VITEST || process.env.NODE_ENV === 'test'),
  dbPath: DB_PATH,
});
ensureProductivityV4(db);
export const productivity = createProductivityRepos(db);
export const knowledgeHotspotDrafts = createKnowledgeHotspotDraftRepository(db);

export default db;
