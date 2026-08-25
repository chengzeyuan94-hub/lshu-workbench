import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from '../connectors/errors';
import {
  deepseekChatCompletionsUrl,
  getDeepseekRuntimeConfig,
  type DeepseekRuntimeConfig,
} from '../config/runtimeConfig';
import { redactText } from './redact';

export const DEEPSEEK_PRICE_SNAPSHOT = {
  effectiveFrom: '2026-08-01',
  model: 'deepseek-v4-flash',
  inputUsdPerMillion: 0.14,
  outputUsdPerMillion: 0.28,
};

export interface DeepseekUsage {
  promptTokens: number;
  completionTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
}

export interface DeepseekSuccess {
  content: string;
  finishReason: string;
  usage: DeepseekUsage;
  attempts: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(res: Response, attempt: number): number {
  const raw = res.headers.get('retry-after');
  if (raw) {
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec >= 0) return Math.min(20_000, sec * 1000);
  }
  const base = Math.min(8000, 400 * 2 ** attempt);
  return base + Math.floor(Math.random() * 200);
}

function usageFrom(raw: unknown): DeepseekUsage {
  const u = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? (u.prompt_tokens_details as Record<string, unknown>) : {};
  return {
    promptTokens: Number(u.prompt_tokens || 0),
    completionTokens: Number(u.completion_tokens || 0),
    promptCacheHitTokens: Number(u.prompt_cache_hit_tokens || details.cached_tokens || 0),
    promptCacheMissTokens: Number(u.prompt_cache_miss_tokens || 0),
  };
}

function classifyHttp(status: number): { retryable: boolean; code: string } {
  if (status === 429) return { retryable: true, code: PRODUCTIVITY_ERROR_CODES.AI_RATE_LIMITED };
  if (status === 500 || status === 503) return { retryable: true, code: PRODUCTIVITY_ERROR_CODES.AI_UNAVAILABLE };
  if (status === 401 || status === 402) return { retryable: false, code: PRODUCTIVITY_ERROR_CODES.AI_NOT_CONFIGURED };
  if (status === 400 || status === 422) return { retryable: false, code: PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID };
  return { retryable: false, code: PRODUCTIVITY_ERROR_CODES.AI_UNAVAILABLE };
}

export function estimateUsd(usage: DeepseekUsage, price = DEEPSEEK_PRICE_SNAPSHOT): number {
  return (usage.promptTokens / 1_000_000) * price.inputUsdPerMillion + (usage.completionTokens / 1_000_000) * price.outputUsdPerMillion;
}

export function worstCaseUsd(inputTokens: number, outputTokens: number, price = DEEPSEEK_PRICE_SNAPSHOT): number {
  return (inputTokens / 1_000_000) * price.inputUsdPerMillion + (outputTokens / 1_000_000) * price.outputUsdPerMillion;
}

export async function completeDeepseekJson(input: {
  system: string;
  user: string;
  fetchImpl?: FetchLike;
  config?: DeepseekRuntimeConfig;
  emptyContentRetry?: boolean;
}): Promise<DeepseekSuccess> {
  const config = input.config ?? getDeepseekRuntimeConfig();
  if (!config.configured) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_NOT_CONFIGURED, 'DeepSeek 未配置');
  }
  const url = deepseekChatCompletionsUrl(config);
  const body = {
    model: config.model,
    stream: false,
    thinking: { type: 'disabled' },
    temperature: 0.1,
    max_tokens: config.maxOutputTokens,
    response_format: { type: 'json_object' },
    user_id: 'lshu_workbench_local',
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
  };
  const serialized = JSON.stringify(body);
  if (/sk-[A-Za-z0-9]{8,}/.test(serialized) || /\/Users\//.test(serialized)) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, '请求体包含禁止外传的内容');
  }

  const fetchImpl: FetchLike = input.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const maxRetries = config.maxRetries;
  let attempts = 0;
  let emptyRetried = false;
  let lastError: ProductivityError | null = null;

  while (attempts < 1 + maxRetries) {
    attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: serialized,
      });
      if (!res.ok) {
        const kind = classifyHttp(res.status);
        lastError = new ProductivityError(kind.code as typeof PRODUCTIVITY_ERROR_CODES[keyof typeof PRODUCTIVITY_ERROR_CODES], `DeepSeek HTTP ${res.status}`, { attempts });
        if (!kind.retryable) throw lastError;
        if (attempts >= 1 + maxRetries) throw lastError;
        await sleep(retryAfterMs(res, attempts));
        continue;
      }
      const json = (await res.json()) as Record<string, unknown>;
      const choice = Array.isArray(json.choices) ? (json.choices[0] as Record<string, unknown> | undefined) : undefined;
      const finishReason = String(choice?.finish_reason || json.finish_reason || '');
      const message = choice?.message && typeof choice.message === 'object' ? (choice.message as Record<string, unknown>) : {};
      const content = String(message.content || '');
      if (finishReason === 'insufficient_system_resource') {
        lastError = new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_UNAVAILABLE, 'DeepSeek 资源不足', { attempts });
        if (attempts >= 1 + maxRetries) throw lastError;
        await sleep(400 * attempts);
        continue;
      }
      if (finishReason === 'length' || finishReason === 'content_filter') {
        throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, 'DeepSeek 输出被截断或过滤', {
          attempts,
          finishReason,
          schemaCode: 'OUTPUT_TRUNCATED',
        });
      }
      if (!content.trim()) {
        if (!emptyRetried && (input.emptyContentRetry !== false)) {
          emptyRetried = true;
          if (attempts >= 2) {
            throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, 'DeepSeek 返回空内容', {
              attempts,
              schemaCode: 'EMPTY_CONTENT',
            });
          }
          continue;
        }
        throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, 'DeepSeek 返回空内容', {
          attempts,
          schemaCode: 'EMPTY_CONTENT',
        });
      }
      if (finishReason && finishReason !== 'stop') {
        throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, 'DeepSeek finish_reason 非法', {
          attempts,
          finishReason,
          schemaCode: 'OUTPUT_TRUNCATED',
        });
      }
      return {
        content,
        finishReason: finishReason || 'stop',
        usage: usageFrom(json.usage),
        attempts,
      };
    } catch (e) {
      if (e instanceof ProductivityError) {
        if ((e.code === PRODUCTIVITY_ERROR_CODES.AI_UNAVAILABLE || e.code === PRODUCTIVITY_ERROR_CODES.AI_RATE_LIMITED) && attempts < 1 + maxRetries) {
          lastError = e;
          await sleep(400 * attempts);
          continue;
        }
        throw new ProductivityError(e.code, redactText(e.message, 120), { ...e.details, attempts });
      }
      const aborted = e instanceof Error && (e.name === 'AbortError' || e.message.includes('abort'));
      if (aborted) {
        throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_TIMEOUT, 'DeepSeek 请求超时', { attempts });
      }
      lastError = new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_UNAVAILABLE, 'DeepSeek 网络错误', { attempts });
      if (attempts >= 1 + maxRetries) throw lastError;
      await sleep(400 * attempts);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_UNAVAILABLE, 'DeepSeek 调用失败');
}

export function assertNoSecretsInLog(text: string): void {
  if (/sk-[A-Za-z0-9]{8,}/.test(text) || /Bearer\s+\S+/i.test(text)) {
    throw new Error('log leaked secret');
  }
}
