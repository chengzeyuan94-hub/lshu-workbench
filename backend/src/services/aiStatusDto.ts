import { workbenchRuntimeStamp } from './runtimeStamp';

export interface AiRunStatusDto {
  calls: number;
  retries: number;
  inputUnits: number;
  actionable: number;
  review: number;
  rejected: number;
  deferred: number;
  cacheHits: number;
  invalidCacheEntries: number;
  promptTokens: number;
  completionTokens: number;
  errorCode: string | null;
  startedAt: string | null;
  status: string | null;
  httpAttempts: number;
  apiSuccess: number;
  jsonParseSuccess: number;
  schemaSuccess: number;
  schemaFailedBatches: number;
  repairAttempts: number;
  deferredByOverflow: number;
  deferredBySchema: number;
  schemaErrorCategories: string[];
  promptVersion: string | null;
  schemaVersion: string | null;
  feishuInputCount: number;
  desktopInputCount: number;
  deferredReasons: { overflow: number; schema: number };
}

export interface AiStatusDto extends AiRunStatusDto {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  model: string;
  lastRun: AiRunStatusDto | null;
  runtimeBuildId: string;
  runtimePromptVersion: string;
  runtimeSchemaVersion: string;
  runtimeHubVersion: string;
  lastRunMatchesRuntime: boolean | null;
}

function asNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asNullableString(value: unknown): string | null {
  if (value == null || value === '') return null;
  return String(value);
}

function parseStatsJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function mapAiRunRow(row: Record<string, unknown> | null | undefined): AiRunStatusDto | null {
  if (!row) return null;
  const extra = parseStatsJson(row.stats_json ?? row.statsJson);
  const categories = Array.isArray(extra.errorCategories)
    ? extra.errorCategories.map((c) => String(c))
    : [];
  return {
    calls: asNumber(row.calls),
    retries: asNumber(row.retries),
    inputUnits: asNumber(row.input_units ?? row.inputUnits),
    actionable: asNumber(row.actionable),
    review: asNumber(row.review),
    rejected: asNumber(row.rejected),
    deferred: asNumber(row.deferred),
    cacheHits: asNumber(row.cache_hits ?? row.cacheHits ?? extra.cacheHits),
    invalidCacheEntries: asNumber(extra.invalidCacheEntries),
    promptTokens: asNumber(row.prompt_tokens ?? row.promptTokens),
    completionTokens: asNumber(row.completion_tokens ?? row.completionTokens),
    errorCode: asNullableString(row.error_code ?? row.errorCode),
    startedAt: asNullableString(row.started_at ?? row.startedAt),
    status: asNullableString(row.status),
    httpAttempts: asNumber(extra.httpAttempts ?? row.calls),
    apiSuccess: asNumber(extra.apiSuccess),
    jsonParseSuccess: asNumber(extra.jsonParseSuccess),
    schemaSuccess: asNumber(extra.schemaSuccess),
    schemaFailedBatches: asNumber(extra.schemaFailedBatches),
    repairAttempts: asNumber(extra.repairAttempts),
    deferredByOverflow: asNumber(extra.deferredByOverflow),
    deferredBySchema: asNumber(extra.deferredBySchema),
    schemaErrorCategories: categories,
    promptVersion: asNullableString(extra.promptVersion),
    schemaVersion: asNullableString(extra.schemaVersion),
    feishuInputCount: asNumber(extra.feishuInputCount),
    desktopInputCount: asNumber(extra.desktopInputCount),
    deferredReasons: {
      overflow: asNumber((extra.deferredReasons as Record<string, unknown> | undefined)?.overflow ?? extra.deferredByOverflow),
      schema: asNumber((extra.deferredReasons as Record<string, unknown> | undefined)?.schema ?? extra.deferredBySchema),
    },
  };
}

export function buildAiStatusDto(input: {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  model: string;
  lastRun: Record<string, unknown> | null | undefined;
}): AiStatusDto {
  const lastRun = mapAiRunRow(input.lastRun ?? undefined);
  const runtime = workbenchRuntimeStamp();
  const lastRunMatchesRuntime = lastRun
    ? lastRun.promptVersion === runtime.promptVersion && lastRun.schemaVersion === runtime.schemaVersion
    : null;
  return {
    configured: input.configured,
    enabled: input.enabled,
    running: input.running,
    model: input.model,
    calls: lastRun?.calls ?? 0,
    retries: lastRun?.retries ?? 0,
    inputUnits: lastRun?.inputUnits ?? 0,
    actionable: lastRun?.actionable ?? 0,
    review: lastRun?.review ?? 0,
    rejected: lastRun?.rejected ?? 0,
    deferred: lastRun?.deferred ?? 0,
    cacheHits: lastRun?.cacheHits ?? 0,
    invalidCacheEntries: lastRun?.invalidCacheEntries ?? 0,
    promptTokens: lastRun?.promptTokens ?? 0,
    completionTokens: lastRun?.completionTokens ?? 0,
    errorCode: lastRun?.errorCode ?? null,
    startedAt: lastRun?.startedAt ?? null,
    status: lastRun?.status ?? null,
    httpAttempts: lastRun?.httpAttempts ?? 0,
    apiSuccess: lastRun?.apiSuccess ?? 0,
    jsonParseSuccess: lastRun?.jsonParseSuccess ?? 0,
    schemaSuccess: lastRun?.schemaSuccess ?? 0,
    schemaFailedBatches: lastRun?.schemaFailedBatches ?? 0,
    repairAttempts: lastRun?.repairAttempts ?? 0,
    deferredByOverflow: lastRun?.deferredByOverflow ?? 0,
    deferredBySchema: lastRun?.deferredBySchema ?? 0,
    schemaErrorCategories: lastRun?.schemaErrorCategories ?? [],
    promptVersion: lastRun?.promptVersion ?? null,
    schemaVersion: lastRun?.schemaVersion ?? null,
    feishuInputCount: lastRun?.feishuInputCount ?? 0,
    desktopInputCount: lastRun?.desktopInputCount ?? 0,
    deferredReasons: lastRun?.deferredReasons ?? { overflow: 0, schema: 0 },
    lastRun,
    runtimeBuildId: runtime.buildId,
    runtimePromptVersion: runtime.promptVersion,
    runtimeSchemaVersion: runtime.schemaVersion,
    runtimeHubVersion: runtime.hubVersion,
    lastRunMatchesRuntime,
  };
}

export function formatAiRunSummary(run: {
  actionable?: number;
  review?: number;
  rejected?: number;
  schemaFailedBatches?: number;
  deferred?: number;
}): string {
  const analyzed = Number(run.actionable || 0) + Number(run.review || 0) + Number(run.rejected || 0);
  return `成功分析 ${analyzed} · 非待办 ${Number(run.rejected || 0)} · 格式失败 ${Number(run.schemaFailedBatches || 0)} 批 · 延后 ${Number(run.deferred || 0)}`;
}
