import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { completeDeepseekJson } from '../src/services/deepseekClient';
import { getDeepseekRuntimeConfig } from '../src/config/runtimeConfig';
import { PRODUCTIVITY_ERROR_CODES } from '../src/connectors/errors';
import { buildAiStatusDto } from '../src/services/aiStatusDto';
import { AI_PROMPT_VERSION, AI_SCHEMA_VERSION } from '../src/services/aiAnalysisSchema';

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function okBody(content = '{"ok":true}', prompt = 12, completion = 4) {
  return {
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: prompt, completion_tokens: completion },
  };
}

describe('DeepSeek production fetch path', () => {
  const prev: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    for (const k of Object.keys(process.env).filter((k) => k.startsWith('DEEPSEEK_'))) {
      prev[k] = process.env[k];
    }
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
    process.env.DEEPSEEK_MAX_RETRIES = '2';
    delete process.env.DEEPSEEK_LIVE_SMOKE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('未注入 fetchImpl 时走 Node 原生 fetch，且不需要 LIVE_SMOKE', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonRes(okBody());
    }) as typeof fetch;
    const result = await completeDeepseekJson({ system: 's', user: '{"schemaVersion":"todo-ai-v1"}' });
    expect(calls).toBe(1);
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
  });

  it('缺 Key 时不调用 fetch', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonRes(okBody());
    }) as typeof fetch;
    await expect(completeDeepseekJson({ system: 's', user: 'u' })).rejects.toMatchObject({
      code: PRODUCTIVITY_ERROR_CODES.AI_NOT_CONFIGURED,
    });
    expect(calls).toBe(0);
  });

  it('超时映射 AI_TIMEOUT', async () => {
    const cfg = { ...getDeepseekRuntimeConfig(), timeoutMs: 20, maxRetries: 0 };
    await expect(
      completeDeepseekJson({
        system: 's',
        user: 'u',
        config: cfg,
        fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
          const abort = () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (init.signal?.aborted) {
            abort();
            return;
          }
          init.signal?.addEventListener('abort', abort);
        }),
      })
    ).rejects.toMatchObject({ code: PRODUCTIVITY_ERROR_CODES.AI_TIMEOUT });
  });

  it('429 用尽重试后为 AI_RATE_LIMITED', async () => {
    const cfg = { ...getDeepseekRuntimeConfig(), maxRetries: 0 };
    await expect(
      completeDeepseekJson({
        system: 's',
        user: 'u',
        config: cfg,
        fetchImpl: async () => jsonRes({}, 429, { 'retry-after': '0' }),
      })
    ).rejects.toMatchObject({ code: PRODUCTIVITY_ERROR_CODES.AI_RATE_LIMITED });
  });

  it('非法 JSON 内容可由调用方识别，HTTP 401 为 AI_NOT_CONFIGURED', async () => {
    const bad = await completeDeepseekJson({
      system: 's',
      user: 'u',
      fetchImpl: async () => jsonRes(okBody('not-json', 3, 1)),
    });
    expect(() => JSON.parse(bad.content)).toThrow();
    await expect(
      completeDeepseekJson({
        system: 's',
        user: 'u',
        fetchImpl: async () => jsonRes({}, 401),
      })
    ).rejects.toMatchObject({ code: PRODUCTIVITY_ERROR_CODES.AI_NOT_CONFIGURED });
  });
});

describe('AI status DTO', () => {
  it('展开最近运行字段并保留 lastRun', () => {
    const dto = buildAiStatusDto({
      configured: true,
      enabled: true,
      running: false,
      model: 'deepseek-v4-flash',
      lastRun: {
        calls: 1,
        retries: 0,
        input_units: 2,
        actionable: 1,
        review: 0,
        rejected: 0,
        deferred: 0,
        cache_hits: 0,
        prompt_tokens: 10,
        completion_tokens: 4,
        error_code: null,
        started_at: '2026-08-24T08:00:00.000Z',
        status: 'ok',
        stats_json: JSON.stringify({ promptVersion: AI_PROMPT_VERSION, schemaVersion: AI_SCHEMA_VERSION, invalidCacheEntries: 2 }),
      },
    });
    expect(dto.calls).toBe(1);
    expect(dto.inputUnits).toBe(2);
    expect(dto.errorCode).toBeNull();
    expect(dto.lastRun?.status).toBe('ok');
    expect(dto.running).toBe(false);
    expect(dto.invalidCacheEntries).toBe(2);
    expect(dto.runtimePromptVersion).toBe(AI_PROMPT_VERSION);
    expect(dto.runtimeSchemaVersion).toBe(AI_SCHEMA_VERSION);
    expect(dto.lastRunMatchesRuntime).toBe(true);
  });

  it('最近运行仍是旧协议时明确标记，不把旧结果冒充当前 V4', () => {
    const dto = buildAiStatusDto({
      configured: true,
      enabled: true,
      running: false,
      model: 'deepseek-v4-flash',
      lastRun: {
        calls: 0,
        input_units: 1,
        status: 'ok',
        stats_json: JSON.stringify({ promptVersion: 'todo-ai-prompt-v2', schemaVersion: 'todo-ai-v2' }),
      },
    });
    expect(dto.runtimePromptVersion).toBe(AI_PROMPT_VERSION);
    expect(dto.runtimeSchemaVersion).toBe(AI_SCHEMA_VERSION);
    expect(dto.lastRunMatchesRuntime).toBe(false);
  });
});
