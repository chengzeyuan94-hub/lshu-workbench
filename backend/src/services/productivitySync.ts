import { readDesktop, type DesktopCheckpoint } from '../connectors/desktop';
import { homedir } from 'node:os';
import { readFeishu } from '../connectors/feishu';
import { readThings } from '../connectors/things';
import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from '../connectors/errors';
import type { ArgvRunner } from '../connectors/safeExec';
import type { ConnectorStatus, StandardizedItem } from '../connectors/types';
import { WORKBENCH_CALENDAR_NAME } from '../connectors/types';
import { getSettings, productivity, type TodoRow } from '../db';
import { redactText } from './redact';
import { analyzeUnstructuredSources, type AnalyzerDeps } from './actionIntentAnalyzer';
import { getDeepseekRuntimeConfig } from '../config/runtimeConfig';
import { inspectCalendarReadable, recordCalendarConnectorRound } from './calendarStatus';
import { persistFeishuAgenda, syncAppleAgenda } from './agendaService';
import { publicTodoDto } from './publicDto';
import { canonicalEventKey } from '../productivitySchemaV3';

export interface SyncDeps extends AnalyzerDeps {
  thingsRunner?: ArgvRunner;
  feishuRunner?: ArgvRunner;
  calendarRunner?: ArgvRunner;
  desktopCollect?: Parameters<typeof readDesktop>[0]['collect'];
  includeAi?: boolean;
  persistAgenda?: boolean;
  desktopOnly?: boolean;
}

export type ConnectorErrorItem = { connector: string; code?: string; message?: string };

export interface CommitSyncResult {
  runId: number;
  status: string;
  created: number;
  updated: number;
  itemsSeen: number;
  candidateCount: number;
  candidates: unknown[];
  connectorErrors: ConnectorErrorItem[];
  ai: {
    inputUnits: number;
    cacheHits: number;
    calls: number;
    actionable: number;
    review: number;
    rejected: number;
    deferred: number;
    waitingForAi: boolean;
    errorCode?: string;
  };
  appleCount: number;
  receipt: string;
  write: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

let activeRunId: number | null = null;
let activePromise: Promise<CommitSyncResult> | null = null;

function settingsFlags() {
  const s = getSettings();
  return {
    thingsEnabled: s.thingsEnabled !== false,
    feishuEnabled: s.feishuEnabled !== false,
    desktopEnabled: s.desktopEnabled !== false,
    calendarEnabled: s.calendarEnabled !== false,
    autoScheduleEnabled: s.autoScheduleEnabled === true,
    autoCompleteEnabled: s.autoCompleteEnabled === true,
    aiAnalysisEnabled: s.aiAnalysisEnabled === true,
    aiAutoSyncEnabled: s.aiAutoSyncEnabled === true,
    feishuChatAllowlist: Array.isArray(s.feishuChatAllowlist) ? (s.feishuChatAllowlist as string[]) : [],
    feishuP2pEnabled: s.feishuP2pEnabled === true,
    feishuAllowAll: s.feishuAllowAll === true,
    scanRoot: String(s.scanRoot || process.env.WORKBENCH_SCAN_ROOT || `${homedir()}/Desktop`),
    excludedDirs: Array.isArray(s.excludedDirs) ? (s.excludedDirs as string[]) : [],
  };
}

export interface CollectResult {
  items: StandardizedItem[];
  connectorErrors: Array<{ connector: string; code?: string; message?: string }>;
  checkpointPatches: Array<{ connector: string; config: unknown; cursor?: string }>;
  thingsSnapshotComplete: boolean;
  extras: Record<string, unknown>;
}

export async function collectStandardizedItems(deps: SyncDeps = {}, options: { persistCheckpoints?: boolean } = {}): Promise<CollectResult> {
  const flags = settingsFlags();
  if (deps.desktopOnly) {
    flags.thingsEnabled = false;
    flags.feishuEnabled = false;
    flags.calendarEnabled = false;
  }
  const items: StandardizedItem[] = [];
  const connectorErrors: Array<{ connector: string; code?: string; message?: string }> = [];
  const checkpointPatches: Array<{ connector: string; config: unknown; cursor?: string }> = [];
  const extras: Record<string, unknown> = {};
  let thingsSnapshotComplete = false;

  if (flags.desktopEnabled) {
    const prevRaw = productivity.getCheckpoint('desktop');
    const previous = prevRaw ? (JSON.parse(prevRaw.config_json || '{}') as DesktopCheckpoint) : undefined;
    const desktop = readDesktop({
      rootDir: flags.scanRoot,
      extraSkipDirs: flags.excludedDirs,
      previous: previous?.files ? previous : undefined,
      collect: deps.desktopCollect,
    });
    items.push(...desktop.items);
    if (!desktop.ok) connectorErrors.push({ connector: 'desktop', code: desktop.errorCode, message: desktop.errorMessage });
    if (desktop.extra?.checkpoint) {
      checkpointPatches.push({ connector: 'desktop', config: { ...desktop.extra.checkpoint, fileCount: desktop.extra.fileCount } });
    }
    extras.desktopCount = desktop.items.length;
  }

  if (flags.thingsEnabled) {
    const things = await readThings({ runner: deps.thingsRunner });
    items.push(...things.items);
    thingsSnapshotComplete = things.ok && things.extra?.snapshotComplete !== false && things.extra?.truncated !== true;
    if (!things.ok) connectorErrors.push({ connector: 'things', code: things.errorCode, message: things.errorMessage });
    extras.thingsCount = things.items.length;
    extras.thingsOk = things.ok;
    extras.thingsSnapshotComplete = thingsSnapshotComplete;
    if (things.ok) {
      checkpointPatches.push({
        connector: 'things',
        config: { snapshotComplete: thingsSnapshotComplete, truncated: things.extra?.truncated === true, itemsSeen: things.items.length, scope: 'today' },
      });
    }
  }

  if (flags.feishuEnabled) {
    const feishu = await readFeishu({
      runner: deps.feishuRunner,
      allowlist: flags.feishuChatAllowlist,
      p2pEnabled: flags.feishuP2pEnabled,
      allowAll: flags.feishuAllowAll,
      timeoutMs: flags.feishuAllowAll || flags.feishuChatAllowlist.length > 0 ? 20_000 : 12_000,
    });
    items.push(...feishu.items.filter((i) => i.sourceType !== 'feishu_calendar'));
    extras.feishuEvents = feishu.items.filter((i) => i.sourceType === 'feishu_calendar');
    extras.feishuCount = feishu.items.filter((i) => i.sourceType === 'feishu_message').length;
    extras.feishuOk = feishu.ok;
    extras.feishuPartial = feishu.extra?.partial === true;
    extras.feishuHasCurrentUserId = feishu.extra?.hasCurrentUserId === true;
    extras.feishuIdentity = feishu.identity;
    extras.feishuTokenStatus = feishu.extra?.tokenStatus;
    extras.feishuChatCount = feishu.extra?.chatCount ?? 0;
    extras.feishuChatsRead = feishu.extra?.chatsRead ?? 0;
    extras.feishuChatsFailed = feishu.extra?.chatsFailed ?? 0;
    extras.feishuTruncatedChats = feishu.extra?.truncatedChats ?? 0;
    extras.feishuErrorCode = feishu.errorCode || null;
    if (feishu.ok) {
      checkpointPatches.push({
        connector: 'feishu',
        config: {
          identity: feishu.identity,
          tokenStatus: feishu.extra?.tokenStatus,
          chatCount: feishu.extra?.chatCount ?? 0,
          allowlistCount: feishu.extra?.allowlistCount ?? 0,
          chatsRead: feishu.extra?.chatsRead ?? 0,
          chatsFailed: feishu.extra?.chatsFailed ?? 0,
          truncatedChats: feishu.extra?.truncatedChats ?? 0,
          lastRoundPartial: feishu.extra?.partial === true,
        },
      });
    }
    if (!feishu.ok) connectorErrors.push({ connector: 'feishu', code: feishu.errorCode, message: redactText(feishu.errorMessage || '', 160) });
  }

  if (options.persistCheckpoints) {
    for (const patch of checkpointPatches) productivity.saveCheckpoint(patch.connector, patch.config, patch.cursor);
  }

  return { items, connectorErrors, checkpointPatches, thingsSnapshotComplete, extras };
}

function parseCheckpointConfig(raw?: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function latestThingsError(): string | null {
  for (const run of productivity.getSyncRuns(8)) {
    if (run.error_code === 'THINGS_UNAVAILABLE' || run.error_code === 'THINGS_PERMISSION_DENIED') {
      return run.error_message || run.error_code;
    }
  }
  return null;
}

function roundStatus(cfg: Record<string, unknown>, lastSuccessAt?: string | null): {
  itemsRead: number;
  roundCount: number;
  lastSuccessCount: number;
  lastRoundOk: boolean;
  lastRoundPartial: boolean;
  usingStaleSnapshot: boolean;
  hasCurrentUserId: boolean;
  chatsRead: number;
  chatsFailed: number;
  truncatedChats: number;
  statusLabel: string;
  available: boolean;
} {
  const hasRound = Object.prototype.hasOwnProperty.call(cfg, 'lastRoundOk') || Object.prototype.hasOwnProperty.call(cfg, 'lastRoundCount');
  const lastRoundOk = cfg.lastRoundOk === true;
  const lastRoundPartial = cfg.lastRoundPartial === true;
  const roundCount = hasRound ? Number(cfg.lastRoundCount ?? 0) : 0;
  const lastSuccessCount = Number(cfg.lastSuccessCount ?? 0);
  const usingStaleSnapshot = lastRoundOk
    ? false
    : cfg.usingStaleSnapshot === true || (hasRound && Boolean(lastSuccessAt));
  let statusLabel = '未同步';
  if (hasRound && lastRoundOk && lastRoundPartial) statusLabel = '部分可读';
  else if (hasRound && lastRoundOk) statusLabel = '可读';
  else if (hasRound) statusLabel = '不可读';
  else if (lastSuccessAt) statusLabel = '旧快照';
  return {
    itemsRead: roundCount,
    roundCount,
    lastSuccessCount,
    lastRoundOk,
    lastRoundPartial,
    usingStaleSnapshot,
    hasCurrentUserId: cfg.hasCurrentUserId === true,
    chatsRead: Number(cfg.chatsRead ?? 0),
    chatsFailed: Number(cfg.chatsFailed ?? 0),
    truncatedChats: Number(cfg.truncatedChats ?? 0),
    statusLabel,
    available: lastRoundOk,
  };
}

export async function getConnectorStatuses(_deps: SyncDeps = {}): Promise<ConnectorStatus[]> {
  const flags = settingsFlags();
  const thingsCp = productivity.getCheckpoint('things');
  const feishuCp = productivity.getCheckpoint('feishu');
  const desktopCp = productivity.getCheckpoint('desktop');
  const ai = getDeepseekRuntimeConfig();
  const thingsCfg = parseCheckpointConfig(thingsCp?.config_json);
  const feishuCfg = parseCheckpointConfig(feishuCp?.config_json);
  const desktopCfg = parseCheckpointConfig(desktopCp?.config_json);
  const thingsRound = roundStatus(thingsCfg, thingsCp?.last_success_at);
  const feishuRound = roundStatus(feishuCfg, feishuCp?.last_success_at);
  const desktopRound = roundStatus(desktopCfg, desktopCp?.last_success_at);

  const calendar = inspectCalendarReadable(String(getSettings().timezone || 'Asia/Shanghai'));
  const feishuHint = feishuRound.lastRoundOk
    ? (flags.aiAnalysisEnabled && ai.configured ? '最近 3 天聊天需经 DeepSeek 分析后才进入待办' : 'AI 分析未开启：飞书不会自动生成待办')
    : (feishuRound.usingStaleSnapshot ? '本轮不可读，未使用旧会话数冒充本轮读取' : '本轮不可读');

  return [
    {
      id: 'desktop',
      label: '桌面',
      enabled: flags.desktopEnabled,
      available: desktopRound.lastRoundOk || (!Object.prototype.hasOwnProperty.call(desktopCfg, 'lastRoundOk') && true),
      lastSyncAt: desktopCp?.last_success_at ?? null,
      lastSuccessAt: desktopCp?.last_success_at ?? null,
      itemsRead: desktopRound.itemsRead,
      roundCount: desktopRound.roundCount,
      lastSuccessCount: desktopRound.lastSuccessCount || Number(desktopCfg.fileCount ?? 0),
      lastRoundOk: desktopRound.lastRoundOk,
      usingStaleSnapshot: desktopRound.usingStaleSnapshot,
      statusLabel: Object.prototype.hasOwnProperty.call(desktopCfg, 'lastRoundOk') ? desktopRound.statusLabel : '本机',
      hint: '只处理今天新建或修改的文件',
    },
    {
      id: 'things',
      label: 'Things',
      enabled: flags.thingsEnabled,
      available: thingsRound.lastRoundOk || (!Object.prototype.hasOwnProperty.call(thingsCfg, 'lastRoundOk') && Boolean(thingsCp?.last_success_at)),
      lastSyncAt: thingsCp?.last_success_at ?? null,
      lastSuccessAt: thingsCp?.last_success_at ?? null,
      lastError: (thingsRound.lastRoundOk || Boolean(thingsCp?.last_success_at)) ? null : latestThingsError(),
      itemsRead: thingsRound.itemsRead,
      roundCount: thingsRound.roundCount,
      lastSuccessCount: thingsRound.lastSuccessCount || Number(thingsCfg.itemsSeen ?? 0),
      lastRoundOk: thingsRound.lastRoundOk,
      usingStaleSnapshot: thingsRound.usingStaleSnapshot,
      statusLabel: Object.prototype.hasOwnProperty.call(thingsCfg, 'lastRoundOk') ? thingsRound.statusLabel : (thingsCp?.last_success_at ? '可读' : '未同步'),
      hint: thingsCfg.truncated === true ? '快照截断，部分任务可能未读入' : '只读 Things「今天」1:1，不写回，不经过 AI',
    },
    {
      id: 'feishu',
      label: '飞书',
      enabled: flags.feishuEnabled,
      available: feishuRound.lastRoundOk,
      lastSyncAt: feishuCp?.last_success_at ?? null,
      lastSuccessAt: feishuCp?.last_success_at ?? null,
      lastError: feishuRound.lastRoundOk ? null : String(feishuCfg.lastRoundError || '') || null,
      itemsRead: feishuRound.itemsRead,
      roundCount: feishuRound.roundCount,
      lastSuccessCount: feishuRound.lastSuccessCount || Number(feishuCfg.chatCount ?? 0),
      lastRoundOk: feishuRound.lastRoundOk,
      lastRoundPartial: feishuRound.lastRoundPartial,
      usingStaleSnapshot: feishuRound.usingStaleSnapshot,
      hasCurrentUserId: feishuRound.hasCurrentUserId,
      chatsRead: feishuRound.chatsRead,
      chatsFailed: feishuRound.chatsFailed,
      truncatedChats: feishuRound.truncatedChats,
      statusLabel: feishuRound.statusLabel,
      hint: feishuHint,
    },
    {
      id: 'calendar',
      label: 'Apple Calendar',
      enabled: flags.calendarEnabled,
      available: calendar.available,
      lastSyncAt: calendar.lastSyncAt,
      lastSuccessAt: calendar.lastSyncAt,
      lastError: calendar.available ? null : calendar.errorCode,
      itemsRead: calendar.itemsRead,
      roundCount: calendar.roundCount,
      lastSuccessCount: calendar.lastSuccessCount,
      lastRoundOk: calendar.lastRoundOk,
      usingStaleSnapshot: calendar.usingStaleSnapshot,
      hint: calendar.hint,
      permission: calendar.permission,
      errorCode: calendar.errorCode,
      busyStatus: calendar.busyStatus,
      helperVersion: calendar.helperVersion,
      helperBuildId: calendar.helperBuildId,
      needsReconnect: calendar.needsReconnect,
      statusLabel: calendar.statusLabel,
      windowStatus: calendar.windowStatus,
    },
  ];
}

function applyThings(items: StandardizedItem[], snapshotComplete: boolean, scope = 'today'): { created: number; updated: number } {
  const things = items.filter((i) => i.sourceType === 'things' && (i.payload.list === 'today' || scope === 'today'));
  let created = 0;
  let updated = 0;
  const seen = new Set<string>();
  for (const item of things) {
    if (item.payload.list && item.payload.list !== 'today') continue;
    seen.add(item.sourceExternalId);
    const status = item.status === 'completed' ? 'completed' : item.status === 'canceled' ? 'canceled' : 'open';
    const result = productivity.upsertThingsMirror({
      title: item.title,
      sourceExternalId: item.sourceExternalId,
      sourceFingerprint: item.sourceFingerprint,
      project: item.project,
      dueAt: item.dueAt ?? null,
      reason: 'Things · 只读「今天」',
      sourceStatus: status === 'open' ? 'open' : status,
      estimatedMinutes: 45,
    });
    if (result.action === 'created') created += 1;
    else updated += 1;
  }
  if (snapshotComplete) {
    const mirrors = productivity.listThingsMirrors();
    for (const row of mirrors) {
      const ext = String(row.source_external_id || '');
      const scoped = String(row.source_scope || 'things_today') === 'things_today';
      if (!ext || seen.has(ext) || !scoped) continue;
      if (String(row.source_status) === 'out_of_scope') continue;
      productivity.markThingsOutOfScope([Number(row.id)]);
    }
  } else if (things.length === 0) {
    productivity.markThingsStale();
  }
  return { created, updated };
}

export async function previewSync(deps: SyncDeps = {}) {
  const before = productivity.snapshotRowHashes();
  const collected = await collectStandardizedItems(deps, { persistCheckpoints: false });
  const thingsItems = collected.items.filter((i) => i.sourceType === 'things');
  const unstructured = collected.items.filter((i) => i.sourceType === 'feishu_message' || i.sourceType === 'desktop');
  const after = productivity.snapshotRowHashes();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR, '预览产生了写入');
  }
  return {
    write: false,
    itemsSeen: collected.items.length,
    thingsCount: thingsItems.length,
    appleCount: 0,
    pendingAnalysis: unstructured.length,
    cacheHits: 0,
    deferred: unstructured.length,
    candidateCount: 0,
    candidates: [] as unknown[],
    connectorErrors: collected.connectorErrors,
    hashes: after,
    receipt: `Things ${thingsItems.length} 条 · Apple 预览不读权限 · 待分析 ${unstructured.length} 条（预览不调用模型）`,
  };
}

function appleReceiptLine(input: { ok: boolean; count: number; errorCode?: string | null }): string {
  if (input.ok) return `Apple ${input.count} 场`;
  if (input.errorCode === PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR) return 'Apple Calendar 未同步：参数协议错误';
  if (input.errorCode === PRODUCTIVITY_ERROR_CODES.CALENDAR_HELPER_STALE) return 'Apple Calendar 未同步：helper 过期';
  return 'Apple Calendar 未同步：需要完整访问权限';
}

function calendarUserMessage(errorCode?: string | null, fallback?: string | null): string {
  if (errorCode === PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR) return 'Apple Calendar 未同步：参数协议错误';
  if (errorCode === PRODUCTIVITY_ERROR_CODES.CALENDAR_HELPER_STALE) return 'Apple Calendar 未同步：helper 过期';
  return fallback || 'Apple Calendar 未同步：需要完整访问权限';
}

function persistCalendarCheckpoint(agenda: {
  ok: boolean;
  events: { length: number };
  busyStatus: string;
  permission: string;
  helperVersion: string;
  errorCode: string | null;
}): void {
  recordCalendarConnectorRound({
    ok: agenda.ok,
    events: agenda.events.length,
    busyStatus: agenda.busyStatus,
    permission: agenda.permission,
    helperVersion: agenda.helperVersion,
    errorCode: agenda.errorCode,
  });
}

export function getSyncRunPublic(id: number): CommitSyncResult | null {
  const row = productivity.getSyncRun(id);
  if (!row) return null;
  let parsed: Record<string, unknown> = {};
  if (row.result_json) {
    try {
      const value = JSON.parse(row.result_json);
      parsed = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    } catch {
      parsed = {};
    }
  }
  const connectorErrors = Array.isArray(parsed.connectorErrors) ? parsed.connectorErrors as ConnectorErrorItem[] : [];
  const ai = parsed.ai && typeof parsed.ai === 'object'
    ? parsed.ai as CommitSyncResult['ai']
    : {
      inputUnits: 0,
      cacheHits: 0,
      calls: 0,
      actionable: 0,
      review: 0,
      rejected: 0,
      deferred: 0,
      waitingForAi: false,
    };
  return {
    runId: row.id,
    status: row.status,
    created: Number(parsed.created ?? row.items_created ?? 0),
    updated: Number(parsed.updated ?? row.items_updated ?? 0),
    itemsSeen: Number(parsed.itemsSeen ?? row.items_seen ?? 0),
    candidateCount: Number(parsed.candidateCount ?? 0),
    candidates: [],
    connectorErrors,
    ai,
    appleCount: Number(parsed.appleCount ?? 0),
    receipt: typeof parsed.receipt === 'string' ? parsed.receipt : '',
    write: true,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function startCommitSync(deps: SyncDeps = {}): { runId: number; status: 'running' } {
  if (activeRunId != null && activePromise) {
    return { runId: activeRunId, status: 'running' };
  }
  const runId = productivity.startSyncRun('all');
  activeRunId = runId;
  activePromise = runCommitSync(runId, deps).finally(() => {
    if (activeRunId === runId) {
      activeRunId = null;
      activePromise = null;
    }
  });
  return { runId, status: 'running' };
}

export async function commitSync(deps: SyncDeps = {}): Promise<CommitSyncResult> {
  const started = startCommitSync(deps);
  if (activePromise) return activePromise;
  const dto = getSyncRunPublic(started.runId);
  if (!dto) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR, '同步记录不存在');
  }
  return dto;
}

async function runCommitSync(runId: number, deps: SyncDeps = {}): Promise<CommitSyncResult> {
  const flags = settingsFlags();
  if (deps.desktopOnly) {
    flags.thingsEnabled = false;
    flags.feishuEnabled = false;
    flags.calendarEnabled = false;
  }
  try {
    const collected = await collectStandardizedItems(deps, { persistCheckpoints: false });
    const connectorErrors: ConnectorErrorItem[] = [...collected.connectorErrors];
    if (flags.desktopEnabled) {
      productivity.recordConnectorRound('desktop', {
        ok: !connectorErrors.some((e) => e.connector === 'desktop'),
        roundCount: Number(collected.extras.desktopCount || 0),
        extra: { fileCount: collected.extras.desktopCount || 0 },
      });
    }
    if (flags.thingsEnabled) {
      productivity.recordConnectorRound('things', {
        ok: collected.extras.thingsOk === true,
        roundCount: Number(collected.extras.thingsCount || 0),
        extra: collected.extras.thingsOk === true
          ? { snapshotComplete: collected.thingsSnapshotComplete, itemsSeen: collected.extras.thingsCount || 0, scope: 'today' }
          : {},
      });
    }
    if (flags.feishuEnabled) {
      productivity.recordConnectorRound('feishu', {
        ok: collected.extras.feishuOk === true,
        roundCount: Number(collected.extras.feishuCount || 0),
        errorCode: collected.extras.feishuErrorCode ? String(collected.extras.feishuErrorCode) : null,
        extra: {
          identity: collected.extras.feishuIdentity,
          tokenStatus: collected.extras.feishuTokenStatus,
          ...(collected.extras.feishuOk === true ? { chatCount: collected.extras.feishuChatCount } : {}),
          hasCurrentUserId: collected.extras.feishuHasCurrentUserId === true,
          chatsRead: Number(collected.extras.feishuChatsRead || 0),
          chatsFailed: Number(collected.extras.feishuChatsFailed || 0),
          truncatedChats: Number(collected.extras.feishuTruncatedChats || 0),
          lastRoundPartial: collected.extras.feishuPartial === true,
        },
      });
    }
    let created = 0;
    let updated = 0;
    const thingsOk = collected.extras.thingsOk !== false && flags.thingsEnabled;
    if (thingsOk) {
      const r = applyThings(collected.items, collected.thingsSnapshotComplete, 'today');
      created += r.created;
      updated += r.updated;
      const patch = collected.checkpointPatches.find((p) => p.connector === 'things');
      if (patch) productivity.saveCheckpoint(patch.connector, patch.config, patch.cursor);
    }

    let appleCount = 0;
    let appleOk = true;
    let appleErrorCode: string | null = null;
    if (flags.calendarEnabled && deps.persistAgenda !== false) {
      try {
        const agenda = await syncAppleAgenda({
          runner: deps.calendarRunner,
          requestAccess: false,
          persist: true,
        });
        persistCalendarCheckpoint(agenda);
        appleOk = agenda.ok;
        appleErrorCode = agenda.ok ? null : agenda.errorCode;
        appleCount = agenda.ok ? agenda.events.length : 0;
        if (!agenda.ok) {
          connectorErrors.push({
            connector: 'calendar',
            code: agenda.errorCode || PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED,
            message: calendarUserMessage(agenda.errorCode, agenda.errorMessage),
          });
        }
      } catch (e) {
        appleOk = false;
        appleErrorCode = e instanceof ProductivityError ? e.code : PRODUCTIVITY_ERROR_CODES.CALENDAR_PERMISSION_DENIED;
        const message = calendarUserMessage(appleErrorCode, e instanceof Error ? e.message : null);
        connectorErrors.push({ connector: 'calendar', code: appleErrorCode, message });
        persistCalendarCheckpoint({
          ok: false,
          events: [],
          busyStatus: 'unknown',
          permission: 'unknown',
          helperVersion: '',
          errorCode: appleErrorCode,
        });
        productivity.commitAgendaProvider({
          provider: 'apple',
          events: [],
          fromAt: new Date().toISOString(),
          toAt: new Date().toISOString(),
          timezone: String(getSettings().timezone || 'Asia/Shanghai'),
          complete: false,
          status: 'partial',
          errorCode: appleErrorCode,
        });
      }
    }

    if (flags.feishuEnabled) {
      const feishuEvents = (collected.extras.feishuEvents || []) as StandardizedItem[];
      const complete = collected.extras.feishuOk === true && collected.extras.feishuPartial !== true;
      const mapped = [];
      for (const item of feishuEvents) {
        const start = String(item.payload.start || item.createdAt || '');
        const end = String(item.payload.end || item.dueAt || '');
        if (!start || !end) continue;
        try {
          mapped.push({
            canonicalEventKey: canonicalEventKey({
              provider: 'feishu',
              calendarIdentifier: 'feishu',
              eventIdentifier: item.sourceExternalId,
              occurrenceStartAt: start,
            }),
            eventIdentifier: item.sourceExternalId,
            occurrenceStartAt: start,
            startAt: start,
            endAt: end,
            title: item.title,
          });
        } catch {
          /* skip events without stable times */
        }
      }
      persistFeishuAgenda(mapped, {
        fromAt: new Date(Date.now() - 7 * 86400000).toISOString(),
        toAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        timezone: String(getSettings().timezone || 'Asia/Shanghai'),
        complete,
        status: complete ? 'ok' : 'partial',
        errorCode: complete ? null : PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
      });
    }

    const desktopPatch = collected.checkpointPatches.find((p) => p.connector === 'desktop');
    if (desktopPatch) productivity.saveCheckpoint(desktopPatch.connector, desktopPatch.config, desktopPatch.cursor);

    const includeAi = deps.includeAi ?? (flags.aiAnalysisEnabled && (deps.aiEnabled || flags.aiAnalysisEnabled));
    let aiStats = {
      inputUnits: 0,
      cacheHits: 0,
      calls: 0,
      actionable: 0,
      review: 0,
      rejected: 0,
      deferred: 0,
      waitingForAi: false,
      errorCode: undefined as string | undefined,
    };
    const unstructured = collected.items.filter((i) => i.sourceType === 'feishu_message' || i.sourceType === 'desktop');
    if (includeAi && unstructured.length) {
      const stats = await analyzeUnstructuredSources(unstructured, deps);
      aiStats = {
        inputUnits: stats.inputUnits,
        cacheHits: stats.cacheHits,
        calls: stats.calls,
        actionable: stats.actionable,
        review: stats.review,
        rejected: stats.rejected,
        deferred: stats.deferred,
        waitingForAi: stats.waitingForAi,
        errorCode: stats.errorCode,
      };
      created += stats.createdTodoIds.length;
      updated += stats.updatedTodoIds.length;
      if (!stats.waitingForAi && !stats.errorCode) {
        const feishuPatch = collected.checkpointPatches.find((p) => p.connector === 'feishu');
        const desktopAiPatch = collected.checkpointPatches.find((p) => p.connector === 'desktop');
        if (feishuPatch) productivity.saveCheckpoint(feishuPatch.connector, feishuPatch.config, feishuPatch.cursor);
        if (desktopAiPatch) productivity.saveCheckpoint(desktopAiPatch.connector, desktopAiPatch.config, desktopAiPatch.cursor);
      }
    } else if (unstructured.length) {
      aiStats.deferred = unstructured.length;
      aiStats.waitingForAi = true;
    }

    const status = connectorErrors.length || aiStats.errorCode || aiStats.waitingForAi || aiStats.deferred ? 'partial' : 'ok';
    const applePart = flags.calendarEnabled && deps.persistAgenda !== false
      ? appleReceiptLine({ ok: appleOk, count: appleCount, errorCode: appleErrorCode })
      : 'Apple 预览不读权限';
    const receipt = `Things ${collected.extras.thingsCount ?? 0} 条 · ${applePart} · AI 分析 ${aiStats.inputUnits} 条 → 待办 ${aiStats.actionable} / 复核 ${aiStats.review} / 忽略 ${aiStats.rejected} · 缓存命中 ${aiStats.cacheHits}`;
    const result: CommitSyncResult = {
      runId,
      status,
      created,
      updated,
      itemsSeen: collected.items.length,
      candidateCount: aiStats.actionable,
      candidates: [],
      connectorErrors,
      ai: aiStats,
      appleCount,
      receipt,
      write: true,
      errorCode: connectorErrors[0]?.code ?? aiStats.errorCode ?? null,
      errorMessage: connectorErrors[0]?.message ?? null,
    };
    productivity.finishSyncRun(runId, {
      status,
      items_seen: collected.items.length,
      items_created: created,
      items_updated: updated,
      error_code: result.errorCode ?? null,
      error_message: result.errorMessage ? redactText(result.errorMessage, 160) : null,
      result_json: JSON.stringify({
        created,
        updated,
        itemsSeen: collected.items.length,
        candidateCount: aiStats.actionable,
        connectorErrors,
        ai: aiStats,
        appleCount,
        receipt,
      }),
    });
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : '同步失败';
    const errorCode = e instanceof ProductivityError ? e.code : 'INTERNAL_ERROR';
    productivity.finishSyncRun(runId, {
      status: 'error',
      error_code: errorCode,
      error_message: redactText(message, 160),
      result_json: JSON.stringify({ receipt: '', connectorErrors: [], appleCount: 0 }),
    });
    throw e;
  }
}

export async function commitDesktopScan(deps: SyncDeps = {}, entries?: import('../scanner').DesktopCollectedEntry[]) {
  return commitSync({
    ...deps,
    includeAi: settingsFlags().aiAnalysisEnabled,
    desktopOnly: true,
    desktopCollect: entries ? () => entries : deps.desktopCollect,
  });
}

export function mapTodoRow(row: TodoRow) {
  return publicTodoDto(row as unknown as Record<string, unknown>);
}

export { WORKBENCH_CALENDAR_NAME };
