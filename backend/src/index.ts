import './bootstrapEnv';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getSettings,
  publicSettings,
  updateSettings,
  saveScanReport,
  getScanReports,
  getTodos,
  updateTodo,
  productivity,
  saveXhsSnapshot,
  getLatestXhsSnapshot,
  getLatestXhsSnapshotAny,
  resolveSnapshotPeriods,
  saveNoteDetail,
  getNoteDetail,
  isNoteDetailFresh,
  upsertAccount,
  getAccount,
  setAccountActive,
  noteIdBelongsToAccount,
  TARGET_ACCOUNT_KEY,
  TARGET_ACCOUNT,
  getTodo,
  knowledgeHotspotDrafts,
} from './db';
import type { XhsSnapshotRow, NoteDetailRow, AccountRow } from './db';
import { scanDesktop } from './scanner';
import { registerProductivityRoutes } from './productivityRoutes';
import { registerFinanceRoutes } from './financeRoutes';
import { mapTodoRow, commitDesktopScan } from './services/productivitySync';
import { queryTodayTodos } from './services/todayTodos';
import { publicScanFiles } from './services/publicDto';
import { dispatchTodoAction, rowToTransitionState } from './services/todoTransitions';
import { ProductivityError, PRODUCTIVITY_ERROR_CODES } from './connectors/errors';
import { startProductivityScheduler } from './productivityScheduler';
import { createWeatherClient } from './services/weatherService';
import { createLocationLabelResolver } from './services/locationLabelService';
import {
  fetchLiveXhs,
  fetchNoteDetail,
  isValidNoteId,
  verifyAccountIdentity,
  fetchWhoami,
  fetchPublicUserNotes,
  OpencliError,
} from './opencli';
import { demoProfile, demoMetrics, demoNotes } from './demo';
import type { ScanReport, CreatorNoteDetail } from './types';
import {
  runHotspotSync,
  isSyncing,
} from './hotspotSync';
import {
  getAllHotspotSources,
  getHotspotSource,
  getHotspotArticle,
  listHotspotArticles,
  updateHotspotArticleStatus,
  getHotspotStatus,
  getRecentFetchRuns,
  updateHotspotSourceInfo,
  setHotspotDisabled,
  upsertHotspotArticle,
  addHotspotArticleToTodo,
  getHotspotCallTotals,
} from './db';
import type { HotspotArticleRow } from './db';
import { getCimiMeta, hasCimiCredentials, CimiError } from './cimidata';
import { startScheduler, isBackendRuntime } from './scheduler';
import { workbenchRuntimeStamp } from './services/runtimeStamp';
import multer from 'multer';
import type { Request } from 'express';
import {
  getKnowledgeStatus,
  getKnowledgeDocuments,
  chatKnowledge,
  uploadKnowledge,
  deleteKnowledgeDocument,
  getKnowledgeHotspotStatus,
  getKnowledgeHotspotArticles,
  refreshKnowledgeHotspots,
  generateKnowledgeHotspotWithSource,
  isKnowledgeConfigured,
  KnowledgeServiceError,
  invalidateKnowledgeCache,
} from './knowledgeClient';
import {
  KnowledgeHotspotDraftError,
  normalizeKnowledgeHotspotDraftListQuery,
  normalizeKnowledgeHotspotGenerationMode,
  normalizeKnowledgeHotspotRequestId,
} from './knowledgeHotspotDrafts';
import { corsOriginDelegate, BIND_HOST } from './http/localCors';
import { assertSettingsPatch, SettingsPolicyError } from './config/settingsPolicy';

const app = express();
app.use(cors({ origin: corsOriginDelegate }));
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3456);

// ===== 知识库上传（multer，仅接受 .md，≤10MB，内存存储不留临时文件）=====
const KB_MAX_UPLOAD = 10 * 1024 * 1024; // 10MB
const kbUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: KB_MAX_UPLOAD },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (!name.endsWith('.md')) {
      return cb(new Error('目前仅支持 .md Markdown 文件'));
    }
    cb(null, true);
  },
});

// ===== 健康检查 =====
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), ...workbenchRuntimeStamp() });
});

// ===== 设置 =====
app.get('/api/settings', (_req, res) => {
  res.json(publicSettings());
});

app.patch('/api/settings', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const patch = assertSettingsPatch(body);
    if (patch.aiAnalysisEnabled === true && getSettings().aiAnalysisEnabled !== true) {
      if (body.confirmAiUpload !== true) {
        return res.status(400).json({
          code: 'SETTINGS_REJECTED',
          message: '首次开启 AI 分析需要 confirmAiUpload=true。仅飞书/桌面脱敏片段会发送给 DeepSeek，Things 与 Calendar 不会上传。',
        });
      }
    }
    if (patch.aiPlanningConsent === true && getSettings().aiPlanningConsent !== true) {
      if (body.confirmAiPlanningUpload !== true) {
        return res.status(400).json({
          code: 'SETTINGS_REJECTED',
          message: '首次使用 AI 今日规划需要确认：只上传固化工作画像、今天的脱敏事项标题与固定忙碌时间，不上传原始文件路径、正文或聊天记录。',
        });
      }
      if (patch.aiAnalysisEnabled !== true && getSettings().aiAnalysisEnabled !== true) {
        return res.status(400).json({
          code: 'SETTINGS_REJECTED',
          message: '使用 AI 今日规划前需要开启 AI 分析。',
        });
      }
    }
    updateSettings(patch);
    res.json(publicSettings());
  } catch (e) {
    if (e instanceof SettingsPolicyError) {
      return res.status(400).json({ code: e.code, message: e.message });
    }
    throw e;
  }
});

// ===== 桌面扫描 =====
app.post('/api/scan/run', async (_req, res) => {
  try {
    const result = scanDesktop();
    const publicFiles = publicScanFiles(result.files);
    const id = saveScanReport({
      scanned_at: result.scannedAt,
      root_dir: 'configured_root',
      file_count: result.fileCount,
      skipped_count: result.skippedCount,
      clusters: result.clusters,
      files: publicFiles as unknown as typeof result.files,
    });
    await commitDesktopScan({}, result.entries);
    res.json({
      id,
      scannedAt: result.scannedAt,
      rootDir: 'configured_root',
      fileCount: result.fileCount,
      skippedCount: result.skippedCount,
      blockedCount: result.blockedCount,
      blockedReasonCounts: result.blockedReasonCounts,
      clusters: result.clusters,
      files: publicFiles,
    });
  } catch {
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '扫描失败' });
  }
});

app.get('/api/scan/reports', (_req, res) => {
  const rows = getScanReports(10);
  res.json(
    rows.map((r) => ({
      id: r.id,
      scannedAt: r.scanned_at,
      rootDir: r.root_dir,
      fileCount: r.file_count,
      skippedCount: r.skipped_count,
      clusters: JSON.parse(r.clusters_json),
      files: JSON.parse(r.files_json),
    }))
  );
});

// ===== 待办 =====
app.get('/api/todos/today', (req, res) => {
  const raw = req.query.limit;
  const parsed = raw == null || raw === '' ? undefined : Number(raw);
  const limit = parsed != null && Number.isFinite(parsed) && parsed > 0 ? Math.min(500, Math.floor(parsed)) : undefined;
  res.json(queryTodayTodos({ limit }));
});

app.get('/api/todos', (_req, res) => {
  const rows = getTodos();
  const counts = productivity.getEvidenceCounts(rows.map((r) => r.id));
  res.json(rows.map((r) => ({ ...mapTodoRow(r), evidenceCount: counts.get(r.id) ?? 0 })));
});

app.post('/api/todos/:id/confirm', (req, res) => {
  try {
    const existing = getTodo(Number(req.params.id));
    if (!existing) return res.status(404).json({ code: 'NOT_FOUND', message: '待办不存在' });
    const next = dispatchTodoAction(rowToTransitionState(existing as unknown as Record<string, unknown>), 'confirm');
    const t = updateTodo(existing.id, next);
    res.json(mapTodoRow(t || existing));
  } catch (e) {
    if (e instanceof ProductivityError) return res.status(e.httpStatus).json({ code: e.code, message: e.message });
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '操作失败' });
  }
});

app.post('/api/todos/:id/ignore', (req, res) => {
  try {
    const existing = getTodo(Number(req.params.id));
    if (!existing) return res.status(404).json({ code: 'NOT_FOUND', message: '待办不存在' });
    const next = dispatchTodoAction(rowToTransitionState(existing as unknown as Record<string, unknown>), 'ignore');
    const t = updateTodo(existing.id, next);
    res.json(mapTodoRow(t || existing));
  } catch (e) {
    if (e instanceof ProductivityError) return res.status(e.httpStatus).json({ code: e.code, message: e.message });
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '操作失败' });
  }
});

app.patch('/api/todos/:id', (req, res) => {
  try {
    const existing = getTodo(Number(req.params.id));
    if (!existing) return res.status(404).json({ code: 'NOT_FOUND', message: '待办不存在' });
    const { title, estimatedMinutes, dueAt, visibility } = req.body;
    if (visibility === 'hidden_local' || visibility === 'visible') {
      const next = dispatchTodoAction(rowToTransitionState(existing as unknown as Record<string, unknown>), visibility === 'hidden_local' ? 'hide' : 'unhide');
      const t = updateTodo(existing.id, next);
      return res.json(mapTodoRow(t || existing));
    }
    const next = dispatchTodoAction(rowToTransitionState(existing as unknown as Record<string, unknown>), 'edit', {
      title,
      estimated_minutes: estimatedMinutes !== undefined ? Number(estimatedMinutes) : undefined,
      due_at: dueAt === undefined ? undefined : dueAt,
    });
    const t = updateTodo(existing.id, next);
    res.json(mapTodoRow(t || existing));
  } catch (e) {
    if (e instanceof ProductivityError) return res.status(e.httpStatus).json({ code: e.code, message: e.message });
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '操作失败' });
  }
});

// ===== 小红书账号（V1.2）=====
const isDemoMode = () => process.env.WORKBENCH_DEMO_MODE === 'true';

// 校验 period 参数，默认 seven
function parsePeriod(q: string | undefined): 'seven' | 'thirty' {
  return q === 'thirty' ? 'thirty' : 'seven';
}

// 从快照行组装完整快照（含 periods + 兼容迁移 + account 信息）
function rowToSnapshot(row: XhsSnapshotRow) {
  const resolved = resolveSnapshotPeriods(row);
  const account = getAccount(TARGET_ACCOUNT_KEY);
  return {
    id: row.id,
    accountKey: row.account_key,
    syncedAt: row.synced_at,
    profile: resolved.profile_json ? JSON.parse(resolved.profile_json) : null,
    notes: JSON.parse(resolved.notes_json || '[]'),
    periods: resolved.periods,
    source: resolved.source,
    message: resolved.message,
    account: accountInfoPayload(account),
  };
}

// 组装 account 信息块
function accountInfoPayload(account: AccountRow | undefined) {
  return {
    accountKey: TARGET_ACCOUNT_KEY,
    displayName: account?.display_name ?? TARGET_ACCOUNT.displayName,
    publicProfileUrl: account?.public_profile_url ?? TARGET_ACCOUNT.publicProfileUrl,
    creatorCenterUrl: TARGET_ACCOUNT.creatorCenterUrl,
    verificationStatus: account?.verification_status ?? 'unknown',
    verifiedAt: account?.verified_at ?? null,
    lastSyncAt: account?.last_sync_at ?? null,
  };
}

// 当前账号的预期信息
function expectedAccountPayload() {
  return {
    displayName: TARGET_ACCOUNT.displayName,
    publicUserId: TARGET_ACCOUNT.publicUserId,
    publicProfileUrl: TARGET_ACCOUNT.publicProfileUrl,
    creatorCenterUrl: TARGET_ACCOUNT.creatorCenterUrl,
  };
}

// GET /api/xhs/account
// 返回当前绑定账号信息 + OpenCLI 实时登录态
app.get('/api/xhs/account', async (_req, res) => {
  const account = getAccount(TARGET_ACCOUNT_KEY) as AccountRow | undefined;
  const base = accountInfoPayload(account);

  // 实时探测 OpenCLI 当前登录态
  let verificationStatus = account?.verification_status ?? 'unknown';
  let loginDisplayName: string | null = null;
  let followers: number | null = null;
  let notesCount = 0;
  let message = '';
  try {
    const v = await verifyAccountIdentity({
      targetDisplayName: TARGET_ACCOUNT.displayName,
      targetPublicUserId: TARGET_ACCOUNT.publicUserId,
    });
    verificationStatus = v.status;
    loginDisplayName = v.displayName ?? null;
    followers = v.loginFollowers ?? null;
    notesCount = v.creatorNotesCount ?? 0;
    message = v.message ?? '';
    // 同步 upsert 到账号表
    upsertAccount({
      account_key: TARGET_ACCOUNT_KEY,
      display_name: TARGET_ACCOUNT.displayName,
      public_profile_url: TARGET_ACCOUNT.publicProfileUrl,
      creator_center_url: TARGET_ACCOUNT.creatorCenterUrl,
      verification_status: v.status,
      verified_at: v.ok ? new Date().toISOString() : account?.verified_at ?? null,
      is_active: 1,
    });
  } catch (e) {
    verificationStatus = 'unconnected';
    message = `无法探测登录态：${(e as Error).message}`;
  }

  res.json({
    accountKey: TARGET_ACCOUNT_KEY,
    displayName: TARGET_ACCOUNT.displayName,
    publicProfileUrl: TARGET_ACCOUNT.publicProfileUrl,
    creatorCenterUrl: TARGET_ACCOUNT.creatorCenterUrl,
    expected: expectedAccountPayload(),
    verificationStatus,
    verifiedAt: account?.verified_at ?? null,
    lastSyncAt: account?.last_sync_at ?? null,
    loginDisplayName,
    followers,
    notesCount,
    message,
  });
});

// POST /api/xhs/account/verify-sync
// 验证账号 + 触发一次真实同步；仅当验证通过才写入新账号快照
app.post('/api/xhs/account/verify-sync', async (_req, res) => {
  const now = new Date().toISOString();
  // 1. 账号身份验证
  let v;
  try {
    v = await verifyAccountIdentity({
      targetDisplayName: TARGET_ACCOUNT.displayName,
      targetPublicUserId: TARGET_ACCOUNT.publicUserId,
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      verificationStatus: 'unconnected',
      accountKey: TARGET_ACCOUNT_KEY,
      displayName: TARGET_ACCOUNT.displayName,
      verifiedAt: now,
      message: `账号探测失败：${(e as Error).message}`,
    });
  }

  // 2. 验证不通过 → 409 ACCOUNT_MISMATCH，不写快照，不使用其他账号历史回退
  if (!v.ok || v.status !== 'verified') {
    upsertAccount({
      account_key: TARGET_ACCOUNT_KEY,
      display_name: TARGET_ACCOUNT.displayName,
      public_profile_url: TARGET_ACCOUNT.publicProfileUrl,
      creator_center_url: TARGET_ACCOUNT.creatorCenterUrl,
      verification_status: v.status === 'unconnected' ? 'unconnected' : 'mismatch',
      verified_at: null,
      is_active: 1,
    });
    return res.status(409).json({
      ok: false,
      code: 'ACCOUNT_MISMATCH',
      verificationStatus: v.status,
      accountKey: TARGET_ACCOUNT_KEY,
      displayName: TARGET_ACCOUNT.displayName,
      verifiedAt: now,
      message: v.message,
      loginDisplayName: v.displayName ?? null,
    });
  }

  // 3. 验证通过，标记账号有效
  setAccountActive(TARGET_ACCOUNT_KEY);
  upsertAccount({
    account_key: TARGET_ACCOUNT_KEY,
    display_name: TARGET_ACCOUNT.displayName,
    public_profile_url: TARGET_ACCOUNT.publicProfileUrl,
    creator_center_url: TARGET_ACCOUNT.creatorCenterUrl,
    verification_status: 'verified',
    verified_at: now,
    is_active: 1,
  });

  // 4. 真实同步（仅 target 账号）
  try {
    const data = await fetchLiveXhs();
    const id = saveXhsSnapshot({
      account_key: TARGET_ACCOUNT_KEY,
      synced_at: now,
      profile_json: data.profile ? JSON.stringify(data.profile) : null,
      metrics: data.periods.seven.metrics,
      notes: data.notes,
      periods: data.periods,
      source: 'live',
      message: '实时同步成功（已验证账号）',
    });
    return res.json({
      ok: true,
      verificationStatus: 'verified',
      accountKey: TARGET_ACCOUNT_KEY,
      displayName: TARGET_ACCOUNT.displayName,
      followers: data.profile?.followers ?? null,
      notesCount: data.notes.length,
      verifiedAt: now,
      snapshot: {
        id,
        accountKey: TARGET_ACCOUNT_KEY,
        syncedAt: now,
        profile: data.profile,
        notes: data.notes,
        periods: data.periods,
        source: 'live',
        message: '实时同步成功（已验证账号）',
      },
      message: '账号验证通过且同步成功。',
    });
  } catch (e) {
    const err = e as OpencliError;
    // 仅允许返回当前 account_key 的 stale 快照；无则 error 空状态，绝不写 demo
    const lastLive = getLatestXhsSnapshot(TARGET_ACCOUNT_KEY);
    if (lastLive && lastLive.source === 'live') {
      const resolved = resolveSnapshotPeriods(lastLive);
      return res.json({
        ok: false,
        verificationStatus: 'verified',
        accountKey: TARGET_ACCOUNT_KEY,
        displayName: TARGET_ACCOUNT.displayName,
        followers: lastLive.profile_json ? JSON.parse(lastLive.profile_json).followers ?? null : null,
        notesCount: JSON.parse(lastLive.notes_json || '[]').length,
        verifiedAt: now,
        snapshot: {
          id: lastLive.id,
          accountKey: TARGET_ACCOUNT_KEY,
          syncedAt: lastLive.synced_at,
          profile: resolved.profile_json ? JSON.parse(resolved.profile_json) : null,
          notes: JSON.parse(resolved.notes_json || '[]'),
          periods: resolved.periods,
          source: 'stale',
          message: `实时同步不可用（${err.code}）：${err.message}。已展示本次验证账号上次真实数据（${lastLive.synced_at}）。`,
        },
        message: `账号已验证，但同步失败。已展示当前账号上次数据。`,
      });
    }
    return res.json({
      ok: false,
      verificationStatus: 'verified',
      accountKey: TARGET_ACCOUNT_KEY,
      displayName: TARGET_ACCOUNT.displayName,
      verifiedAt: now,
      snapshot: null,
      message: `账号已验证，但同步失败：${err.message}。当前账号暂无历史数据。`,
    });
  }
});

// GET /api/xhs/snapshot?period=seven|thirty
// 仅返回当前 target 账号的快照，禁止全库最后一条（防止串号）
app.get('/api/xhs/snapshot', (req, res) => {
  const period = parsePeriod(req.query.period as string | undefined);
  const row = getLatestXhsSnapshot(TARGET_ACCOUNT_KEY);
  if (!row) return res.json(null);

  const resolved = resolveSnapshotPeriods(row);
  const periodData = resolved.periods[period] ?? resolved.periods.seven;
  if (!periodData) return res.json(null);

  const account = getAccount(TARGET_ACCOUNT_KEY);
  res.json({
    accountKey: row.account_key,
    syncedAt: row.synced_at,
    source: resolved.source,
    period,
    profile: resolved.profile_json ? JSON.parse(resolved.profile_json) : null,
    notes: JSON.parse(resolved.notes_json || '[]'),
    metrics: periodData.metrics,
    message: resolved.message,
    account: accountInfoPayload(account),
  });
});

// POST /api/xhs/sync
// 复杂同步入口：亦做账号验证，失败按当前账号隔离降级
app.post('/api/xhs/sync', async (_req, res) => {
  const now = new Date().toISOString();
  // 先验证账号
  let v;
  try {
    v = await verifyAccountIdentity({
      targetDisplayName: TARGET_ACCOUNT.displayName,
      targetPublicUserId: TARGET_ACCOUNT.publicUserId,
    });
  } catch (e) {
    v = { ok: false, status: 'unconnected', message: `账号探测失败：${(e as Error).message}` } as Awaited<ReturnType<typeof verifyAccountIdentity>>;
  }

  if (!v.ok || v.status !== 'verified') {
    upsertAccount({
      account_key: TARGET_ACCOUNT_KEY,
      display_name: TARGET_ACCOUNT.displayName,
      public_profile_url: TARGET_ACCOUNT.publicProfileUrl,
      creator_center_url: TARGET_ACCOUNT.creatorCenterUrl,
      verification_status: v.status === 'unconnected' ? 'unconnected' : 'mismatch',
      verified_at: null,
      is_active: 1,
    });
    return res.status(409).json({
      id: null,
      accountKey: TARGET_ACCOUNT_KEY,
      syncedAt: now,
      code: 'ACCOUNT_MISMATCH',
      verificationStatus: v.status,
      profile: null,
      notes: [],
      periods: { seven: { period: 'seven', metrics: [] }, thirty: { period: 'thirty', metrics: [] } },
      source: 'error',
      message: v.message || '账号不匹配，已拒绝同步。',
      loginDisplayName: v.displayName ?? null,
    });
  }

  try {
    const data = await fetchLiveXhs();
    const id = saveXhsSnapshot({
      account_key: TARGET_ACCOUNT_KEY,
      synced_at: now,
      profile_json: data.profile ? JSON.stringify(data.profile) : null,
      metrics: data.periods.seven.metrics,
      notes: data.notes,
      periods: data.periods,
      source: 'live',
      message: '实时同步成功',
    });
    setAccountActive(TARGET_ACCOUNT_KEY);
    const account = getAccount(TARGET_ACCOUNT_KEY);
    res.json({
      id,
      accountKey: TARGET_ACCOUNT_KEY,
      syncedAt: now,
      profile: data.profile,
      notes: data.notes,
      periods: data.periods,
      source: 'live',
      message: '实时同步成功',
      account: accountInfoPayload(account),
    });
  } catch (e) {
    const err = e as OpencliError;
    // 正式模式：不得写入 demo 数据；仅返回当前账号 stale/error
    if (!isDemoMode()) {
      const lastLive = getLatestXhsSnapshot(TARGET_ACCOUNT_KEY);
      if (lastLive && lastLive.source === 'live') {
        const resolved = resolveSnapshotPeriods(lastLive);
        const account = getAccount(TARGET_ACCOUNT_KEY);
        res.json({
          id: lastLive.id,
          accountKey: lastLive.account_key,
          syncedAt: lastLive.synced_at,
          profile: resolved.profile_json ? JSON.parse(resolved.profile_json) : null,
          notes: JSON.parse(resolved.notes_json || '[]'),
          periods: resolved.periods,
          source: 'stale',
          message: `实时同步不可用（${err.code}）：${err.message}。已展示当前账号上次真实数据（${lastLive.synced_at}）。`,
          account: accountInfoPayload(account),
        });
        return;
      }
      res.status(200).json({
        id: null,
        accountKey: TARGET_ACCOUNT_KEY,
        syncedAt: now,
        profile: null,
        notes: [],
        periods: { seven: { period: 'seven', metrics: [] }, thirty: { period: 'thirty', metrics: [] } },
        source: 'error',
        message: `实时同步不可用（${err.code}）：${err.message}。当前账号暂无历史真实数据可展示。`,
      });
      return;
    }
    // 显式 demo 模式：仅此时才写入演示数据（归入目标账号）
    const id = saveXhsSnapshot({
      account_key: TARGET_ACCOUNT_KEY,
      synced_at: now,
      profile_json: JSON.stringify(demoProfile()),
      metrics: demoMetrics(),
      notes: demoNotes(),
      periods: {
        seven: { period: 'seven', metrics: demoMetrics() },
        thirty: { period: 'thirty', metrics: demoMetrics() },
      },
      source: 'demo',
      message: `演示模式（WORKBENCH_DEMO_MODE=true）：实时同步不可用（${err.code}）。`,
    });
    res.json({
      id,
      accountKey: TARGET_ACCOUNT_KEY,
      syncedAt: now,
      profile: demoProfile(),
      notes: demoNotes(),
      periods: {
        seven: { period: 'seven', metrics: demoMetrics() },
        thirty: { period: 'thirty', metrics: demoMetrics() },
      },
      source: 'demo',
      message: `${err.message}（演示数据，页面已标记）。`,
    });
  }
});

// ===== 单篇笔记详情 =====
function detailToJson(detail: CreatorNoteDetail & { fetchedAt: string; source: 'live' | 'stale' | 'error'; message?: string | null }) {
  return {
    noteId: detail.noteId,
    accountKey: TARGET_ACCOUNT_KEY,
    fetchedAt: detail.fetchedAt,
    source: detail.source,
    message: detail.message ?? undefined,
    rawRows: detail.rawRows,
    title: detail.title,
    publishedAt: detail.publishedAt,
    basic: detail.basic,
    engagement: detail.engagement,
    dailyTrends: detail.dailyTrends,
    hourlyTrends: detail.hourlyTrends,
    trafficSources: detail.trafficSources,
    audience: detail.audience,
  };
}

// GET /api/xhs/notes/:noteId/detail
app.get('/api/xhs/notes/:noteId/detail', (req, res) => {
  const noteId = req.params.noteId;
  if (!isValidNoteId(noteId)) {
    return res.status(400).json({ error: '非法的笔记 ID' });
  }
  // 校验 note_id 属于当前账号的笔记集合（防串号）
  if (!noteIdBelongsToAccount(TARGET_ACCOUNT_KEY, noteId)) {
    return res.status(404).json({ error: '该笔记不属于当前账号', code: 'NOTE_NOT_FOUND' });
  }
  const cached = getNoteDetail(TARGET_ACCOUNT_KEY, noteId);
  if (cached) {
    if (isNoteDetailFresh(cached.fetched_at)) {
      return res.json({
        ...detailToJson({
          noteId: cached.note_id,
          fetchedAt: cached.fetched_at,
          source: cached.source as 'live' | 'stale' | 'error',
          message: cached.message,
          ...JSON.parse(cached.detail_json),
        }),
        cache: 'hit',
      });
    }
    // 缓存过期，返回 stale 并允许刷新
    return res.json({
      ...detailToJson({
        noteId: cached.note_id,
        fetchedAt: cached.fetched_at,
        source: 'stale',
        message: `缓存已过期（${cached.fetched_at}），可点击刷新获取最新数据。`,
        ...JSON.parse(cached.detail_json),
      }),
      cache: 'stale',
    });
  }
  // 无缓存：尝试实时拉取
  fetchNoteDetail(noteId)
    .then((detail) => {
      const fetchedAt = new Date().toISOString();
      saveNoteDetail({
        account_key: TARGET_ACCOUNT_KEY,
        note_id: noteId,
        fetched_at: fetchedAt,
        detail_json: JSON.stringify(detail),
        source: 'live',
        message: null,
      });
      res.json(detailToJson({ ...detail, fetchedAt, source: 'live' }));
    })
    .catch((e) => {
      const err = e as OpencliError;
      res.json(detailToJson({
        noteId,
        fetchedAt: new Date().toISOString(),
        source: 'error',
        message: `实时获取失败（${err.code}）：${err.message}。暂无缓存数据可展示。`,
        rawRows: [],
        basic: {},
        engagement: {},
        dailyTrends: {},
        hourlyTrends: {},
        trafficSources: [],
        audience: { gender: [], ages: [], cities: [], interests: [] },
      }));
    });
});

// POST /api/xhs/notes/:noteId/detail/refresh
app.post('/api/xhs/notes/:noteId/detail/refresh', (req, res) => {
  const noteId = req.params.noteId;
  if (!isValidNoteId(noteId)) {
    return res.status(400).json({ error: '非法的笔记 ID' });
  }
  if (!noteIdBelongsToAccount(TARGET_ACCOUNT_KEY, noteId)) {
    return res.status(404).json({ error: '该笔记不属于当前账号', code: 'NOTE_NOT_FOUND' });
  }
  fetchNoteDetail(noteId)
    .then((detail) => {
      const fetchedAt = new Date().toISOString();
      saveNoteDetail({
        account_key: TARGET_ACCOUNT_KEY,
        note_id: noteId,
        fetched_at: fetchedAt,
        detail_json: JSON.stringify(detail),
        source: 'live',
        message: null,
      });
      res.json(detailToJson({ ...detail, fetchedAt, source: 'live' }));
    })
    .catch((e) => {
      const err = e as OpencliError;
      // 有缓存则返回 stale，无缓存 error，绝不写 demo
      const cached = getNoteDetail(TARGET_ACCOUNT_KEY, noteId);
      if (cached) {
        res.json({
          ...detailToJson({
            noteId,
            fetchedAt: cached.fetched_at,
            source: 'stale',
            message: `刷新失败（${err.code}）：${err.message}。已展示上次真实数据。`,
            ...JSON.parse(cached.detail_json),
          }),
        });
        return;
      }
      res.json(detailToJson({
        noteId,
        fetchedAt: new Date().toISOString(),
        source: 'error',
        message: `刷新失败（${err.code}）：${err.message}。暂无缓存数据可展示。`,
        rawRows: [],
        basic: {},
        engagement: {},
        dailyTrends: {},
        hourlyTrends: {},
        trafficSources: [],
        audience: { gender: [], ages: [], cities: [], interests: [] },
      }));
    });
});

// ===== 热点雷达（V1.3 次幂数据）=====

// GET /api/hotspots/status
app.get('/api/hotspots/status', (_req, res) => {
  const status = getHotspotStatus();
  const stats = getHotspotCallTotals();
  const cimi = getCimiMeta();
  res.json({
    ...status,
    sources: status.sources.map((s) => withNickname(s)),
    estimatedCost: status.estimatedCost,
    callStats: stats,
    cimi,
    syncing: isSyncing(),
    runtime: { backendRuntime: isBackendRuntime },
  });
});

// GET /api/hotspots/sources
app.get('/api/hotspots/sources', (_req, res) => {
  const srcs = getAllHotspotSources().map((s) => withNickname(s));
  res.json(srcs);
});

function withNickname(s: { id: number; source_key: string; display_name: string; account_biz: string; account_wxid: string; avatar_url: string | null; signature: string | null; fans: number | null; enabled: number; created_at: string; updated_at: string; last_fetch_at: string | null; last_article_count: number }) {
  const nickname = s.source_key === 'wechat:huxiu' ? '虎嗅APP' : s.source_key === 'wechat:36kr' ? '36氪' : s.display_name;
  return {
    id: s.id,
    sourceKey: s.source_key,
    displayName: s.display_name,
    nickname,
    accountBiz: s.account_biz,
    accountWxid: s.account_wxid,
    avatarUrl: s.avatar_url,
    signature: s.signature,
    fans: s.fans,
    enabled: s.enabled,
    lastFetchAt: s.last_fetch_at,
    lastArticleCount: s.last_article_count,
    // 来源同步状态：只要有抓取成功记录或公众号信息已回填，就不应再显示“待首次抓取”
    cimiSynced: !!s.last_fetch_at || !!s.account_wxid || !!s.account_biz || Number(s.last_article_count) > 0,
  };
}

// POST /api/hotspots/sync  （409 若正在同步）
app.post('/api/hotspots/sync', async (req, res) => {
  let triggeredBy = (req.body?.triggeredBy as string) || 'manual';
  if (!['manual', 'scheduler:manual'].includes(triggeredBy)) triggeredBy = 'manual';
  if (isSyncing()) {
    return res.status(409).json({ ok: false, code: 'SYNC_IN_PROGRESS', message: '热点头条同步正在进行中，请稍候再试。' });
  }
  const r = await runHotspotSync(triggeredBy);
  res.json({ ok: true, ...r });
});

// GET /api/hotspots  （分页 + 筛选）
app.get('/api/hotspots', (req, res) => {
  const q = {
    page: req.query.page ? Number(req.query.page) : undefined,
    pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    sourceKey: req.query.sourceKey as string | undefined,
    dateFrom: req.query.dateFrom as string | undefined,
    dateTo: req.query.dateTo as string | undefined,
    keyword: req.query.keyword as string | undefined,
    readStatus: req.query.readStatus as string | undefined,
  };
  const result = listHotspotArticles(q);
  res.json({ ...result, items: result.items.map(articleToListPayload) });
});

function articleToListPayload(a: HotspotArticleRow & { source_key?: string; display_name?: string }) {
  return {
    id: a.id,
    sourceId: a.source_id,
    sourceKey: a.source_key,
    sourceName: a.display_name,
    title: a.title,
    url: a.url,
    digest: a.digest,
    author: a.author,
    publishTime: a.publish_time,
    fetchedAt: a.fetched_at,
    bodyReady: !!a.body_ready,
    bodyTooShort: !!a.body_too_short,
    bodyPending: !!a.body_pending,
    bodyError: a.body_error,
    readStatus: a.read_status,
    todoStatus: a.todo_status,
  };
}

// GET /api/hotspots/:id
app.get('/api/hotspots/:id', (req, res) => {
  const a = getHotspotArticle(Number(req.params.id));
  if (!a) return res.status(404).json({ error: '文章不存在', code: 'NOT_FOUND' });
  const src = a.source_id ? getHotspotSource(a.source_id) : undefined;
  res.json({
    ...articleToListPayload(a),
    sourceName: src?.display_name ?? '',
    bodyText: a.body_text,
    bodyHash: a.body_hash,
    createdAt: a.created_at,
  });
});

// PATCH /api/hotspots/:id
app.patch('/api/hotspots/:id', (req, res) => {
  const id = Number(req.params.id);
  const patch: { read_status?: string; todo_status?: string } = {};
  if (typeof req.body?.read_status === 'string') {
    if (!['unread', 'read'].includes(req.body.read_status)) {
      return res.status(400).json({ error: 'read_status 仅允许 unread 或 read', code: 'INVALID_ENUM' });
    }
    patch.read_status = req.body.read_status;
  }
  if (typeof req.body?.todo_status === 'string') {
    if (!['none', 'added'].includes(req.body.todo_status)) {
      return res.status(400).json({ error: 'todo_status 仅允许 none 或 added', code: 'INVALID_ENUM' });
    }
    patch.todo_status = req.body.todo_status;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: '无有效字段' });
  const existing = getHotspotArticle(id);
  if (!existing) return res.status(404).json({ error: '文章不存在', code: 'NOT_FOUND' });
  updateHotspotArticleStatus(id, patch);
  res.json(articleToListPayload(getHotspotArticle(id)!));
});

// POST /api/hotspots/:id/add-to-todo
app.post('/api/hotspots/:id/add-to-todo', (req, res) => {
  const id = Number(req.params.id);
  const result = addHotspotArticleToTodo(id);
  if (result.status === 'not_found') {
    return res.status(404).json({ error: '文章不存在', code: 'NOT_FOUND' });
  }
  if (result.status === 'already') {
    return res.status(409).json({ error: '该文章已在待办中', code: 'ALREADY_IN_TODO' });
  }
  res.json({ ok: true, todoId: result.todoId, article: articleToListPayload(getHotspotArticle(id)!) });
});

// GET /api/hotspots/runs  （最近抓取记录）
app.get('/api/hotspots/runs', (_req, res) => {
  res.json(getRecentFetchRuns(20));
});

// PATCH /api/hotspots/sources/:id  （启用/停用来源）
app.patch('/api/hotspots/sources/:id', (req, res) => {
  const id = Number(req.params.id);
  const src = getHotspotSource(id);
  if (!src) return res.status(404).json({ error: '来源不存在', code: 'NOT_FOUND' });
  if (typeof req.body?.enabled === 'boolean') setHotspotDisabled(id, !req.body.enabled);
  if (typeof req.body?.nickname === 'string' && req.body.nickname) {
    updateHotspotSourceInfo(id, {}); // 占位（nickname 用于查询，不落库）
  }
  res.json(getHotspotSource(id));
});

// ===== 知识大脑（V1.4：本地知识库服务代理）=====
// 通过白名单客户端转发到外部 8765 服务，不暴露内部路径/API Key；
// 上游离线时统一返回 503 code=KNOWLEDGE_SERVICE_OFFLINE。

// GET /api/knowledge/status → 在线状态 + 文档/片段数 + 模型配置（拆分语义）
app.get('/api/knowledge/status', async (_req, res) => {
  const baseUrl = process.env.KNOWLEDGE_BASE_URL || 'http://127.0.0.1:8765';
  try {
    const status = await getKnowledgeStatus();
    res.json({
      ...status,
      online: true,
      serviceConfigured: isKnowledgeConfigured(),
      modelsConfigured: status.configured,
      baseUrl,
      checkedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(e instanceof KnowledgeServiceError ? e.status : 503).json({
      code: e instanceof KnowledgeServiceError ? e.code : 'KNOWLEDGE_SERVICE_OFFLINE',
      message: e instanceof Error ? e.message : '知识库服务不可用',
      online: false,
      serviceConfigured: isKnowledgeConfigured(),
      modelsConfigured: null,
      baseUrl,
      checkedAt: new Date().toISOString(),
    });
  }
});

// GET /api/knowledge/documents → 文档列表（已裁剪内部路径；支持 limit/offset 并返回 total）
app.get('/api/knowledge/documents', async (req, res) => {
  try {
    const all = await getKnowledgeDocuments();
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : undefined;
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const documents = limit ? all.slice(offset, offset + limit) : all.slice(offset);
    res.json({ documents, total: all.length, limit: limit ?? null, offset });
  } catch (e) {
    res.status(e instanceof KnowledgeServiceError ? e.status : 503).json({
      code: e instanceof KnowledgeServiceError ? e.code : 'KNOWLEDGE_SERVICE_OFFLINE',
      message: e instanceof Error ? e.message : '知识库服务不可用',
    });
  }
});

// POST /api/knowledge/chat → 问知识库
app.post('/api/knowledge/chat', async (req, res) => {
  try {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!question) {
      return res.status(400).json({ code: 'REQUIRED_FIELD', message: '请输入一个问题' });
    }
    if (question.length > 8000) {
      return res.status(400).json({ code: 'QUESTION_TOO_LONG', message: '问题最多 8000 字，请精简后再提问' });
    }
    if (history.length > 12) {
      return res.status(400).json({ code: 'HISTORY_TOO_LONG', message: '历史上下文最多 6 轮（12 条消息）' });
    }
    const result = await chatKnowledge(question, history);
    res.json(result);
  } catch (e) {
    res.status(e instanceof KnowledgeServiceError ? e.status : 503).json({
      code: e instanceof KnowledgeServiceError ? e.code : 'KNOWLEDGE_SERVICE_OFFLINE',
      message: e instanceof Error ? e.message : '知识库服务不可用',
    });
  }
});

// POST /api/knowledge/upload → 上传 .md（≤10MB，multer 已限制）
app.post('/api/knowledge/upload', (req, res) => {
  kbUpload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr instanceof Error ? uploadErr.message : '上传失败';
      const tooLarge = typeof msg === 'string' && /10 ?MB|文件大小|File too large|limit/i.test(msg);
      return res.status(tooLarge ? 413 : 400).json({ code: 'UPLOAD_ERROR', message: msg });
    }
    const multerReq = req as Request & { file?: Express.Multer.File };
    try {
      if (!multerReq.file || !multerReq.file.buffer) {
        return res.status(400).json({ code: 'REQUIRED_FIELD', message: '请选择一个 Markdown 文件' });
      }
      const filename = multerReq.file.originalname || 'unnamed.md';
      const result = await uploadKnowledge(multerReq.file.buffer, filename);
      res.status(201).json(result);
    } catch (e) {
      res.status(e instanceof KnowledgeServiceError ? e.status : 503).json({
        code: e instanceof KnowledgeServiceError ? e.code : 'KNOWLEDGE_SERVICE_OFFLINE',
        message: e instanceof Error ? e.message : '知识库服务不可用',
      });
    }
  });
});

// DELETE /api/knowledge/documents/:id → 删除文档
app.delete('/api/knowledge/documents/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!id) return res.status(400).json({ code: 'REQUIRED_FIELD', message: '缺少文档 ID' });
    // 只接受固定格式的文档 ID，防止把代理当任意 URL/路径删除器
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) {
      return res.status(400).json({ code: 'INVALID_DOCUMENT_ID', message: '文档 ID 格式不合法' });
    }
    const result = await deleteKnowledgeDocument(id);
    res.json(result);
  } catch (e) {
    res.status(e instanceof KnowledgeServiceError ? e.status : 503).json({
      code: e instanceof KnowledgeServiceError ? e.code : 'KNOWLEDGE_SERVICE_OFFLINE',
      message: e instanceof Error ? e.message : '知识库服务不可用',
    });
  }
});

// ===== 知识大脑 · 热点雷达整合（代理到外部知识库 hotspots 服务）=====

// GET /api/knowledge/hotspots/status
app.get('/api/knowledge/hotspots/status', async (_req, res) => {
  try {
    res.json(await getKnowledgeHotspotStatus());
  } catch (e) {
    res.status(e instanceof KnowledgeServiceError ? e.status : 503).json({
      code: e instanceof KnowledgeServiceError ? e.code : 'KNOWLEDGE_SERVICE_OFFLINE',
      message: e instanceof Error ? e.message : '知识库服务不可用',
    });
  }
});

// GET /api/knowledge/hotspots/articles → L叔精选（20 篇历史校准素材）
app.get('/api/knowledge/hotspots/articles', async (_req, res) => {
  try {
    res.json(await getKnowledgeHotspotArticles());
  } catch (e) {
    res.status(e instanceof KnowledgeServiceError ? e.status : 503).json({
      code: e instanceof KnowledgeServiceError ? e.code : 'KNOWLEDGE_SERVICE_OFFLINE',
      message: e instanceof Error ? e.message : '知识库服务不可用',
    });
  }
});

// GET /api/knowledge/hotspots/drafts → 本机 SQLite 中的朋友圈草稿历史
app.get('/api/knowledge/hotspots/drafts', (req, res) => {
  try {
    const query = normalizeKnowledgeHotspotDraftListQuery({
      page: req.query.page,
      pageSize: req.query.pageSize,
      keyword: req.query.keyword,
    });
    res.json(knowledgeHotspotDrafts.list(query));
  } catch (e) {
    const known = e instanceof KnowledgeHotspotDraftError;
    res.status(known ? e.status : 500).json({
      code: known ? e.code : 'DRAFT_PERSIST_FAILED',
      message: known ? e.message : '朋友圈草稿历史读取失败',
    });
  }
});

// POST /api/knowledge/hotspots/refresh → 刷新 36Kr 精选并评分
app.post('/api/knowledge/hotspots/refresh', async (_req, res) => {
  try {
    res.json(await refreshKnowledgeHotspots());
  } catch (e) {
    res.status(e instanceof KnowledgeServiceError ? e.status : 503).json({
      code: e instanceof KnowledgeServiceError ? e.code : 'KNOWLEDGE_SERVICE_OFFLINE',
      message: e instanceof Error ? e.message : '知识库服务不可用',
    });
  }
});

// POST /api/knowledge/hotspots/generate → 生成朋友圈草稿
app.post('/api/knowledge/hotspots/generate', async (req, res) => {
  try {
    const articleId = typeof req.body?.article_id === 'string' ? req.body.article_id.trim() : '';
    if (!articleId) {
      return res.status(400).json({ code: 'REQUIRED_FIELD', message: '请选择一篇热点文章' });
    }
    if (articleId.length > 200) {
      return res.status(400).json({ code: 'DRAFT_VALIDATION_FAILED', message: '文章 ID 不能超过 200 个字符' });
    }
    const generationMode = normalizeKnowledgeHotspotGenerationMode(req.body?.generation_mode);
    const requestId = normalizeKnowledgeHotspotRequestId(req.body?.request_id);

    // request_id 是本机幂等键。命中时不再重复请求模型，也不会产生重复历史版本。
    if (requestId) {
      const existing = knowledgeHotspotDrafts.findByRequestId(requestId);
      if (existing) {
        if (existing.article_id !== articleId) {
          throw new KnowledgeHotspotDraftError(
            'DRAFT_REQUEST_CONFLICT',
            'request_id 已用于另一篇文章',
            409,
          );
        }
        return res.json({ draft: existing.draft });
      }
    }

    const generated = await generateKnowledgeHotspotWithSource(articleId);
    const stored = knowledgeHotspotDrafts.save({
      source: {
        articleId: generated.source.article_id,
        title: generated.source.title,
        url: generated.source.url,
        author: generated.source.author,
        publishedAtMs: generated.source.published_at_ms,
      },
      draft: generated.draft,
      generationMode,
      requestId,
    });

    // 公开契约保持不变：不暴露来源快照、request_id 或内部持久化字段。
    res.json({ draft: stored.draft });
  } catch (e) {
    const knownDraftError = e instanceof KnowledgeHotspotDraftError;
    const knownServiceError = e instanceof KnowledgeServiceError;
    res.status(knownDraftError ? e.status : knownServiceError ? e.status : 500).json({
      code: knownDraftError ? e.code : knownServiceError ? e.code : 'DRAFT_PERSIST_FAILED',
      message: e instanceof Error ? e.message : '朋友圈草稿保存失败',
    });
  }
});

registerProductivityRoutes(app);
registerFinanceRoutes(app);

const weatherClient = createWeatherClient({ locationLabelResolver: createLocationLabelResolver() });

app.post('/api/weather/today', async (req, res) => {
  try {
    res.json(await weatherClient.getToday(req.body));
  } catch {
    res.status(200).json({
      status: 'unavailable',
      locationLabel: '电脑当前位置',
      timezone: '',
      localDate: '',
      fetchedAt: null,
      current: null,
      today: null,
      errorCode: 'WEATHER_UPSTREAM_UNAVAILABLE',
    });
  }
});

// Production: serve the prebuilt React app from the same localhost origin.
// Development continues to use Vite on port 5173.
const frontendDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
if (existsSync(resolve(frontendDist, 'index.html'))) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(resolve(frontendDist, 'index.html'));
  });
}

app.listen(PORT, BIND_HOST, () => {
  const interrupted = productivity.interruptOrphanRunningRuns();
  if (interrupted > 0) {
    console.log(`[sync] interrupted ${interrupted} orphan running run(s)`);
  }
  console.log(`✅ L叔工作台后端已启动: http://127.0.0.1:${PORT}`);
  if (process.env.DISABLE_SCHEDULERS === '1') return;
  startScheduler();
  startProductivityScheduler();
});
