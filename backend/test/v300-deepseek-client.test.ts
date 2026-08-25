import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { completeDeepseekJson } from '../src/services/deepseekClient';
import { getDeepseekRuntimeConfig, validateDeepseekBaseUrl, RuntimeConfigError } from '../src/config/runtimeConfig';
import { PRODUCTIVITY_ERROR_CODES } from '../src/connectors/errors';
import { redactText } from '../src/services/redact';
import { ANALYZER_SYSTEM_PROMPT } from '../src/services/aiAnalysisSchema';
import { sanitizeExternalText } from '../src/services/externalTextPolicy';
import { serializeUnitsForModel, projectDesktopItem } from '../src/services/sourceProjection';
import { fingerprintSource } from '../src/services/hash';

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('DeepSeek client', () => {
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of Object.keys(process.env).filter((k) => k.startsWith('DEEPSEEK_'))) {
      prev[k] = process.env[k];
    }
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
    process.env.DEEPSEEK_MAX_RETRIES = '2';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('缺 Key 时 AI_NOT_CONFIGURED', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    await expect(completeDeepseekJson({ system: 's', user: '{"schemaVersion":"todo-ai-v1"}' })).rejects.toMatchObject({
      code: PRODUCTIVITY_ERROR_CODES.AI_NOT_CONFIGURED,
    });
  });

  it('默认拒绝非官方 host / 凭证 / query', () => {
    expect(() => validateDeepseekBaseUrl('http://example.com', false)).toThrow(RuntimeConfigError);
    expect(() => validateDeepseekBaseUrl('https://evil.example/x', false)).toThrow(RuntimeConfigError);
    expect(() => validateDeepseekBaseUrl('https://api.deepseek.com/?q=1', false)).toThrow(RuntimeConfigError);
    expect(() => validateDeepseekBaseUrl('https://user:pass@api.deepseek.com', false)).toThrow(RuntimeConfigError);
  });

  it('请求 JSON 含官方 model、json_object、thinking disabled、temperature 0.1', async () => {
    let captured = '';
    await completeDeepseekJson({
      system: ANALYZER_SYSTEM_PROMPT,
      user: '{"schemaVersion":"todo-ai-v1","units":[]}',
      fetchImpl: async (_url, init) => {
        captured = String(init?.body || '');
        expect(_url).toBe('https://api.deepseek.com/chat/completions');
        expect(init?.redirect).toBe('error');
        return jsonRes({
          choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        });
      },
    });
    const body = JSON.parse(captured);
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.stream).toBe(false);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.temperature).toBe(0.1);
    expect(body.top_p).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(captured).not.toContain('test-key-not-real');
  });

  it('Authorization 不出现在错误信息', async () => {
    try {
      await completeDeepseekJson({
        system: 's',
        user: 'u',
        fetchImpl: async () => jsonRes({ error: { message: 'nope' } }, 401),
      });
    } catch (e) {
      expect(String(e)).not.toMatch(/Bearer/);
      expect(String(e)).not.toContain('test-key');
    }
  });

  it('429 重试后成功，401 不重试', async () => {
    let n = 0;
    const ok = await completeDeepseekJson({
      system: 's',
      user: 'u',
      fetchImpl: async () => {
        n += 1;
        if (n < 2) return jsonRes({}, 429, { 'retry-after': '0' });
        return jsonRes({ choices: [{ finish_reason: 'stop', message: { content: '{"a":1}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    expect(ok.content).toContain('a');
    let calls = 0;
    await expect(
      completeDeepseekJson({
        system: 's',
        user: 'u',
        fetchImpl: async () => {
          calls += 1;
          return jsonRes({}, 401);
        },
      })
    ).rejects.toMatchObject({ code: PRODUCTIVITY_ERROR_CODES.AI_NOT_CONFIGURED });
    expect(calls).toBe(1);
  });

  it('空 content 与 length 失败', async () => {
    await expect(
      completeDeepseekJson({
        system: 's',
        user: 'u',
        fetchImpl: async () => jsonRes({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
      })
    ).rejects.toMatchObject({ code: PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID });
    await expect(
      completeDeepseekJson({
        system: 's',
        user: 'u',
        fetchImpl: async () => jsonRes({ choices: [{ finish_reason: 'length', message: { content: '{"a":' } }] }),
      })
    ).rejects.toMatchObject({ code: PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID });
  });

  it('日志脱敏覆盖 sk-*', () => {
    const fakeApiKey = ['sk', 'abcdefghijklmnop'].join('-');
    expect(redactText(`key ${fakeApiKey} leaked`)).toContain('sk-[redacted]');
    expect(redactText('Bearer abc.def')).not.toMatch(/abc\.def/);
  });

  it('序列化不含完整路径与 token', () => {
    const fakeApiKey = ['sk', 'abcdefghijklmnop'].join('-');
    const unit = projectDesktopItem({
      sourceType: 'desktop',
      sourceExternalId: '/Users/someone/secret/notes.md',
      sourceFingerprint: fingerprintSource('desktop', 'x'),
      title: 'notes.md',
      status: 'changed',
      summary: `next step prepare slides token ${fakeApiKey}`,
      payload: { type: 'md', name: 'notes.md' },
    }, 400);
    const body = serializeUnitsForModel(unit ? [unit] : []);
    expect(body).not.toContain('/Users/');
    expect(body).not.toContain(fakeApiKey);
    expect(sanitizeExternalText('call me 13800138000 at /Users/foo/a.md', 200)).not.toContain('13800138000');
  });

  it('惰性读取 env，不缓存旧 Key 配置状态', () => {
    process.env.DEEPSEEK_API_KEY = '';
    expect(getDeepseekRuntimeConfig().configured).toBe(false);
    process.env.DEEPSEEK_API_KEY = 'another';
    expect(getDeepseekRuntimeConfig().configured).toBe(true);
  });
});
