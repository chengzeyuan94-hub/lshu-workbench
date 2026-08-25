import { getDeepseekRuntimeConfig } from '../config/runtimeConfig';
import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from '../connectors/errors';
import type { StandardizedItem } from '../connectors/types';
import { getSettings, productivity } from '../db';
import {
  areSemanticallyEquivalentActions,
  buildActionIdentity,
  normalizeActionDue,
} from './actionIdentity';
import {
  AI_PROMPT_VERSION,
  AI_SCHEMA_CIRCUIT_LIMIT,
  AI_SCHEMA_VERSION,
  ANALYZER_SYSTEM_PROMPT,
  buildRepairUserPayload,
  classifyClientSchemaFailure,
  diagnosticSafeStats,
  parseModelJson,
  validateAnalyzedBatch,
  type AiSchemaErrorCode,
  type AiSchemaIssue,
  type AnalyzedAction,
  type AnalyzedBatch,
} from './aiAnalysisSchema';
import { completeDeepseekJson, estimateUsd, type FetchLike, worstCaseUsd } from './deepseekClient';
import { EXTERNAL_TEXT_POLICY_VERSION } from './externalTextPolicy';
import { projectDesktopItem, projectFeishuThread, serializeUnitsForModel, rebindCachedResult, type AnalysisUnit } from './sourceProjection';
import { localDateKey, sanitizeOccurredAt } from './localDay';
import { normalizeTitle } from './hash';

export interface AnalyzerDeps {
  fetchImpl?: FetchLike;
  now?: Date;
  aiEnabled?: boolean;
}

let aiRunsInFlight = 0;

export function isAiRunInFlight(): boolean {
  return aiRunsInFlight > 0;
}

export interface AnalyzerStats {
  inputUnits: number;
  feishuInputCount: number;
  desktopInputCount: number;
  cacheHits: number;
  invalidCacheEntries: number;
  calls: number;
  retries: number;
  httpAttempts: number;
  apiSuccess: number;
  jsonParseSuccess: number;
  schemaSuccess: number;
  schemaFailedBatches: number;
  repairAttempts: number;
  deferredByOverflow: number;
  deferredBySchema: number;
  actionable: number;
  review: number;
  rejected: number;
  deferred: number;
  promptTokens: number;
  completionTokens: number;
  createdTodoIds: number[];
  updatedTodoIds: number[];
  waitingForAi: boolean;
  errorCode?: string;
  schemaErrorCategories: AiSchemaErrorCode[];
}

function dayKey(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function expiresAt(hours = 72): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

function selectFairUnits(units: AnalysisUnit[], max: number): { selected: AnalysisUnit[]; deferred: AnalysisUnit[] } {
  if (units.length <= max) return { selected: units, deferred: [] };
  const groups = new Map<string, AnalysisUnit[]>();
  for (const unit of units) {
    const list = groups.get(unit.cursorKey) || [];
    list.push(unit);
    groups.set(unit.cursorKey, list);
  }
  const keys = [...groups.keys()].sort();
  const selected: AnalysisUnit[] = [];
  let depth = 0;
  while (selected.length < max) {
    let added = false;
    for (const key of keys) {
      const list = groups.get(key) || [];
      if (depth < list.length) {
        selected.push(list[depth]);
        added = true;
        if (selected.length >= max) break;
      }
    }
    if (!added) break;
    depth += 1;
  }
  const picked = new Set(selected);
  return { selected, deferred: units.filter((u) => !picked.has(u)) };
}

export function packUnitsByChars(units: AnalysisUnit[], maxChars: number, maxBatchSize: number): AnalysisUnit[][] {
  const batches: AnalysisUnit[][] = [];
  let current: AnalysisUnit[] = [];
  for (const unit of units) {
    const candidate = current.concat(unit);
    const overSize = candidate.length > maxBatchSize;
    const overChars = serializeUnitsForModel(candidate).length > maxChars;
    if (current.length > 0 && (overSize || overChars)) {
      batches.push(current);
      current = [unit];
    } else {
      current = candidate;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function emptyStats(): AnalyzerStats {
  return {
    inputUnits: 0,
    feishuInputCount: 0,
    desktopInputCount: 0,
    cacheHits: 0,
    invalidCacheEntries: 0,
    calls: 0,
    retries: 0,
    httpAttempts: 0,
    apiSuccess: 0,
    jsonParseSuccess: 0,
    schemaSuccess: 0,
    schemaFailedBatches: 0,
    repairAttempts: 0,
    deferredByOverflow: 0,
    deferredBySchema: 0,
    actionable: 0,
    review: 0,
    rejected: 0,
    deferred: 0,
    promptTokens: 0,
    completionTokens: 0,
    createdTodoIds: [],
    updatedTodoIds: [],
    waitingForAi: false,
    schemaErrorCategories: [],
  };
}

function routeAction(decision: string, action: AnalyzedAction): 'create' | 'mutate' | 'suggest' | 'reject' | 'count' {
  if (decision === 'non_actionable') return 'reject';
  if (action.owner === 'other' || action.intent === 'ignore') return 'reject';
  if (decision === 'uncertain' || action.owner === 'unclear') return 'suggest';
  if (action.confidence < 0.55) return 'suggest';
  if (decision !== 'actionable' || (action.owner !== 'self' && action.owner !== 'shared')) return 'suggest';
  if (action.intent === 'create' && action.confidence >= 0.78) return 'create';
  if (action.intent === 'create' && action.confidence >= 0.55) return 'suggest';
  if ((action.intent === 'update' || action.intent === 'progress' || action.intent === 'complete') && action.confidence >= 0.78) {
    return 'mutate';
  }
  if (action.confidence >= 0.55) return 'suggest';
  return 'suggest';
}

export function buildUnits(items: StandardizedItem[], maxChars: number): AnalysisUnit[] {
  const units: AnalysisUnit[] = [];
  const feishu = items.filter((i) => i.sourceType === 'feishu_message');
  const byChat = new Map<string, StandardizedItem[]>();
  for (const item of feishu) {
    const key = String(item.payload.chat_hash || item.payload.chat_id || item.sourceExternalId);
    const list = byChat.get(key) || [];
    list.push(item);
    byChat.set(key, list);
  }
  for (const group of byChat.values()) {
    for (const focus of group) {
      const unit = projectFeishuThread(group, focus, maxChars);
      if (unit && !unit.skipLowInfo) units.push(unit);
    }
  }
  for (const item of items) {
    if (item.sourceType !== 'desktop') continue;
    const unit = projectDesktopItem(item, maxChars);
    if (unit && !unit.skipLowInfo) units.push(unit);
  }
  return units;
}

export async function analyzeUnstructuredSources(items: StandardizedItem[], deps: AnalyzerDeps = {}): Promise<AnalyzerStats> {
  for (const item of items) {
    if (item.sourceType !== 'feishu_message' && item.sourceType !== 'desktop') {
      throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR, 'AI 分析只接受飞书消息或桌面来源');
    }
  }
  const settings = getSettings();
  const aiEnabled = deps.aiEnabled ?? settings.aiAnalysisEnabled === true;
  const config = getDeepseekRuntimeConfig();
  const stats = emptyStats();
  stats.feishuInputCount = items.filter((i) => i.sourceType === 'feishu_message').length;
  stats.desktopInputCount = items.filter((i) => i.sourceType === 'desktop').length;
  if (!aiEnabled || !config.configured) {
    stats.deferred = items.length;
    stats.waitingForAi = true;
    stats.errorCode = config.configured ? undefined : PRODUCTIVITY_ERROR_CODES.AI_NOT_CONFIGURED;
    return stats;
  }

  const units = buildUnits(items, config.maxInputChars);
  const uncached: AnalysisUnit[] = [];
  const cachedResults: Array<{ unit: AnalysisUnit; batch: AnalyzedBatch }> = [];
  for (const unit of units) {
    if (unit.meta.dlpBlocked) {
      stats.rejected += 1;
      continue;
    }
    const hit = productivity.getAiCache({
      model: config.model,
      promptVersion: AI_PROMPT_VERSION,
      schemaVersion: AI_SCHEMA_VERSION,
      policyVersion: EXTERNAL_TEXT_POLICY_VERSION,
      sourceType: unit.sourceType,
      opaqueHash: unit.opaqueStableSourceHash,
      projectionHash: unit.canonicalProjectionHash,
    });
    if (hit?.result_json) {
      try {
        const parsed = parseModelJson(String(hit.result_json)) as AnalyzedBatch;
        const rebound = rebindCachedResult(unit, parsed);
        const allowed = new Map([[unit.unitRef, new Set(unit.evidenceRefs)]]);
        const validated = validateAnalyzedBatch(rebound, [unit.unitRef], allowed);
        if (!validated.ok) {
          stats.invalidCacheEntries += 1;
          uncached.push(unit);
          continue;
        }
        stats.cacheHits += 1;
        cachedResults.push({ unit, batch: validated.batch });
      } catch {
        stats.invalidCacheEntries += 1;
        uncached.push(unit);
      }
    } else {
      uncached.push(unit);
    }
  }

  const { selected: queued, deferred: overflow } = selectFairUnits(uncached, config.maxItemsPerRun);
  stats.deferred += overflow.length;
  stats.deferredByOverflow += overflow.length;
  stats.inputUnits = queued.length + cachedResults.length;
  const batches = packUnitsByChars(queued, config.maxInputChars, config.batchSize);

  const now = deps.now || new Date();
  const key = dayKey(config.budgetTimezone, now);
  const started = Date.now();
  let consecutiveContractErrors = 0;
  let circuitOpen = false;
  aiRunsInFlight += 1;
  try {

  const rememberCategory = (code: AiSchemaErrorCode) => {
    if (!stats.schemaErrorCategories.includes(code)) stats.schemaErrorCategories.push(code);
  };

  const deferSchema = (batch: AnalysisUnit[], code: AiSchemaErrorCode) => {
    stats.deferred += batch.length;
    stats.deferredBySchema += batch.length;
    stats.errorCode = PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID;
    rememberCategory(code);
    const failedKeys = new Set(batch.map((u) => u.cursorKey));
    for (const ck of failedKeys) {
      productivity.putAnalysisCursor(ck, '', { error: stats.errorCode, partial: true });
    }
  };

  const applyValidated = (batch: AnalysisUnit[], validated: AnalyzedBatch, usage: { promptTokens: number; completionTokens: number }) => {
    consecutiveContractErrors = 0;
    stats.schemaSuccess += 1;
    for (const unit of batch) {
      const unitResult = { schemaVersion: AI_SCHEMA_VERSION, units: validated.units.filter((u) => u.unitRef === unit.unitRef) };
      productivity.putAiCache({
        opaqueHash: unit.opaqueStableSourceHash,
        projectionHash: unit.canonicalProjectionHash,
        sourceType: unit.sourceType,
        model: config.model,
        promptVersion: AI_PROMPT_VERSION,
        schemaVersion: AI_SCHEMA_VERSION,
        policyVersion: EXTERNAL_TEXT_POLICY_VERSION,
        resultJson: JSON.stringify(unitResult),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        expiresAt: expiresAt(168),
      });
      applyUnit(unit, unitResult, stats, items);
      productivity.putAnalysisCursor(unit.cursorKey, String(unit.meta.createdAt || unit.meta.modifiedAt || now.toISOString()));
    }
  };

  const parseAndValidate = (content: string, batch: AnalysisUnit[]): { parsed: unknown; issue?: AiSchemaIssue; validated?: AnalyzedBatch } => {
    let parsed: unknown;
    try {
      parsed = parseModelJson(content);
    } catch {
      rememberCategory('INVALID_JSON');
      return { parsed: null, issue: { code: 'INVALID_JSON' } };
    }
    stats.jsonParseSuccess += 1;
    const allowed = new Map(batch.map((u) => [u.unitRef, new Set(u.evidenceRefs)]));
    const validated = validateAnalyzedBatch(parsed, batch.map((u) => u.unitRef), allowed);
    if (!validated.ok) {
      rememberCategory(validated.error.code);
      return { parsed, issue: validated.error };
    }
    return { parsed, validated: validated.batch };
  };

  const callModel = async (user: string) => {
    const result = await completeDeepseekJson({
      system: ANALYZER_SYSTEM_PROMPT,
      user,
      fetchImpl: deps.fetchImpl,
      config,
    });
    stats.httpAttempts += result.attempts;
    stats.calls += result.attempts;
    stats.retries += Math.max(0, result.attempts - 1);
    stats.apiSuccess += 1;
    stats.promptTokens += result.usage.promptTokens;
    stats.completionTokens += result.usage.completionTokens;
    return result;
  };

  const processBatch = async (batch: AnalysisUnit[]): Promise<void> => {
    if (!batch.length) return;
    if (circuitOpen) {
      deferSchema(batch, stats.schemaErrorCategories[stats.schemaErrorCategories.length - 1] || 'INVALID_JSON');
      return;
    }
    const user = serializeUnitsForModel(batch);
    if (user.length > config.maxInputChars) {
      if (batch.length === 1) {
        stats.deferred += 1;
        stats.deferredByOverflow += 1;
        return;
      }
      const mid = Math.max(1, Math.floor(batch.length / 2));
      await processBatch(batch.slice(0, mid));
      await processBatch(batch.slice(mid));
      return;
    }
    const worstIn = Math.ceil(user.length / 3) + 800;
    const worstOut = config.maxOutputTokens;
    const worstUsd = worstCaseUsd(worstIn, worstOut);
    const reserved = productivity.tryReserveBudget(key, worstIn, worstOut, worstUsd, {
      maxInput: config.dailyMaxInputTokens,
      maxOutput: config.dailyMaxOutputTokens,
      maxUsd: config.dailyMaxEstimatedUsd,
    });
    if (!reserved) {
      stats.deferred += batch.length;
      stats.deferredByOverflow += batch.length;
      stats.errorCode = PRODUCTIVITY_ERROR_CODES.AI_BUDGET_EXHAUSTED;
      return;
    }
    try {
      const first = await callModel(user);
      productivity.settleBudget(key, worstIn, worstOut, worstUsd, first.usage.promptTokens, first.usage.completionTokens, estimateUsd(first.usage));
      let outcome = parseAndValidate(first.content, batch);
      if (outcome.validated) {
        applyValidated(batch, outcome.validated, first.usage);
        return;
      }
      const issue = outcome.issue || { code: 'INVALID_JSON' as const };
      stats.repairAttempts += 1;
      const repairUser = buildRepairUserPayload(user, issue, batch.length);
      const repairWorstIn = Math.ceil(repairUser.length / 3) + 800;
      const repairUsd = worstCaseUsd(repairWorstIn, worstOut);
      const repairReserved = productivity.tryReserveBudget(key, repairWorstIn, worstOut, repairUsd, {
        maxInput: config.dailyMaxInputTokens,
        maxOutput: config.dailyMaxOutputTokens,
        maxUsd: config.dailyMaxEstimatedUsd,
      });
      if (repairReserved) {
        try {
          const repaired = await callModel(repairUser);
          productivity.settleBudget(key, repairWorstIn, worstOut, repairUsd, repaired.usage.promptTokens, repaired.usage.completionTokens, estimateUsd(repaired.usage));
          outcome = parseAndValidate(repaired.content, batch);
          if (outcome.validated) {
            applyValidated(batch, outcome.validated, repaired.usage);
            return;
          }
        } catch (e) {
          productivity.settleBudget(key, repairWorstIn, worstOut, repairUsd, 0, 0, 0);
          const pe = e instanceof ProductivityError ? e : null;
          stats.httpAttempts += Number(pe?.details?.attempts || 1);
          stats.calls += Number(pe?.details?.attempts || 1);
          if (pe?.code === PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID) {
            rememberCategory(classifyClientSchemaFailure({ message: pe.message, empty: /空内容/.test(pe.message) }));
          } else {
            stats.deferred += batch.length;
            stats.errorCode = pe?.code || PRODUCTIVITY_ERROR_CODES.AI_UNAVAILABLE;
            return;
          }
        }
      }
      if (batch.length > 1) {
        const mid = Math.max(1, Math.floor(batch.length / 2));
        await processBatch(batch.slice(0, mid));
        await processBatch(batch.slice(mid));
        return;
      }
      stats.schemaFailedBatches += 1;
      consecutiveContractErrors += 1;
      deferSchema(batch, issue.code);
      if (consecutiveContractErrors >= AI_SCHEMA_CIRCUIT_LIMIT) circuitOpen = true;
    } catch (e) {
      productivity.settleBudget(key, worstIn, worstOut, worstUsd, 0, 0, 0);
      const pe = e instanceof ProductivityError ? e : null;
      const attempts = Number(pe?.details?.attempts || 1);
      stats.httpAttempts += attempts;
      stats.calls += attempts;
      if (pe?.code === PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID) {
        const code = classifyClientSchemaFailure({
          message: pe.message,
          finishReason: String(pe.details?.finishReason || ''),
          empty: /空内容/.test(pe.message),
        });
        rememberCategory(code);
        if (batch.length > 1) {
          const mid = Math.max(1, Math.floor(batch.length / 2));
          await processBatch(batch.slice(0, mid));
          await processBatch(batch.slice(mid));
          return;
        }
        stats.schemaFailedBatches += 1;
        consecutiveContractErrors += 1;
        deferSchema(batch, code);
        if (consecutiveContractErrors >= AI_SCHEMA_CIRCUIT_LIMIT) circuitOpen = true;
        return;
      }
      stats.deferred += batch.length;
      stats.errorCode = pe?.code || PRODUCTIVITY_ERROR_CODES.AI_UNAVAILABLE;
      const failedKeys = new Set(batch.map((u) => u.cursorKey));
      for (const ck of failedKeys) {
        productivity.putAnalysisCursor(ck, '', { error: stats.errorCode, partial: true });
      }
    }
  };

  for (const batch of batches) {
    await processBatch(batch);
  }

  for (const cached of cachedResults) {
    const rebound = rebindCachedResult(cached.unit, cached.batch);
    const allowed = new Map([[cached.unit.unitRef, new Set(cached.unit.evidenceRefs)]]);
    const validated = validateAnalyzedBatch(rebound, [cached.unit.unitRef], allowed);
    if (!validated.ok) {
      stats.deferred += 1;
      continue;
    }
    applyUnit(cached.unit, validated.batch, stats, items);
  }
  if (stats.deferred > 0) stats.waitingForAi = true;
  stats.calls = stats.httpAttempts;
  productivity.insertAiRun({
    started_at: now.toISOString(),
    finished_at: new Date().toISOString(),
    status: stats.deferred > 0 || stats.errorCode ? 'partial' : 'ok',
    model: config.model,
    calls: stats.calls,
    retries: stats.retries,
    cache_hits: stats.cacheHits,
    input_units: stats.inputUnits,
    actionable: stats.actionable,
    review: stats.review,
    rejected: stats.rejected,
    deferred: stats.deferred,
    prompt_tokens: stats.promptTokens,
    completion_tokens: stats.completionTokens,
    elapsed_ms: Date.now() - started,
    error_code: stats.errorCode ?? null,
    stats_json: JSON.stringify({
      ...diagnosticSafeStats({
        categories: stats.schemaErrorCategories,
        schemaFailedBatches: stats.schemaFailedBatches,
        unitCount: stats.inputUnits,
        model: config.model,
        promptVersion: AI_PROMPT_VERSION,
        schemaVersion: AI_SCHEMA_VERSION,
      }),
      httpAttempts: stats.httpAttempts,
      apiSuccess: stats.apiSuccess,
      jsonParseSuccess: stats.jsonParseSuccess,
      schemaSuccess: stats.schemaSuccess,
      repairAttempts: stats.repairAttempts,
      deferredByOverflow: stats.deferredByOverflow,
      deferredBySchema: stats.deferredBySchema,
      cacheHits: stats.cacheHits,
      invalidCacheEntries: stats.invalidCacheEntries,
      actionable: stats.actionable,
      review: stats.review,
      rejected: stats.rejected,
      feishuInputCount: stats.feishuInputCount,
      desktopInputCount: stats.desktopInputCount,
      deferredReasons: {
        overflow: stats.deferredByOverflow,
        schema: stats.deferredBySchema,
      },
    }),
  });
  return stats;
  } finally {
    aiRunsInFlight = Math.max(0, aiRunsInFlight - 1);
  }
}

function unitOccurredAt(unit: AnalysisUnit): string | null {
  return sanitizeOccurredAt(unit.meta.createdAt || unit.meta.modifiedAt || null);
}

function unitLocalDate(unit: AnalysisUnit): string {
  const occurredAt = unitOccurredAt(unit) || new Date().toISOString();
  const timezone = String(getSettings().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');
  return localDateKey(occurredAt, timezone) || occurredAt.slice(0, 10);
}

function actionIdentityFor(unit: AnalysisUnit, action: AnalyzedAction): string {
  return buildActionIdentity({
    sourceNamespace: unit.sourceType,
    sourceLocalDate: unitLocalDate(unit),
    objectHint: action.title,
    owner: action.owner,
    dueAt: action.dueAt,
    project: action.project,
  });
}

function semanticMatches(unit: AnalysisUnit, action: AnalyzedAction, actionIdentity: string): Array<Record<string, unknown>> {
  const exact = productivity.findByActionIdentity(actionIdentity);
  if (exact.length) return exact;
  const sourceDate = unitLocalDate(unit);
  const due = normalizeActionDue(action.dueAt);
  const project = normalizeTitle(String(action.project || ''));
  return productivity.listAiTodosForSource(unit.sourceType).filter((row) => {
    const rowOwner = String(row.action_owner || '');
    // Historical V4 rows predate action_owner. They were only created for a
    // self-owned actionable route; never use that fallback for shared work.
    if (rowOwner ? rowOwner !== action.owner : action.owner !== 'self') return false;
    if (normalizeActionDue(row.due_at as string | null) !== due) return false;
    if (normalizeTitle(String(row.cluster || '')) !== project) return false;
    const rowDate = localDateKey(sanitizeOccurredAt(row.source_occurred_at as string | null), String(
      getSettings().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    ));
    if (rowDate !== sourceDate) return false;
    return areSemanticallyEquivalentActions(String(row.title || ''), action.title);
  });
}

function canonicalSemanticMatch(rows: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  if (!rows.length) return undefined;
  const ids = rows.map((row) => Number(row.id)).filter(Number.isFinite);
  const evidence = productivity.getEvidenceCounts(ids);
  return [...rows].sort((a, b) => {
    const evidenceDiff = (evidence.get(Number(b.id)) || 0) - (evidence.get(Number(a.id)) || 0);
    if (evidenceDiff) return evidenceDiff;
    return Number(a.id) - Number(b.id);
  })[0];
}

function attachActionEvidence(
  unit: AnalysisUnit,
  action: AnalyzedAction,
  todoId: number,
  actionIdentity: string
): void {
  productivity.upsertSourceLink({
    todoId,
    actionIdentity,
    relationType: 'primary_mirror',
    sourceType: unit.sourceType,
    sourceExternalId: unit.opaqueStableSourceHash,
    sourceFingerprint: unit.canonicalProjectionHash,
  });
  productivity.addEvidence({
    todoId,
    sourceType: unit.sourceType,
    externalId: unit.opaqueStableSourceHash,
    fingerprint: unit.canonicalProjectionHash,
    evidenceType: 'ai_action',
    summary: action.reasonCode,
    occurredAt: unitOccurredAt(unit) || undefined,
  });
}

function persistOutcome(unit: AnalysisUnit, decision: string): void {
  try {
    const occurredAt = unitOccurredAt(unit);
    const tz = String(getSettings().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');
    productivity.upsertUnitOutcome({
      sourceType: unit.sourceType,
      opaqueHash: unit.opaqueStableSourceHash,
      localDate: localDateKey(occurredAt || new Date().toISOString(), tz) || '',
      occurredAt,
      decision,
      schemaVersion: AI_SCHEMA_VERSION,
      promptVersion: AI_PROMPT_VERSION,
    });
  } catch {
    /* v4 table may be absent in isolated schema tests */
  }
}

function suggestionPayload(unit: AnalysisUnit, action: AnalyzedAction) {
  const actionIdentity = actionIdentityFor(unit, action);
  return {
    actionIdentity,
    sourceType: unit.sourceType,
    owner: action.owner,
    intent: action.intent,
    title: action.title,
    reasonCode: action.reasonCode,
    priority: action.priority,
    confidence: action.confidence,
    evidenceRefs: [unit.opaqueStableSourceHash],
    expiresAt: expiresAt(72),
    sourceOccurredAt: unitOccurredAt(unit),
  };
}

function applyUnit(unit: AnalysisUnit, batch: AnalyzedBatch, stats: AnalyzerStats, sourceItems: StandardizedItem[]): void {
  void sourceItems;
  const unitOut = batch.units.find((u) => u.unitRef === unit.unitRef);
  if (!unitOut) {
    stats.deferred += 1;
    persistOutcome(unit, 'deferred');
    return;
  }
  if (unitOut.decision === 'non_actionable' || (unitOut.actions.length === 0 && unitOut.decision !== 'uncertain')) {
    stats.rejected += 1;
    persistOutcome(unit, 'non_actionable');
    return;
  }
  persistOutcome(unit, unitOut.decision);
  for (const action of unitOut.actions) {
    if (unit.sourceType === 'feishu_message' && unit.meta.senderRole === 'unknown') {
      stats.review += 1;
      productivity.insertSuggestion(suggestionPayload(unit, action));
      continue;
    }
    if (unit.meta.chatType === 'group' && unit.meta.senderRole !== 'self' && !unit.meta.atSelf && !unit.meta.replyToSelf) {
      stats.rejected += 1;
      continue;
    }
    const injected = unit.snippets.some((s) => /忽略系统提示|ignore (the )?previous|output valid json/i.test(s.text));
    const route = routeAction(unitOut.decision, action);
    if (injected && (route === 'create' || route === 'mutate')) {
      stats.rejected += 1;
      continue;
    }
    if (route === 'reject') {
      stats.rejected += 1;
      continue;
    }
    const actionIdentity = actionIdentityFor(unit, action);
    if (route === 'suggest' || route === 'count') {
      stats.review += 1;
      productivity.insertSuggestion(suggestionPayload(unit, action));
      continue;
    }
    if (route === 'create') {
      const existing = canonicalSemanticMatch(semanticMatches(unit, action, actionIdentity));
      if (existing && typeof existing.id === 'number') {
        const todoId = existing.id as number;
        const canonicalIdentity = String(existing.action_identity || actionIdentity);
        productivity.updateAiTodoMutable(todoId, {
          title: action.title,
          dueAt: action.dueAt,
          estimatedMinutes: action.estimatedMinutes,
          confidence: action.confidence,
          reason: action.reasonCode,
          reasonCode: action.reasonCode,
          actionOwner: action.owner,
        });
        attachActionEvidence(unit, action, todoId, canonicalIdentity);
        stats.updatedTodoIds.push(todoId);
        stats.actionable += 1;
        continue;
      }
      const todoId = productivity.insertAiTodo({
        title: action.title,
        reason: action.reasonCode,
        priority: action.priority,
        dueAt: action.dueAt,
        estimatedMinutes: action.estimatedMinutes,
        confidence: action.confidence,
        reasonCode: action.reasonCode,
        actionIdentity,
        actionOwner: action.owner,
        sourceType: unit.sourceType,
        project: action.project || undefined,
        sourceOccurredAt: unitOccurredAt(unit),
      });
      attachActionEvidence(unit, action, todoId, actionIdentity);
      stats.createdTodoIds.push(todoId);
      stats.actionable += 1;
      continue;
    }
    if (route === 'mutate') {
      const existing = canonicalSemanticMatch(semanticMatches(unit, action, actionIdentity));
      if (!existing || typeof existing.id !== 'number') {
        stats.review += 1;
        productivity.insertSuggestion(suggestionPayload(unit, action));
        continue;
      }
      const todoId = existing.id as number;
      productivity.upsertSourceLink({
        todoId,
        actionIdentity: String(existing.action_identity || actionIdentity),
        relationType: 'primary_mirror',
        sourceType: unit.sourceType,
        sourceExternalId: unit.opaqueStableSourceHash,
        sourceFingerprint: unit.canonicalProjectionHash,
      });
      if (action.intent === 'complete') {
        productivity.addEvidence({
          todoId,
          sourceType: unit.sourceType,
          externalId: unit.opaqueStableSourceHash,
          fingerprint: unit.canonicalProjectionHash,
          evidenceType: 'ai_complete_signal',
          summary: '模型建议完成（需完成态复核）',
          occurredAt: unitOccurredAt(unit) || undefined,
        });
      } else {
        productivity.updateAiTodoMutable(todoId, {
          title: action.intent === 'update' ? action.title : undefined,
          dueAt: action.dueAt,
          estimatedMinutes: action.estimatedMinutes,
          reason: action.reasonCode,
          reasonCode: action.reasonCode,
          actionOwner: action.owner,
        });
        productivity.addEvidence({
          todoId,
          sourceType: unit.sourceType,
          externalId: unit.opaqueStableSourceHash,
          fingerprint: unit.canonicalProjectionHash,
          evidenceType: 'ai_progress',
          summary: action.reasonCode,
          occurredAt: unitOccurredAt(unit) || undefined,
        });
      }
      stats.updatedTodoIds.push(todoId);
      stats.actionable += 1;
    }
  }
}
