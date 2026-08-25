import { getSettings } from '../db';
import { LSHU_WORK_PROFILE } from '../config/lshuWorkProfile';
import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from '../connectors/errors';
import { completeDeepseekJson, type FetchLike } from './deepseekClient';
import { parseModelJson } from './aiAnalysisSchema';
import { redactText } from './redact';
import type { TodayOverviewItem } from './todayOverview';

export const AI_DAY_PLANNER_SCHEMA_VERSION = 'day-planner-v1';
export const AI_DAY_PLANNER_PROMPT_VERSION = 'day-planner-prompt-v1';
export const MAX_DAILY_FOCUS_TASKS = 5;

export type PreferredWindow = 'morning' | 'afternoon' | 'any';

export interface WorkPatternProfile {
  version: string;
  generatedAt: string;
  role: string;
  coreDomains: readonly string[];
  workingStyle: typeof LSHU_WORK_PROFILE.workingStyle;
  planningPrinciples: readonly string[];
  evidenceSummary: typeof LSHU_WORK_PROFILE.evidenceSummary;
  workRules: {
    workStart: string;
    workEnd: string;
    lunchStart: string;
    lunchEnd: string;
    bufferMinutes: number;
  };
}

export interface AiFocusSelection {
  stableKey: string;
  rank: number;
  estimatedMinutes: number;
  preferredWindow: PreferredWindow;
  reason: string;
}

export interface AiDayPlannerResult {
  schemaVersion: string;
  promptVersion: string;
  maxFocusTasks: number;
  candidateCount: number;
  selectedCount: number;
  deferredCount: number;
  profileSummary: string;
  planSummary: string;
  dailyMessage: string;
  dailyMessageEn: string;
  selections: AiFocusSelection[];
  usage: {
    attempts: number;
    promptTokens: number;
    completionTokens: number;
  };
}

export function buildWorkPatternProfile(): WorkPatternProfile {
  const settings = getSettings();
  return {
    version: LSHU_WORK_PROFILE.version,
    generatedAt: LSHU_WORK_PROFILE.generatedAt,
    role: LSHU_WORK_PROFILE.role,
    coreDomains: LSHU_WORK_PROFILE.coreDomains,
    workingStyle: LSHU_WORK_PROFILE.workingStyle,
    planningPrinciples: LSHU_WORK_PROFILE.planningPrinciples,
    evidenceSummary: LSHU_WORK_PROFILE.evidenceSummary,
    workRules: {
      workStart: String(settings.workStart || '09:30'),
      workEnd: String(settings.workEnd || '18:30'),
      lunchStart: String(settings.lunchStart || '12:00'),
      lunchEnd: String(settings.lunchEnd || '13:30'),
      bufferMinutes: Math.max(0, Number(settings.bufferMinutes || 15)),
    },
  };
}

function systemPrompt(): string {
  return `你是 L叔个人工作台的每日规划器。只输出合法 JSON 对象，不要 Markdown，不要解释。
目标：从今天全部候选事项中选择最值得完成的 1 到 ${MAX_DAILY_FOCUS_TASKS} 件主任务。固定日历事件不计入这 ${MAX_DAILY_FOCUS_TASKS} 件，但会占用时间。
必须结合截止时间、事项来源、已经固化的工作画像和剩余工作时间。不要为了凑数选择低价值事项。
不得发明 stableKey，不得输出输入中不存在的任务。selections 必须唯一，rank 必须从 1 连续递增。
estimatedMinutes 只能是 15、30、45、60、90、120。preferredWindow 只能是 morning、afternoon、any。
reason 用中文说明为什么今天应该做，最长 50 字。planSummary 最长 80 字，profileSummary 最长 60 字。
dailyMessage 是写在今日小票底部、结合今日选择结果给用户的一句中文寄语，12 到 28 个汉字，具体、温暖、不喊口号。
dailyMessageEn 是对应的简短英文副句，最多 48 个 ASCII 字符。
输出结构：{"schemaVersion":"${AI_DAY_PLANNER_SCHEMA_VERSION}","profileSummary":"...","planSummary":"...","dailyMessage":"...","dailyMessageEn":"...","selections":[{"stableKey":"...","rank":1,"estimatedMinutes":45,"preferredWindow":"morning","reason":"..."}]}`;
}

function parseSelection(raw: unknown, candidates: TodayOverviewItem[]): Omit<AiDayPlannerResult, 'promptVersion' | 'maxFocusTasks' | 'candidateCount' | 'selectedCount' | 'deferredCount' | 'usage'> {
  if (!raw || typeof raw !== 'object') {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, 'AI 规划返回格式不正确');
  }
  const data = raw as Record<string, unknown>;
  if (data.schemaVersion !== AI_DAY_PLANNER_SCHEMA_VERSION || !Array.isArray(data.selections)) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, 'AI 规划版本或 selections 不正确');
  }
  if (data.selections.length < 1 || data.selections.length > MAX_DAILY_FOCUS_TASKS) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, 'AI 规划必须选择 1 到 5 件事项');
  }
  const allowed = new Set(candidates.map((candidate) => candidate.stableKey));
  const seen = new Set<string>();
  const minuteOptions = new Set([15, 30, 45, 60, 90, 120]);
  const windows = new Set<PreferredWindow>(['morning', 'afternoon', 'any']);
  const selections: AiFocusSelection[] = [];
  for (const item of data.selections) {
    if (!item || typeof item !== 'object') {
      throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, 'AI 规划事项格式不正确');
    }
    const row = item as Record<string, unknown>;
    const stableKey = String(row.stableKey || '');
    const rank = Number(row.rank);
    const estimatedMinutes = Number(row.estimatedMinutes);
    const preferredWindow = String(row.preferredWindow || '') as PreferredWindow;
    const reason = redactText(String(row.reason || '').trim(), 50);
    if (!allowed.has(stableKey) || seen.has(stableKey) || rank !== selections.length + 1 || !minuteOptions.has(estimatedMinutes) || !windows.has(preferredWindow) || !reason) {
      throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, 'AI 规划包含非法事项、顺序或时长');
    }
    seen.add(stableKey);
    selections.push({ stableKey, rank, estimatedMinutes, preferredWindow, reason });
  }
  return {
    schemaVersion: AI_DAY_PLANNER_SCHEMA_VERSION,
    profileSummary: redactText(String(data.profileSummary || '根据当前工作画像生成'), 60),
    planSummary: redactText(String(data.planSummary || '今天聚焦最重要的事情'), 80),
    dailyMessage: redactText(String(data.dailyMessage || '').trim(), 32),
    dailyMessageEn: redactText(String(data.dailyMessageEn || '').trim(), 48),
    selections,
  };
}

export async function selectTodayFocusWithAi(input: {
  candidates: TodayOverviewItem[];
  date?: string;
  timezone: string;
  now?: Date;
  fetchImpl?: FetchLike;
}): Promise<AiDayPlannerResult> {
  const settings = getSettings();
  if (settings.aiAnalysisEnabled !== true) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_LIVE_DISABLED, '请先在设置中开启 AI 分析');
  }
  if (settings.aiPlanningConsent !== true) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.SETTINGS_REJECTED, '加入 AI 规划前需要确认上传脱敏事项标题与聚合工作画像');
  }
  const allItems = input.candidates;
  const candidates = allItems.filter((item) => item.kind === 'task' && item.schedulable && item.state !== 'completed');
  if (!candidates.length) {
    return {
      schemaVersion: AI_DAY_PLANNER_SCHEMA_VERSION,
      promptVersion: AI_DAY_PLANNER_PROMPT_VERSION,
      maxFocusTasks: MAX_DAILY_FOCUS_TASKS,
      candidateCount: 0,
      selectedCount: 0,
      deferredCount: 0,
      profileSummary: '今天没有可排程事项',
      planSummary: '无需生成 AI 聚焦清单',
      dailyMessage: '给今天留一点从容，也是一种完成',
      dailyMessageEn: 'LEAVE ROOM FOR A GOOD DAY.',
      selections: [],
      usage: { attempts: 0, promptTokens: 0, completionTokens: 0 },
    };
  }
  const profile = buildWorkPatternProfile();
  const busySummary = allItems
    .filter((item) => item.kind === 'fixed_event' && item.startAt && item.endAt)
    .map((item) => ({ startAt: item.startAt, endAt: item.endAt }));
  const payload = JSON.stringify({
    schemaVersion: AI_DAY_PLANNER_SCHEMA_VERSION,
    promptVersion: AI_DAY_PLANNER_PROMPT_VERSION,
    date: input.date || input.now?.toISOString().slice(0, 10) || new Date().toISOString().slice(0, 10),
    timezone: input.timezone,
    maxFocusTasks: MAX_DAILY_FOCUS_TASKS,
    workProfile: profile,
    fixedBusy: busySummary,
    candidates: candidates.map((candidate) => ({
      stableKey: candidate.stableKey,
      title: redactText(candidate.title, 80),
      sourceType: candidate.sourceType,
      dueAt: candidate.dueAt || null,
      estimatedMinutes: candidate.estimatedMinutes || 45,
      confidence: candidate.confidence ?? null,
      state: candidate.state,
    })),
  });
  const response = await completeDeepseekJson({
    system: systemPrompt(),
    user: payload,
    fetchImpl: input.fetchImpl,
  });
  let raw: unknown;
  try {
    raw = parseModelJson(response.content);
  } catch {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, 'AI 规划返回的 JSON 无法解析');
  }
  const parsed = parseSelection(raw, candidates);
  if (!parsed.dailyMessage || !parsed.dailyMessageEn) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AI_SCHEMA_INVALID, 'AI 规划缺少今日寄语');
  }
  return {
    ...parsed,
    promptVersion: AI_DAY_PLANNER_PROMPT_VERSION,
    maxFocusTasks: MAX_DAILY_FOCUS_TASKS,
    candidateCount: candidates.length,
    selectedCount: parsed.selections.length,
    deferredCount: Math.max(0, candidates.length - parsed.selections.length),
    usage: {
      attempts: response.attempts,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
    },
  };
}
