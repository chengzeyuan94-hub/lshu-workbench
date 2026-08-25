const SECRET_NAME = /key|token|secret|password|credential|authorization/i;

export const SETTINGS_WHITELIST = [
  'scanRoot',
  'excludedDirs',
  'refreshMinutes',
  'privacyNotice',
  'hotspotScheduleTimes',
  'hotspotAutoEnabled',
  'autoScheduleEnabled',
  'autoCompleteEnabled',
  'thingsEnabled',
  'feishuEnabled',
  'desktopEnabled',
  'calendarEnabled',
  'feishuChatAllowlist',
  'feishuP2pEnabled',
  'feishuAllowAll',
  'timezone',
  'workDays',
  'workStart',
  'workEnd',
  'lunchStart',
  'lunchEnd',
  'bufferMinutes',
  'minBlockMinutes',
  'maxBlockMinutes',
  'idleReserveRatio',
  'aiAnalysisEnabled',
  'aiPlanningConsent',
  'aiAutoSyncEnabled',
  'blockAllDayHolidays',
] as const;

export type SettingsKey = (typeof SETTINGS_WHITELIST)[number];

const BOOL_KEYS = new Set<string>([
  'hotspotAutoEnabled',
  'autoScheduleEnabled',
  'autoCompleteEnabled',
  'thingsEnabled',
  'feishuEnabled',
  'desktopEnabled',
  'calendarEnabled',
  'feishuP2pEnabled',
  'feishuAllowAll',
  'aiAnalysisEnabled',
  'aiPlanningConsent',
  'aiAutoSyncEnabled',
  'blockAllDayHolidays',
]);

export class SettingsPolicyError extends Error {
  readonly code = 'SETTINGS_REJECTED';
  readonly httpStatus = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SettingsPolicyError';
  }
}

export function isSecretLikeFieldName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function assertSettingsPatch(patch: Record<string, unknown>): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SettingsPolicyError('设置更新必须是对象');
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    // Handshake only: never persist. Frontend must send this when first enabling AI.
    if (key === 'confirmAiUpload' || key === 'confirmAiPlanningUpload') continue;
    if (isSecretLikeFieldName(key)) {
      throw new SettingsPolicyError('拒绝写入密钥类字段');
    }
    if (!(SETTINGS_WHITELIST as readonly string[]).includes(key)) {
      throw new SettingsPolicyError('存在未允许的设置字段');
    }
    if (BOOL_KEYS.has(key) && typeof value !== 'boolean') {
      throw new SettingsPolicyError(`字段 ${key} 必须是布尔值`);
    }
    if (key === 'refreshMinutes' && (typeof value !== 'number' || value < 5 || value > 240)) {
      throw new SettingsPolicyError('refreshMinutes 超出范围');
    }
    if (key === 'timezone' && typeof value === 'string') {
      try {
        Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
      } catch {
        throw new SettingsPolicyError('时区无效');
      }
    }
    if (key === 'excludedDirs' && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) {
      throw new SettingsPolicyError('excludedDirs 必须是字符串数组');
    }
    if (key === 'feishuChatAllowlist' && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) {
      throw new SettingsPolicyError('飞书白名单必须是字符串数组');
    }
    if (key === 'hotspotScheduleTimes' && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) {
      throw new SettingsPolicyError('热点调度时间必须是字符串数组');
    }
    out[key] = value;
  }
  return out;
}

export function publicSettings(raw: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults };
  for (const key of SETTINGS_WHITELIST) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}
