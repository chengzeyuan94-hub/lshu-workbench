import { PRODUCTIVITY_ERROR_CODES } from '../connectors/errors';
import { calendarHelperBuildId } from '../connectors/eventKit';
import { defaultAgendaRange } from './agendaService';
import { productivity } from '../db';

export interface CalendarReadableState {
  available: boolean;
  permission: string;
  busyStatus: string | null;
  errorCode: string | null;
  lastSyncAt: string | null;
  itemsRead: number;
  roundCount: number;
  lastSuccessCount: number;
  lastRoundOk: boolean;
  usingStaleSnapshot: boolean;
  helperVersion: string | null;
  helperBuildId: string | null;
  needsReconnect: boolean;
  windowStatus: string | null;
  snapshotComplete: boolean;
  statusLabel: string;
  hint: string;
}

function parseConfig(raw?: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function calendarConnectSuccessCopy(permission: string, events: number): string {
  if (permission === 'fullAccess') {
    return `Apple Calendar 已连接 · 完整访问 · 已读取 ${events} 条事件`;
  }
  return `Apple Calendar 权限状态：${permission} · 已读取 ${events} 条事件`;
}

export function calendarStatusCopy(input: {
  permission?: string;
  errorCode?: string | null;
  windowStatus?: string | null;
  stale?: boolean;
  available?: boolean;
  needsReconnect?: boolean;
  itemsRead?: number;
}): { statusLabel: string; hint: string } {
  const permission = input.permission || 'unknown';
  const code = input.errorCode || '';
  if (input.needsReconnect || code === PRODUCTIVITY_ERROR_CODES.CALENDAR_NEEDS_RECONNECT) {
    return { statusLabel: '需要重新连接', hint: '日历 helper 身份已变化，请重新连接 Apple Calendar。' };
  }
  if (permission === 'notDetermined') {
    return { statusLabel: '尚未授权', hint: '尚未授权日历完整访问。请点击「连接 Apple Calendar」。' };
  }
  if (permission === 'writeOnly' || code === PRODUCTIVITY_ERROR_CODES.CALENDAR_WRITE_ONLY) {
    return { statusLabel: '仅有写入权限', hint: '仅有写入权限，需要完整访问。请在系统设置 → 隐私与安全性 → 日历中开启完全访问。' };
  }
  if (permission === 'denied' || permission === 'restricted') {
    return { statusLabel: '已拒绝', hint: '已拒绝，请打开系统设置 → 隐私与安全性 → 日历，为 L叔工作台日历读取器打开完全访问。' };
  }
  if (code === PRODUCTIVITY_ERROR_CODES.CALENDAR_HELPER_STALE) {
    return { statusLabel: 'helper 过期', hint: '日历 helper 过期，请重新构建正式 calendar-reader 后再同步。' };
  }
  if (code === PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR) {
    return { statusLabel: '参数协议错误', hint: '日历参数协议错误，无法解析时间窗口。' };
  }
  if (input.stale) {
    return { statusLabel: '数据已过期', hint: '日历缓存已过期，请重新连接或同步。' };
  }
  if (input.available) {
    const n = Number(input.itemsRead || 0);
    return { statusLabel: '已连接', hint: `完整访问 · 已读取 ${n} 条事件` };
  }
  return { statusLabel: '读取失败', hint: 'Apple Calendar 读取失败。' };
}

function windowCoversRange(windowRow: Record<string, unknown> | undefined, timezone: string): boolean {
  if (!windowRow) return false;
  if (Number(windowRow.snapshot_complete) !== 1 || String(windowRow.status) !== 'ok') return false;
  const winTz = String(windowRow.timezone || '');
  if (winTz && winTz !== timezone) return false;
  const range = defaultAgendaRange(new Date(), timezone);
  const winFrom = Date.parse(String(windowRow.from_at || ''));
  const winTo = Date.parse(String(windowRow.to_at || ''));
  if (!Number.isFinite(winFrom) || !Number.isFinite(winTo)) return false;
  return winFrom <= range.from.getTime() + 1000 && winTo >= range.to.getTime() - 1000;
}

function windowFresh(windowRow: Record<string, unknown> | undefined): boolean {
  if (!windowRow) return false;
  const staleAfter = String(windowRow.stale_after || '');
  if (staleAfter && new Date(staleAfter).getTime() < Date.now()) return false;
  return Boolean(windowRow.last_success_at);
}

export function inspectCalendarReadable(timezone = 'Asia/Shanghai'): CalendarReadableState {
  const calendarCp = productivity.getCheckpoint('calendar');
  const cfg = parseConfig(calendarCp?.config_json);
  const win = productivity.latestAgendaWindow('apple');
  const currentBuildId = calendarHelperBuildId();
  const storedBuildId = cfg.helperBuildId != null ? String(cfg.helperBuildId) : null;
  if (calendarCp && !storedBuildId && currentBuildId) {
    productivity.patchCheckpointConfig('calendar', { helperBuildId: currentBuildId });
    cfg.helperBuildId = currentBuildId;
  }
  const helperBuildId = cfg.helperBuildId != null ? String(cfg.helperBuildId) : currentBuildId;
  const needsReconnect = Boolean(storedBuildId && currentBuildId && storedBuildId !== currentBuildId);
  const permission = String(cfg.permission || (win && String(win.status) === 'ok' ? 'fullAccess' : 'unknown'));
  const errorCode = needsReconnect
    ? PRODUCTIVITY_ERROR_CODES.CALENDAR_NEEDS_RECONNECT
    : (String(cfg.errorCode || win?.error_code || '') || null);
  const helperVersion = cfg.helperVersion != null ? String(cfg.helperVersion) : null;
  const checkpointItems = Number(cfg.events ?? cfg.itemsRead ?? 0);
  const snapshotComplete = Number(win?.snapshot_complete) === 1;
  const windowStatus = win ? String(win.status || '') : null;
  const covers = windowCoversRange(win, timezone);
  const fresh = windowFresh(win);
  const available = !needsReconnect
    && permission === 'fullAccess'
    && windowStatus === 'ok'
    && snapshotComplete
    && covers
    && fresh;
  const roundCount = available ? Number(cfg.lastRoundCount ?? checkpointItems) : 0;
  const itemsRead = roundCount;
  const lastSuccessCount = Number(cfg.lastSuccessCount ?? (cfg.ok === true ? checkpointItems : 0));
  const lastRoundOk = available;
  const usingStaleSnapshot = !available && lastSuccessCount > 0;
  const copy = calendarStatusCopy({
    permission,
    errorCode,
    windowStatus,
    stale: Boolean(win && !fresh),
    available,
    needsReconnect,
    itemsRead,
  });
  return {
    available,
    permission,
    busyStatus: cfg.busyStatus != null ? String(cfg.busyStatus) : (available ? 'fresh' : null),
    errorCode,
    lastSyncAt: calendarCp?.last_success_at ?? (win?.last_success_at ? String(win.last_success_at) : null),
    itemsRead,
    roundCount,
    lastSuccessCount,
    lastRoundOk,
    usingStaleSnapshot,
    helperVersion,
    helperBuildId,
    needsReconnect,
    windowStatus,
    snapshotComplete,
    statusLabel: copy.statusLabel,
    hint: copy.hint,
  };
}

export function calendarCheckpointPayload(input: {
  ok: boolean;
  events: number;
  busyStatus: string;
  permission: string;
  helperVersion: string;
  errorCode: string | null;
}): Record<string, unknown> {
  return {
    events: input.ok ? input.events : 0,
    busyStatus: input.busyStatus,
    permission: input.permission,
    ok: input.ok,
    helperVersion: input.helperVersion,
    helperBuildId: calendarHelperBuildId(),
    errorCode: input.ok ? null : input.errorCode,
  };
}

export function recordCalendarConnectorRound(input: {
  ok: boolean;
  events: number;
  busyStatus: string;
  permission: string;
  helperVersion: string;
  errorCode: string | null;
}): void {
  productivity.recordConnectorRound('calendar', {
    ok: input.ok,
    roundCount: input.ok ? input.events : 0,
    errorCode: input.errorCode,
    extra: calendarCheckpointPayload(input),
  });
}
