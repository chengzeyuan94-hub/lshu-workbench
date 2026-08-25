export function calendarConnectSuccessCopy(permission: string, events: number): string {
  if (permission === 'fullAccess') {
    return `Apple Calendar 已连接 · 完整访问 · 已读取 ${events} 条事件`;
  }
  return `Apple Calendar 权限状态：${permission} · 已读取 ${events} 条事件`;
}

export function shouldHintCalendarPermissionDialog(permission: string | null | undefined): boolean {
  return permission !== 'fullAccess';
}

export function appleCalendarBanner(input: {
  available?: boolean;
  permission?: string;
  statusLabel?: string;
  hint?: string;
  itemsRead?: number;
}): string | null {
  if (input.available) return null;
  return input.hint || input.statusLabel || 'Apple Calendar 未同步';
}

export function feishuCoverageBanner(coverageError: string | null | undefined): string | null {
  if (coverageError === 'feishu_coverage') return '飞书日程覆盖：不完整';
  if (coverageError && coverageError !== 'apple_coverage') return `${coverageError}：不完整`;
  return null;
}

export function splitCalendarStatus(input: {
  appleAvailable?: boolean;
  coverageError?: string | null;
}): { apple: '已连接' | '未连接'; feishuCoverage: '完整' | '不完整' | '未知' } {
  return {
    apple: input.appleAvailable ? '已连接' : '未连接',
    feishuCoverage: input.coverageError === 'feishu_coverage' ? '不完整' : input.coverageError ? '不完整' : '未知',
  };
}
