import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'wb-v310-schema-'));
process.env.WORKBENCH_DATA_DIR = dbDir;
process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
process.env.DEEPSEEK_DAILY_MAX_ESTIMATED_USD = '1.00';
process.env.VITEST = '1';

const { updateSettings, productivity } = await import('../src/db');
const { analyzeUnstructuredSources, packUnitsByChars, buildUnits } = await import('../src/services/actionIntentAnalyzer');
const { fingerprintSource } = await import('../src/services/hash');
const {
  AI_ACTION_REQUIRED_FIELDS,
  AI_PROMPT_VERSION,
  AI_SCHEMA_VERSION,
  ANALYZER_SYSTEM_PROMPT,
  exampleActionableOutput,
  parseModelJson,
  validateAnalyzedBatch,
} = await import('../src/services/aiAnalysisSchema');
const { projectFeishuThread, serializeUnitsForModel } = await import('../src/services/sourceProjection');
const { EXTERNAL_TEXT_POLICY_VERSION } = await import('../src/services/externalTextPolicy');
const { inspectCalendarReadable, calendarConnectSuccessCopy, calendarStatusCopy } = await import('../src/services/calendarStatus');
const { calendarHelperBuildId } = await import('../src/connectors/eventKit');
const { formatAiRunSummary } = await import('../src/services/aiStatusDto');

afterAll(() => rmSync(dbDir, { recursive: true, force: true }));

function msg(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    sourceType: 'feishu_message' as const,
    sourceExternalId: id,
    sourceFingerprint: fingerprintSource('feishu_message', id),
    title: text.slice(0, 20),
    summary: text,
    status: 'open' as const,
    createdAt: extra.createdAt as string || '2026-08-24T02:00:00.000Z',
    payload: { chat_hash: extra.chat_hash || 'c-schema', senderRole: extra.senderRole || 'other', atSelf: true, chatType: 'p2p', ...extra },
  };
}

function payloadFromInit(init?: RequestInit): { unitRef: string; evidenceRefs: string[]; focusRef: string; isRepair: boolean; unitCount: number; focusText: string } {
  const body = JSON.parse(String(init?.body || '{}'));
  const raw = String(body.messages[1].content || '');
  const json = JSON.parse(raw);
  const isRepair = Boolean(json._repair?.repair);
  const unit = json.units[0];
  const snippets = (unit.snippets || []) as Array<{ ref: string; text?: string; isFocus?: boolean }>;
  const focus = snippets.find((s) => s.isFocus) || snippets[0];
  return {
    unitRef: unit.unitRef,
    evidenceRefs: snippets.map((s) => s.ref),
    focusRef: unit.focusRef,
    isRepair,
    unitCount: json.units.length,
    focusText: String(focus?.text || ''),
  };
}

function action(partial: Record<string, unknown> = {}) {
  return {
    actionHint: 'prepare-course',
    owner: 'self',
    intent: 'create',
    title: '准备周六课程讲义',
    reasonCode: 'request_to_self',
    priority: 'medium',
    dueAt: '',
    estimatedMinutes: 60,
    confidence: 0.9,
    project: '',
    evidenceRefs: [] as string[],
    ...partial,
  };
}

function jsonRes(content: unknown, usage = { prompt_tokens: 8, completion_tokens: 6 }): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
    usage,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('P0 AI schema v2 + Calendar 成功态', () => {
  beforeAll(() => {
    updateSettings({ aiAnalysisEnabled: true });
  });

  it('1. Prompt 包含全部必填字段与三类示例', () => {
    for (const field of AI_ACTION_REQUIRED_FIELDS) {
      expect(ANALYZER_SYSTEM_PROMPT).toContain(field);
    }
    expect(ANALYZER_SYSTEM_PROMPT).toContain(AI_SCHEMA_VERSION);
    expect(ANALYZER_SYSTEM_PROMPT).toContain(AI_PROMPT_VERSION);
    expect(ANALYZER_SYSTEM_PROMPT).toContain('actionable 正例');
    expect(ANALYZER_SYSTEM_PROMPT).toContain('uncertain 示例');
    expect(ANALYZER_SYSTEM_PROMPT).toContain('non_actionable 负例');
    expect(ANALYZER_SYSTEM_PROMPT).toContain('只围绕 focusRef 判断当前用户是否产生新动作');
    expect(AI_PROMPT_VERSION).toBe('todo-ai-prompt-v4');
    expect(AI_SCHEMA_VERSION).toBe('todo-ai-v4');
  });

  it('2. 完整 actionable 输出通过', () => {
    const allowed = new Map([['u_focus', new Set(['r_focus'])]]);
    const result = validateAnalyzedBatch(exampleActionableOutput(), ['u_focus'], allowed);
    expect(result.ok).toBe(true);
  });

  it('3. 缺 reasonCode', () => {
    const act = action();
    delete (act as { reasonCode?: string }).reasonCode;
    const result = validateAnalyzedBatch(
      { schemaVersion: AI_SCHEMA_VERSION, units: [{ unitRef: 'u_focus', decision: 'actionable', actions: [act] }] },
      ['u_focus'],
      new Map([['u_focus', new Set(['r1'])]])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MISSING_ACTION_FIELD');
      expect(result.error.field).toBe('reasonCode');
    }
  });

  it('4. 非法 estimatedMinutes', () => {
    const result = validateAnalyzedBatch(
      { schemaVersion: AI_SCHEMA_VERSION, units: [{ unitRef: 'u_focus', decision: 'actionable', actions: [action({ estimatedMinutes: 17, evidenceRefs: ['r1'] })] }] },
      ['u_focus'],
      new Map([['u_focus', new Set(['r1'])]])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ACTION_MINUTES');
  });

  it('5. confidence=90', () => {
    const result = validateAnalyzedBatch(
      { schemaVersion: AI_SCHEMA_VERSION, units: [{ unitRef: 'u_focus', decision: 'actionable', actions: [action({ confidence: 90, evidenceRefs: ['r1'] })] }] },
      ['u_focus'],
      new Map([['u_focus', new Set(['r1'])]])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ACTION_CONFIDENCE');
  });

  it('6. 错误 evidenceRef', () => {
    const result = validateAnalyzedBatch(
      { schemaVersion: AI_SCHEMA_VERSION, units: [{ unitRef: 'u_focus', decision: 'actionable', actions: [action({ evidenceRefs: ['r_unknown'] })] }] },
      ['u_focus'],
      new Map([['u_focus', new Set(['r1'])]])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EVIDENCE_REF');
  });

  it('6b. uncertain 必须携带可持久化的 review action', () => {
    const result = validateAnalyzedBatch(
      { schemaVersion: AI_SCHEMA_VERSION, units: [{ unitRef: 'u_focus', decision: 'uncertain', actions: [] }] },
      ['u_focus'],
      new Map([['u_focus', new Set(['r1'])]])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MISSING_ACTION_FIELD');
      expect(result.error.field).toBe('actions');
    }
  });

  it('6c. 解析完整 JSON fence 与一次编码的 JSON，但仍交给 V4 Schema 严格校验', () => {
    const raw = JSON.stringify(exampleActionableOutput());
    expect(parseModelJson('```json\n' + raw + '\n```')).toEqual(exampleActionableOutput());
    expect(parseModelJson(JSON.stringify(raw))).toEqual(exampleActionableOutput());
  });

  it('7. 第一次失败、修复成功', async () => {
    let calls = 0;
    const stats = await analyzeUnstructuredSources([msg('repair-1', '请你准备周六课程讲义')], {
      aiEnabled: true,
      fetchImpl: async (_url, init) => {
        calls += 1;
        const p = payloadFromInit(init);
        if (!p.isRepair) {
          const bad = action({ evidenceRefs: p.evidenceRefs });
          delete (bad as { reasonCode?: string }).reasonCode;
          return jsonRes({ schemaVersion: AI_SCHEMA_VERSION, units: [{ unitRef: p.unitRef, decision: 'actionable', actions: [bad] }] });
        }
        return jsonRes({
          schemaVersion: AI_SCHEMA_VERSION,
          units: [{ unitRef: p.unitRef, decision: 'actionable', actions: [action({ evidenceRefs: p.evidenceRefs })] }],
        });
      },
    });
    expect(calls).toBe(2);
    expect(stats.repairAttempts).toBe(1);
    expect(stats.actionable).toBeGreaterThanOrEqual(1);
    expect(stats.schemaFailedBatches).toBe(0);
    expect(stats.httpAttempts).toBeGreaterThanOrEqual(2);
  });

  it('8. 二分 batch 后保留正常单元', async () => {
    let calls = 0;
    const stats = await analyzeUnstructuredSources([
      msg('split-good', '请你准备周六课程讲义', { createdAt: '2026-08-24T03:00:00.000Z' }),
      msg('split-bad', '请你整理课后练习答案', { createdAt: '2026-08-24T03:01:00.000Z' }),
    ], {
      aiEnabled: true,
      fetchImpl: async (_url, init) => {
        calls += 1;
        const p = payloadFromInit(init);
        if (p.unitCount > 1) {
          return jsonRes({ schemaVersion: AI_SCHEMA_VERSION, units: [] });
        }
        if (p.focusText.includes('课后练习')) {
          const bad = action({ evidenceRefs: p.evidenceRefs, title: '整理课后练习答案' });
          delete (bad as { reasonCode?: string }).reasonCode;
          return jsonRes({ schemaVersion: AI_SCHEMA_VERSION, units: [{ unitRef: p.unitRef, decision: 'actionable', actions: [bad] }] });
        }
        return jsonRes({
          schemaVersion: AI_SCHEMA_VERSION,
          units: [{ unitRef: p.unitRef, decision: 'actionable', actions: [action({ evidenceRefs: p.evidenceRefs })] }],
        });
      },
    });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(stats.actionable).toBeGreaterThanOrEqual(1);
    expect(stats.deferredBySchema).toBeGreaterThanOrEqual(1);
  });

  it('9. 超长 batch 自动拆分', () => {
    const prev = process.env.DEEPSEEK_MAX_INPUT_CHARS;
    process.env.DEEPSEEK_MAX_INPUT_CHARS = '1200';
    try {
      const items = [
        msg('long-a', `请准备讲义 ${'甲'.repeat(180)}`),
        msg('long-b', `请准备练习 ${'乙'.repeat(180)}`),
      ];
      const units = buildUnits(items, 1200);
      expect(units.length).toBe(2);
      expect(serializeUnitsForModel(units).length).toBeGreaterThan(1200);
      const packed = packUnitsByChars(units, 1200, 20);
      expect(packed.length).toBeGreaterThanOrEqual(2);
      for (const batch of packed) {
        expect(serializeUnitsForModel(batch).length).toBeLessThanOrEqual(1200);
      }
    } finally {
      if (prev === undefined) delete process.env.DEEPSEEK_MAX_INPUT_CHARS;
      else process.env.DEEPSEEK_MAX_INPUT_CHARS = prev;
    }
  });

  it('10. focusRef 正确', () => {
    const context = msg('ctx-1', '上下文闲聊一句', { createdAt: '2026-08-24T04:00:00.000Z' });
    const focus = msg('focus-1', '请你准备周六课程讲义', { createdAt: '2026-08-24T04:01:00.000Z' });
    const unit = projectFeishuThread([context, focus], focus, 4000);
    expect(unit).toBeTruthy();
    expect(unit?.focusRef).toBeTruthy();
    const focusSnippet = unit?.snippets.find((s) => s.isFocus);
    expect(focusSnippet?.ref).toBe(unit?.focusRef);
    expect(unit?.snippets.some((s) => !s.isFocus)).toBe(true);
    const serialized = serializeUnitsForModel(unit ? [unit] : []);
    expect(serialized).toContain('"focusRef"');
    expect(serialized).toContain('"isFocus":true');
    expect(serialized).toContain(AI_SCHEMA_VERSION);
  });

  it('11. Prompt V4 不命中 V1 缓存', async () => {
    const item = msg('cache-iso-1', '请你准备周六课程讲义并回我确认');
    const units = buildUnits([item], 12_000);
    expect(units.length).toBe(1);
    productivity.putAiCache({
      opaqueHash: units[0].opaqueStableSourceHash,
      projectionHash: units[0].canonicalProjectionHash,
      sourceType: units[0].sourceType,
      model: 'deepseek-v4-flash',
      promptVersion: 'todo-ai-prompt-v1',
      schemaVersion: 'todo-ai-v1',
      policyVersion: EXTERNAL_TEXT_POLICY_VERSION,
      resultJson: JSON.stringify({ schemaVersion: 'todo-ai-v1', units: [{ unitRef: units[0].unitRef, decision: 'non_actionable', actions: [] }] }),
      promptTokens: 1,
      completionTokens: 1,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    let called = 0;
    const stats = await analyzeUnstructuredSources([item], {
      aiEnabled: true,
      fetchImpl: async (_url, init) => {
        called += 1;
        const p = payloadFromInit(init);
        return jsonRes({
          schemaVersion: AI_SCHEMA_VERSION,
          units: [{ unitRef: p.unitRef, decision: 'actionable', actions: [action({ evidenceRefs: p.evidenceRefs })] }],
        });
      },
    });
    expect(called).toBeGreaterThanOrEqual(1);
    expect(stats.cacheHits).toBe(0);
    expect(stats.actionable).toBeGreaterThanOrEqual(1);
  });

  it('11b. 同版本损坏缓存不算命中，并回源一次模型覆盖修复', async () => {
    const item = msg('cache-corrupt-v4', '请你准备一页项目进度摘要');
    const units = buildUnits([item], 12_000);
    expect(units.length).toBe(1);
    productivity.putAiCache({
      opaqueHash: units[0].opaqueStableSourceHash,
      projectionHash: units[0].canonicalProjectionHash,
      sourceType: units[0].sourceType,
      model: 'deepseek-v4-flash',
      promptVersion: AI_PROMPT_VERSION,
      schemaVersion: AI_SCHEMA_VERSION,
      policyVersion: EXTERNAL_TEXT_POLICY_VERSION,
      resultJson: JSON.stringify({ schemaVersion: 'todo-ai-v1', units: [] }),
      promptTokens: 1,
      completionTokens: 1,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    let called = 0;
    const stats = await analyzeUnstructuredSources([item], {
      aiEnabled: true,
      fetchImpl: async (_url, init) => {
        called += 1;
        const p = payloadFromInit(init);
        return jsonRes({
          schemaVersion: AI_SCHEMA_VERSION,
          units: [{ unitRef: p.unitRef, decision: 'actionable', actions: [action({ evidenceRefs: p.evidenceRefs })] }],
        });
      },
    });
    expect(called).toBe(1);
    expect(stats.cacheHits).toBe(0);
    expect(stats.invalidCacheEntries).toBe(1);
    expect(stats.schemaSuccess).toBe(1);
  });

  it('12. 合成的明确任务至少生成 1 条 actionable', async () => {
    const stats = await analyzeUnstructuredSources([msg('synth-1', '请你准备周六课程讲义，明天课前发给我')], {
      aiEnabled: true,
      fetchImpl: async (_url, init) => {
        const p = payloadFromInit(init);
        return jsonRes({
          schemaVersion: AI_SCHEMA_VERSION,
          units: [{ unitRef: p.unitRef, decision: 'actionable', actions: [action({ evidenceRefs: p.evidenceRefs })] }],
        });
      },
    });
    expect(stats.actionable).toBeGreaterThanOrEqual(1);
  });

  it('13. Calendar fullAccess 成功后不显示请等待弹窗', () => {
    const copy = calendarConnectSuccessCopy('fullAccess', 1);
    expect(copy).toContain('Apple Calendar 已连接');
    expect(copy).toContain('完整访问');
    expect(copy).toContain('已读取 1 条事件');
    expect(copy).not.toMatch(/弹窗|请允许|已请求日历权限/);
    const available = calendarStatusCopy({ available: true, permission: 'fullAccess', itemsRead: 1 });
    expect(available.statusLabel).toBe('已连接');
    expect(available.hint).not.toMatch(/弹窗|请等待/);
  });

  it('14. feishu_coverage 不污染 Apple Calendar 状态', () => {
    const apple = calendarStatusCopy({ available: true, permission: 'fullAccess', itemsRead: 1 });
    expect(apple.statusLabel).toBe('已连接');
    expect(apple.statusLabel).not.toBe('读取失败');
    const summary = formatAiRunSummary({ actionable: 0, review: 0, rejected: 159, schemaFailedBatches: 2, deferred: 522 });
    expect(summary).toBe('成功分析 159 · 非待办 159 · 格式失败 2 批 · 延后 522');
  });

  it('helper fingerprint 变化后 needsReconnect，不沿用 fullAccess', () => {
    const current = calendarHelperBuildId();
    expect(current).toBeTruthy();
    productivity.saveCheckpoint('calendar', {
      permission: 'fullAccess',
      ok: true,
      events: 1,
      busyStatus: 'fresh',
      helperVersion: '2',
      helperBuildId: 'ffffffffffffffff',
    });
    const state = inspectCalendarReadable('Asia/Shanghai');
    expect(state.needsReconnect).toBe(true);
    expect(state.available).toBe(false);
    expect(state.statusLabel).toBe('需要重新连接');
    expect(state.permission).toBe('fullAccess');
    productivity.saveCheckpoint('calendar', {
      permission: 'fullAccess',
      ok: true,
      events: 1,
      busyStatus: 'fresh',
      helperVersion: '2',
      helperBuildId: current,
    });
  });
});
