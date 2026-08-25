const OFFICIAL_ORIGIN = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';

export interface DeepseekRuntimeConfig {
  apiKey: string;
  configured: boolean;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  batchSize: number;
  maxInputChars: number;
  maxOutputTokens: number;
  maxItemsPerRun: number;
  dailyMaxInputTokens: number;
  dailyMaxOutputTokens: number;
  dailyMaxEstimatedUsd: number;
  budgetTimezone: string;
  allowCustomBaseUrl: boolean;
  endpointPath: string;
}

export class RuntimeConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
    this.code = code;
  }
}

function readEnv(name: string): string {
  return String(process.env[name] ?? '').trim();
}

function readInt(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function readFloat(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function officialDeepseekOrigin(): string {
  return OFFICIAL_ORIGIN;
}

export function validateDeepseekBaseUrl(raw: string, allowCustom: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RuntimeConfigError('AI_BASE_URL_INVALID', 'DeepSeek 接口地址无效');
  }
  if (url.protocol !== 'https:') {
    throw new RuntimeConfigError('AI_BASE_URL_INVALID', 'DeepSeek 接口必须使用 HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RuntimeConfigError('AI_BASE_URL_INVALID', 'DeepSeek 接口地址不得包含凭证或查询串');
  }
  const origin = `${url.protocol}//${url.host}`;
  if (!allowCustom && origin !== OFFICIAL_ORIGIN) {
    throw new RuntimeConfigError('AI_BASE_URL_INVALID', '默认只允许官方 DeepSeek 接口地址');
  }
  return url;
}

/** Lazy-read AI env on every call. Never cache process.env at module load. */
export function getDeepseekRuntimeConfig(): DeepseekRuntimeConfig {
  const allowCustom = readEnv('DEEPSEEK_ALLOW_CUSTOM_BASE_URL') === 'true';
  const baseRaw = readEnv('DEEPSEEK_BASE_URL') || OFFICIAL_ORIGIN;
  const url = validateDeepseekBaseUrl(baseRaw, allowCustom);
  const apiKey = readEnv('DEEPSEEK_API_KEY');
  return {
    apiKey,
    configured: Boolean(apiKey),
    baseUrl: `${url.protocol}//${url.host}`,
    model: readEnv('DEEPSEEK_MODEL') || DEFAULT_MODEL,
    timeoutMs: readInt('DEEPSEEK_TIMEOUT_MS', 45_000),
    maxRetries: readInt('DEEPSEEK_MAX_RETRIES', 2),
    batchSize: Math.min(20, readInt('DEEPSEEK_BATCH_SIZE', 20)),
    maxInputChars: readInt('DEEPSEEK_MAX_INPUT_CHARS', 12_000),
    maxOutputTokens: readInt('DEEPSEEK_MAX_OUTPUT_TOKENS', 4096),
    maxItemsPerRun: readInt('DEEPSEEK_MAX_ITEMS_PER_RUN', 100),
    dailyMaxInputTokens: readInt('DEEPSEEK_DAILY_MAX_INPUT_TOKENS', 250_000),
    dailyMaxOutputTokens: readInt('DEEPSEEK_DAILY_MAX_OUTPUT_TOKENS', 50_000),
    dailyMaxEstimatedUsd: readFloat('DEEPSEEK_DAILY_MAX_ESTIMATED_USD', 0.1),
    budgetTimezone: readEnv('DEEPSEEK_BUDGET_TIMEZONE') || 'Asia/Shanghai',
    allowCustomBaseUrl: allowCustom,
    endpointPath: '/chat/completions',
  };
}

export function deepseekChatCompletionsUrl(config: DeepseekRuntimeConfig = getDeepseekRuntimeConfig()): string {
  return `${config.baseUrl}${config.endpointPath}`;
}

export function isValidIanaTimeZone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
