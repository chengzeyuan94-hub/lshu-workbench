import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from './errors';
import { runArgv, type ArgvRunner, type RunArgvResult } from './safeExec';
import type { ConnectorRunResult, StandardizedItem } from './types';
import { fingerprintSource } from '../services/hash';
import { redactText, truncateSummary } from '../services/redact';
import { sanitizeOccurredAt } from '../services/localDay';

export interface FeishuWhoami {
  identity: string;
  available: boolean;
  tokenStatus: string;
  appId?: string;
  userId?: string;
}

export interface FeishuUserAuthStatus {
  available: boolean;
  tokenStatus: string;
  userId?: string;
}

export interface FeishuChat {
  chatId: string;
  chatMode?: string;
  name?: string;
}

export interface FeishuReadOptions {
  runner?: ArgvRunner;
  allowlist?: string[];
  p2pEnabled?: boolean;
  allowAll?: boolean;
  includeMessages?: boolean;
  timeoutMs?: number;
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.FEISHU_UNAUTHORIZED, '飞书返回无法解析');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function pickCurrentUserId(data: Record<string, unknown>): string | undefined {
  const identities = asRecord(data.identities) || asRecord(asRecord(data.status)?.identities) || asRecord(asRecord(data.data)?.identities) || {};
  const user = asRecord(identities.user) || {};
  const nestedData = asRecord(data.data) || {};
  const status = asRecord(data.status) || {};
  const onBehalfOf = asRecord(data.onBehalfOf) || {};
  const nestedOnBehalfOf = asRecord(nestedData.onBehalfOf) || {};
  const candidates = [
    onBehalfOf.openId,
    onBehalfOf.open_id,
    onBehalfOf.userId,
    onBehalfOf.user_id,
    user.openId,
    user.open_id,
    user.userId,
    user.user_id,
    data.userId,
    data.openId,
    data.open_id,
    data.user_id,
    nestedData.userId,
    nestedData.openId,
    nestedData.open_id,
    nestedOnBehalfOf.openId,
    nestedOnBehalfOf.open_id,
    nestedOnBehalfOf.userId,
    nestedOnBehalfOf.user_id,
    status.userId,
    asRecord(asRecord(status.identities)?.user)?.openId,
    asRecord(asRecord(nestedData.identities)?.user)?.openId,
  ];
  for (const value of candidates) {
    if (value != null && String(value).trim()) return String(value);
  }
  return undefined;
}

export function parseWhoami(raw: string): FeishuWhoami {
  const data = parseJson(raw);
  const nested = asRecord(data.data) || {};
  const identities = asRecord(data.identities) || asRecord(nested.identities) || asRecord(asRecord(data.status)?.identities) || {};
  const inferredUser = Boolean(asRecord(identities.user) || asRecord(data.onBehalfOf) || asRecord(nested.onBehalfOf));
  const identity = String(data.identity || nested.identity || (inferredUser ? 'user' : 'unknown'));
  const available = data.available === true || nested.available === true || inferredUser;
  const tokenStatus = String(data.tokenStatus || nested.tokenStatus || 'unknown');
  return {
    identity,
    available,
    tokenStatus,
    appId: data.appId ? String(data.appId) : (nested.appId ? String(nested.appId) : undefined),
    userId: identity === 'user' && available && isUsableTokenStatus(tokenStatus)
      ? (pickCurrentUserId(data) || pickCurrentUserId(nested))
      : undefined,
  };
}

export function isUsableTokenStatus(status: string): boolean {
  return status === 'ready' || status === 'needs_refresh';
}

export function parseUserAuthStatus(raw: string): FeishuUserAuthStatus {
  const data = parseJson(raw);
  const nested = asRecord(data.data) || {};
  const identities = asRecord(data.identities) || asRecord(nested.identities) || {};
  const user = asRecord(identities.user) || {};
  const available = user.available === true;
  const tokenStatus = String(user.tokenStatus || user.status || 'unknown');
  return {
    available,
    tokenStatus,
    userId: available && isUsableTokenStatus(tokenStatus) ? pickCurrentUserId(data) : undefined,
  };
}

export function parseChatList(raw: string): FeishuChat[] {
  const data = parseJson(raw);
  if (Array.isArray(data.data)) {
    return (data.data as Array<Record<string, unknown>>)
      .map((c) => ({
        chatId: String(c.chat_id || c.chatId || ''),
        chatMode: c.chat_mode ? String(c.chat_mode) : undefined,
        name: c.name ? String(c.name) : undefined,
      }))
      .filter((c) => c.chatId);
  }
  const body = (data.data && typeof data.data === 'object' ? data.data : data) as Record<string, unknown>;
  const chats = (body.chats || body.items || []) as Array<Record<string, unknown>>;
  if (!Array.isArray(chats)) return [];
  return chats
    .map((c) => ({
      chatId: String(c.chat_id || c.chatId || ''),
      chatMode: c.chat_mode ? String(c.chat_mode) : undefined,
      name: c.name ? String(c.name) : undefined,
    }))
    .filter((c) => c.chatId);
}

export function parseMessageList(raw: string): Array<Record<string, unknown>> {
  const data = parseJson(raw);
  if (Array.isArray(data.data)) return data.data as Array<Record<string, unknown>>;
  const body = (data.data && typeof data.data === 'object' ? data.data : data) as Record<string, unknown>;
  const items = (body.items || body.messages || []) as Array<Record<string, unknown>>;
  return Array.isArray(items) ? items : [];
}

export function messageListTruncated(raw: string): boolean {
  try {
    const data = parseJson(raw);
    if (data.has_more === true || data.truncated === true) return true;
    const body = (data.data && typeof data.data === 'object' ? data.data : data) as Record<string, unknown>;
    return body.has_more === true || body.truncated === true;
  } catch {
    return false;
  }
}

export function extractMessageText(item: Record<string, unknown>): string {
  const body = typeof item.body === 'object' && item.body ? (item.body as Record<string, unknown>) : item;
  let content = body.content ?? body.text ?? item.summary ?? '';
  if (typeof content === 'object' && content) {
    const obj = content as Record<string, unknown>;
    content = obj.text || obj.title || JSON.stringify(obj);
  }
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown> | unknown[];
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return String((parsed as Record<string, unknown>).text || (parsed as Record<string, unknown>).title || '');
        }
      } catch {
        /* keep raw */
      }
    }
    return trimmed;
  }
  return '';
}

export const FEISHU_MESSAGE_LOOKBACK_DAYS = 3;
export const FEISHU_MESSAGE_PAGE_LIMIT = 10;
export const FEISHU_MESSAGE_MAX_BYTES = 8 * 1024 * 1024;

export function feishuMessageLookbackStart(now = new Date()): Date {
  return new Date(now.getTime() - FEISHU_MESSAGE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
}

export function messageCreatedAtMs(msg: Record<string, unknown>): number | null {
  const raw = msg.create_time ?? msg.createTime ?? msg.timestamp ?? msg.createTimeMs;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && String(raw).trim() !== '') {
    return asNum < 1e12 ? asNum * 1000 : asNum;
  }
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? null : parsed;
}

export function sanitizeMessageOccurredAt(msg: Record<string, unknown>): string | null {
  return sanitizeOccurredAt(msg.create_time ?? msg.createTime ?? msg.timestamp ?? msg.createTimeMs);
}

export function filterMessagesSince(messages: Array<Record<string, unknown>>, sinceMs: number): Array<Record<string, unknown>> {
  return messages.filter((msg) => {
    const created = messageCreatedAtMs(msg);
    if (created == null) return false;
    return created >= sinceMs;
  });
}

export function parseAgenda(raw: string): Array<Record<string, unknown>> {
  const data = parseJson(raw);
  if (Array.isArray(data.data)) return data.data as Array<Record<string, unknown>>;
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  const body = (data.data && typeof data.data === 'object' ? data.data : data) as Record<string, unknown>;
  const items = (body.items || body.events || body.agenda || []) as Array<Record<string, unknown>>;
  return Array.isArray(items) ? items : [];
}

export function classifyFeishuFailure(raw: string, identity = 'bot'): ProductivityError {
  const text = raw.toLowerCase();
  if (text.includes('tokenstatus":"missing') || text.includes('unauthorized') || text.includes('99991663')) {
    return new ProductivityError(PRODUCTIVITY_ERROR_CODES.FEISHU_UNAUTHORIZED, '飞书未授权，请先完成登录');
  }
  if (text.includes('app_scope_not_applied') || text.includes('99991672') || text.includes('not supported')) {
    return new ProductivityError(
      PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
      identity === 'bot'
        ? '当前是 bot 身份，可见范围受限。请在设置页切换到用户授权：lark-cli auth login --domain im,calendar,vc'
        : '飞书权限不足，请补充 calendar / im / vc 授权'
    );
  }
  return new ProductivityError(PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED, '飞书可见范围不足');
}

function messageId(item: Record<string, unknown>): string {
  return String(item.message_id || item.messageId || item.id || '');
}

function eventId(item: Record<string, unknown>): string {
  return String(item.event_id || item.eventId || item.id || '');
}

function senderIdOf(msg: Record<string, unknown>): string {
  const sender = msg.sender && typeof msg.sender === 'object' ? (msg.sender as Record<string, unknown>) : {};
  const senderId = msg.sender_id && typeof msg.sender_id === 'object' ? (msg.sender_id as Record<string, unknown>) : {};
  return String(
    msg.senderId
    || sender.open_id
    || sender.openId
    || sender.user_id
    || sender.id
    || sender.sender_id
    || senderId.open_id
    || senderId.user_id
    || msg.sender_id
    || ''
  );
}

export function senderRoleOf(msg: Record<string, unknown>, currentUserId?: string): 'self' | 'other' | 'unknown' {
  if (!currentUserId) return 'unknown';
  const sid = senderIdOf(msg);
  if (!sid) return 'unknown';
  return sid === currentUserId ? 'self' : 'other';
}

export function mentionsSelf(msg: Record<string, unknown>, currentUserId?: string): boolean {
  if (!currentUserId) return false;
  const mentions = msg.mentions || msg.mention_list || [];
  if (!Array.isArray(mentions)) return false;
  return mentions.some((m) => {
    if (typeof m === 'string') return m === currentUserId;
    if (m && typeof m === 'object') {
      const row = m as Record<string, unknown>;
      return String(row.id || row.user_id || row.open_id || '') === currentUserId;
    }
    return false;
  });
}

export function repliesToSelf(msg: Record<string, unknown>, currentUserId?: string): boolean {
  if (!currentUserId) return false;
  const parent = msg.parent && typeof msg.parent === 'object' ? (msg.parent as Record<string, unknown>) : {};
  const replySender = String(msg.reply_sender_id || parent.sender_id || '');
  return Boolean(replySender) && replySender === currentUserId;
}

export function messagesToItems(messages: Array<Record<string, unknown>>, currentUserId?: string): StandardizedItem[] {
  const seen = new Set<string>();
  const items: StandardizedItem[] = [];
  for (const msg of messages) {
    const id = messageId(msg);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const text = truncateSummary(extractMessageText(msg), 160);
    items.push({
      sourceType: 'feishu_message',
      sourceExternalId: id,
      sourceFingerprint: fingerprintSource('feishu_message', id),
      title: text ? truncateSummary(text, 40) : '飞书消息',
      summary: text,
      status: 'open',
      createdAt: sanitizeMessageOccurredAt(msg),
      payload: {
        message_id: id,
        chat_hash: fingerprintSource('feishu_chat', String(msg.chat_id || msg.chatId || '')),
        chatType: String(msg.chat_mode || msg.chatMode || 'unknown') === 'p2p' ? 'p2p' : String(msg.chat_mode || '') ? 'group' : 'unknown',
        senderRole: senderRoleOf(msg, currentUserId),
        atSelf: mentionsSelf(msg, currentUserId),
        replyToSelf: repliesToSelf(msg, currentUserId),
        occurredAt: sanitizeMessageOccurredAt(msg),
      },
    });
  }
  return items;
}

export function eventsToItems(events: Array<Record<string, unknown>>): StandardizedItem[] {
  const seen = new Set<string>();
  const items: StandardizedItem[] = [];
  for (const ev of events) {
    const id = eventId(ev);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = String(ev.summary || ev.title || '飞书日程');
    items.push({
      sourceType: 'feishu_calendar',
      sourceExternalId: id,
      sourceFingerprint: fingerprintSource('feishu_calendar', id),
      title,
      summary: truncateSummary(title, 80),
      status: 'open',
      dueAt: String(ev.end_time || ev.endTime || ev.end || '') || null,
      payload: {
        event_id: id,
        start: ev.start_time || ev.startTime || ev.start || null,
        end: ev.end_time || ev.endTime || ev.end || null,
      },
    });
  }
  return items;
}

async function runLark(runner: ArgvRunner, argv: string[], timeoutMs: number, maxBytes = 256 * 1024): Promise<RunArgvResult> {
  return runner([process.env.LARK_CLI_BIN || 'lark-cli', ...argv], { timeoutMs, maxBytes });
}

type FeishuChatListResult = {
  ok: boolean;
  chats: FeishuChat[];
  errorCode?: string;
  errorMessage?: string;
};

async function listVisibleChats(runner: ArgvRunner, identity: string, p2pEnabled: boolean, timeoutMs: number): Promise<FeishuChatListResult> {
  const extra = p2pEnabled ? ['--types', 'p2p,group'] : [];
  const res = await runLark(
    runner,
    ['im', '+chat-list', '--as', identity, '--page-size', '50', '--page-all', '--page-limit', '10', ...extra, '--jq', '{ok,identity,data}'],
    timeoutMs
  );
  if (res.timedOut) {
    return {
      ok: false,
      chats: [],
      errorCode: PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
      errorMessage: '飞书会话列表读取超时',
    };
  }
  if (res.code !== 0) {
    const err = classifyFeishuFailure(`${res.stdout}${res.stderr}`, identity);
    return { ok: false, chats: [], errorCode: err.code, errorMessage: err.message };
  }
  try {
    return { ok: true, chats: parseChatList(res.stdout) };
  } catch {
    return {
      ok: false,
      chats: [],
      errorCode: PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
      errorMessage: '飞书会话列表返回无法解析',
    };
  }
}

export async function readFeishu(options: FeishuReadOptions = {}): Promise<ConnectorRunResult> {
  const runner = options.runner ?? runArgv;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const allowlist = (options.allowlist || []).filter(Boolean);
  const who = await runLark(runner, ['whoami', '--json'], timeoutMs);
  if (who.timedOut) {
    return {
      connector: 'feishu',
      ok: false,
      items: [],
      itemsSeen: 0,
      errorCode: PRODUCTIVITY_ERROR_CODES.FEISHU_UNAUTHORIZED,
      errorMessage: '飞书 whoami 超时',
    };
  }
  let identity: FeishuWhoami;
  try {
    identity = parseWhoami(who.stdout || who.stderr);
  } catch (e) {
    const err = e instanceof ProductivityError ? e : classifyFeishuFailure(`${who.stdout}${who.stderr}`);
    return { connector: 'feishu', ok: false, items: [], itemsSeen: 0, errorCode: err.code, errorMessage: err.message };
  }
  if (!identity.userId && identity.identity === 'user') {
    const statusRes = await runLark(runner, ['auth', 'status', '--json'], timeoutMs);
    if (!statusRes.timedOut && statusRes.code === 0) {
      try {
        const userStatus = parseUserAuthStatus(statusRes.stdout || statusRes.stderr || '{}');
        identity.userId = userStatus.userId || identity.userId;
      } catch {
        /* keep missing id */
      }
    }
  }
  if (identity.identity === 'user' && !identity.userId) {
    return {
      connector: 'feishu',
      ok: false,
      items: [],
      itemsSeen: 0,
      identity: identity.identity,
      errorCode: PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
      errorMessage: '飞书当前用户身份缺少稳定 ID，请重新完成用户授权',
      extra: { tokenStatus: identity.tokenStatus, chatCount: 0, hasCurrentUserId: false },
    };
  }
  if (!identity.available || !isUsableTokenStatus(identity.tokenStatus)) {
    const err = new ProductivityError(
      identity.identity === 'user' && identity.tokenStatus === 'missing'
        ? PRODUCTIVITY_ERROR_CODES.FEISHU_UNAUTHORIZED
        : PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
      identity.identity === 'bot'
        ? '当前是 bot 身份。若要读取个人聊天，请在设置页用用户身份授权。'
        : '飞书用户身份未登录，请运行 lark-cli auth login --domain im,calendar,vc'
    );
    return {
      connector: 'feishu',
      ok: false,
      items: [],
      itemsSeen: 0,
      identity: identity.identity,
      errorCode: err.code,
      errorMessage: err.message,
      extra: { tokenStatus: identity.tokenStatus, chatCount: 0, hasCurrentUserId: Boolean(identity.userId) },
    };
  }

  const allowAll = options.allowAll === true && identity.identity === 'user';
  const p2pEnabled = Boolean(options.p2pEnabled && identity.identity === 'user');
  const chatList = await listVisibleChats(runner, identity.identity, p2pEnabled, timeoutMs);
  if (!chatList.ok) {
    return {
      connector: 'feishu',
      ok: false,
      items: [],
      itemsSeen: 0,
      identity: identity.identity,
      errorCode: chatList.errorCode || PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
      errorMessage: chatList.errorMessage || '飞书会话列表本轮不可读',
      extra: { tokenStatus: identity.tokenStatus, chatCount: 0, hasCurrentUserId: Boolean(identity.userId) },
    };
  }
  const chats = chatList.chats;
  const visible = allowAll ? chats : chats.filter((c) => allowlist.includes(c.chatId));
  if (identity.identity === 'bot' && (chats.length === 0 || allowlist.length === 0)) {
    return {
      connector: 'feishu',
      ok: false,
      items: [],
      itemsSeen: 0,
      identity: identity.identity,
      errorCode: PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
      errorMessage: 'Bot 只能读取已加入且在 allowlist 中的群。当前可见群为 0，或未配置群聊白名单。请切换用户授权并配置 allowlist，不要假设已读取全部聊天。',
      extra: { tokenStatus: identity.tokenStatus, chatCount: chats.length, allowlistCount: allowlist.length, p2pEnabled: false },
    };
  }

  const items: StandardizedItem[] = [];
  let chatsRead = 0;
  let chatsFailed = 0;
  let truncatedChats = 0;
  let droppedMissingTimestamp = 0;
  const includeMessages = options.includeMessages !== false;
  const lookbackStart = feishuMessageLookbackStart();
  const start = lookbackStart.toISOString();
  const end = new Date().toISOString();
  if (includeMessages) {
    for (const chat of visible) {
      const msgRes = await runLark(
        runner,
        [
          'im', '+chat-messages-list', '--as', identity.identity, '--chat-id', chat.chatId,
          '--start', start, '--end', end, '--page-size', '50', '--page-all', '--page-limit', String(FEISHU_MESSAGE_PAGE_LIMIT),
          '--no-reactions', '--jq', '{ok,data}',
        ],
        timeoutMs,
        FEISHU_MESSAGE_MAX_BYTES
      );
      if (!msgRes.timedOut && msgRes.code === 0) {
        try {
          const parsed = parseMessageList(msgRes.stdout);
          if (messageListTruncated(msgRes.stdout) || msgRes.truncated) truncatedChats += 1;
          droppedMissingTimestamp += parsed.filter((m) => messageCreatedAtMs(m) == null).length;
          const recent = filterMessagesSince(parsed, lookbackStart.getTime());
          items.push(...messagesToItems(recent, identity.userId));
          chatsRead += 1;
        } catch {
          chatsFailed += 1;
        }
      } else {
        chatsFailed += 1;
      }
    }
  }

  const chatPartial = chatsFailed > 0 || truncatedChats > 0;
  const allVisibleChatsFailed = includeMessages && visible.length > 0 && chatsRead === 0;
  const chatReadAvailable = !includeMessages || visible.length === 0 || chatsRead > 0;
  const chatExtra = (partial: boolean) => ({
    tokenStatus: identity.tokenStatus,
    chatCount: chats.length,
    allowlistCount: allowAll ? chats.length : allowlist.length,
    p2pEnabled,
    chatsRead,
    chatsFailed,
    truncatedChats,
    droppedMissingTimestamp,
    partial,
    allowAll,
    hasCurrentUserId: Boolean(identity.userId),
    messageLookbackDays: FEISHU_MESSAGE_LOOKBACK_DAYS,
  });

  const agendaStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const agendaEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const agendaRes = await runLark(
    runner,
    ['calendar', '+agenda', '--as', identity.identity, '--start', agendaStart, '--end', agendaEnd, '--jq', '{ok,data,error}'],
    timeoutMs
  );
  if (agendaRes.stdout.includes('app_scope_not_applied') || agendaRes.stdout.includes('99991672')) {
    return {
      connector: 'feishu',
      ok: chatReadAvailable && !allVisibleChatsFailed,
      items,
      itemsSeen: items.length,
      identity: identity.identity,
      errorCode: PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
      errorMessage: redactText('飞书日历 scope 未开通，会议与忙闲不可用。', 160),
      extra: chatExtra(true),
    };
  }
  let agendaPartial = false;
  if (!agendaRes.timedOut && agendaRes.code === 0) {
    try {
      items.push(...eventsToItems(parseAgenda(agendaRes.stdout)));
    } catch {
      agendaPartial = true;
    }
  } else {
    agendaPartial = true;
  }

  const partial = chatPartial || agendaPartial;
  const ok = !allVisibleChatsFailed && (!partial || chatReadAvailable);
  return {
    connector: 'feishu',
    ok,
    items,
    itemsSeen: items.length,
    identity: identity.identity,
    errorCode: ok ? undefined : PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
    errorMessage: ok ? undefined : '飞书本轮可见会话均读取失败',
    extra: chatExtra(partial),
  };
}
