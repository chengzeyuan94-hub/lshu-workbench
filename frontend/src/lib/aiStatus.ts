export const AI_ERROR_LABELS: Record<string, string> = {
  AI_NOT_CONFIGURED: '未配置 DeepSeek Key',
  AI_LIVE_DISABLED: '正式请求被错误的测试开关阻止',
  AI_BUDGET_EXHAUSTED: '今日 AI 额度已用尽',
  AI_UNAVAILABLE: 'DeepSeek 暂时不可用',
  AI_TIMEOUT: '请求超时',
  AI_RATE_LIMITED: '请求频率受限',
};

export function aiErrorLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code === 'AI_SCHEMA_INVALID') return null;
  return AI_ERROR_LABELS[code] || `分析失败（${code}）`;
}

export function formatAiTime(iso: string | null | undefined): string {
  if (!iso) return '尚无运行记录';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
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
