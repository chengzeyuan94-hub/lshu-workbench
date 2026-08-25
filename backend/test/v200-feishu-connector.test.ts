import { describe, expect, it } from 'vitest';
import {
  classifyFeishuFailure,
  messagesToItems,
  parseChatList,
  parseWhoami,
  parseUserAuthStatus,
  readFeishu,
  filterMessagesSince,
  FEISHU_MESSAGE_LOOKBACK_DAYS,
  FEISHU_MESSAGE_MAX_BYTES,
  FEISHU_MESSAGE_PAGE_LIMIT,
  feishuMessageLookbackStart,
  isUsableTokenStatus,
} from '../src/connectors/feishu';
import { PRODUCTIVITY_ERROR_CODES } from '../src/connectors/errors';
import { redactText } from '../src/services/redact';

describe('飞书 identity / 权限 / 去重 / 脱敏', () => {
  it('解析 bot identity', () => {
    const who = parseWhoami(JSON.stringify({ identity: 'bot', available: true, tokenStatus: 'ready' }));
    expect(who.identity).toBe('bot');
    expect(who.available).toBe(true);
  });

  it('解析真实 whoami 的 onBehalfOf.openId，并允许 CLI 自动刷新态', () => {
    const who = parseWhoami(JSON.stringify({
      identity: 'user',
      available: true,
      tokenStatus: 'needs_refresh',
      onBehalfOf: { openId: 'ou_current', userName: 'redacted' },
    }));
    expect(who.identity).toBe('user');
    expect(who.userId).toBe('ou_current');
    expect(isUsableTokenStatus(who.tokenStatus)).toBe(true);
  });

  it('auth status 回退仅信任可用的 user 节点', () => {
    expect(parseUserAuthStatus(JSON.stringify({
      identities: { user: { available: true, tokenStatus: 'ready', openId: 'ou_fallback' } },
    })).userId).toBe('ou_fallback');
    expect(parseUserAuthStatus(JSON.stringify({
      identities: { user: { available: false, tokenStatus: 'missing', openId: 'ou_untrusted' } },
    })).userId).toBeUndefined();
  });

  it('权限不足映射 FEISHU_SCOPE_LIMITED，并提示切换用户授权', () => {
    const err = classifyFeishuFailure('app_scope_not_applied 99991672', 'bot');
    expect(err.code).toBe(PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED);
    expect(err.message).toContain('用户授权');
  });

  it('消息按 message_id 去重', () => {
    const items = messagesToItems([
      { message_id: 'om_1', body: { content: '做好了' } },
      { message_id: 'om_1', body: { content: '重复' } },
      { message_id: 'om_2', body: { content: '另一条' } },
    ]);
    expect(items).toHaveLength(2);
  });

  it('日志脱敏：去掉 token、完整路径和链接', () => {
    const out = redactText('bearer abcdef.token /Users/example/Desktop/secret/file.md https://example.com/meet');
    expect(out).not.toContain('abcdef');
    expect(out).not.toContain('/Users/example');
    expect(out).not.toContain('https://');
  });

  it('bot 无群 + 空 allowlist 返回 SCOPE_LIMITED，不伪造已读全部聊天', async () => {
    const result = await readFeishu({
      allowlist: [],
      runner: async (argv) => {
        if (argv.includes('whoami')) {
          return {
            stdout: JSON.stringify({ identity: 'bot', available: true, tokenStatus: 'ready' }),
            stderr: '',
            code: 0,
            timedOut: false,
            truncated: false,
          };
        }
        return {
          stdout: JSON.stringify({ ok: true, identity: 'bot', data: { chats: null, has_more: false } }),
          stderr: '',
          code: 0,
          timedOut: false,
          truncated: false,
        };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED);
    expect(result.items).toEqual([]);
    expect(result.errorMessage).toContain('不要假设');
  });

  it('whoami 超时映射未授权/不可用', async () => {
    const result = await readFeishu({
      runner: async () => ({ stdout: '', stderr: '', code: null, timedOut: true, truncated: false }),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(PRODUCTIVITY_ERROR_CODES.FEISHU_UNAUTHORIZED);
  });

  it('解析空 chats 为 []', () => {
    expect(parseChatList(JSON.stringify({ data: { chats: null } }))).toEqual([]);
  });

  it('user + 空 allowlist 且未 allowAll 时不拉消息正文', async () => {
    const called: string[] = [];
    const result = await readFeishu({
      allowlist: [],
      allowAll: false,
      runner: async (argv) => {
        called.push(argv.slice(1).join(' '));
        if (argv.includes('whoami')) {
          return {
            stdout: JSON.stringify({ identity: 'user', available: true, tokenStatus: 'ready', onBehalfOf: { openId: 'ou_test' } }),
            stderr: '',
            code: 0,
            timedOut: false,
            truncated: false,
          };
        }
        if (argv.includes('+chat-list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              identity: 'user',
              data: { chats: [{ chat_id: 'oc_group_1', name: 'x' }] },
            }),
            stderr: '',
            code: 0,
            timedOut: false,
            truncated: false,
          };
        }
        if (argv.includes('+agenda')) {
          return {
            stdout: JSON.stringify({ ok: true, data: [] }),
            stderr: '',
            code: 0,
            timedOut: false,
            truncated: false,
          };
        }
        throw new Error(`unexpected argv ${argv.join(' ')}`);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.itemsSeen).toBe(0);
    expect(called.some((c) => c.includes('chat-messages-list'))).toBe(false);
  });

  it('user + allowAll 会按会话拉消息，失败不中断', async () => {
    const result = await readFeishu({
      allowAll: true,
      p2pEnabled: true,
      runner: async (argv) => {
        if (argv.includes('whoami')) {
          return {
            stdout: JSON.stringify({ identity: 'user', available: true, tokenStatus: 'ready', onBehalfOf: { openId: 'ou_test' } }),
            stderr: '',
            code: 0,
            timedOut: false,
            truncated: false,
          };
        }
        if (argv.includes('+chat-list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                chats: [
                  { chat_id: 'oc_a', chat_mode: 'group' },
                  { chat_id: 'oc_b', chat_mode: 'p2p' },
                ],
              },
            }),
            stderr: '',
            code: 0,
            timedOut: false,
            truncated: false,
          };
        }
        if (argv.includes('+chat-messages-list') && argv.includes('oc_a')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: { messages: [{ message_id: 'om_ok', create_time: String(Math.floor(Date.now() / 1000) - 3600), body: { content: '{"text":"请确认下周方案"}' } }] },
            }),
            stderr: '',
            code: 0,
            timedOut: false,
            truncated: false,
          };
        }
        if (argv.includes('+chat-messages-list') && argv.includes('oc_b')) {
          return { stdout: '', stderr: 'timeout', code: 1, timedOut: true, truncated: false };
        }
        return {
          stdout: JSON.stringify({ ok: true, data: [] }),
          stderr: '',
          code: 0,
          timedOut: false,
          truncated: false,
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.extra?.partial).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.extra?.chatsRead).toBe(1);
    expect(result.extra?.chatsFailed).toBe(1);
    expect(result.extra?.allowAll).toBe(true);
  });

  it('全部可见会话都失败时整轮不可读', async () => {
    const result = await readFeishu({
      allowAll: true,
      runner: async (argv) => {
        if (argv.includes('whoami')) {
          return { stdout: JSON.stringify({ identity: 'user', available: true, tokenStatus: 'ready', onBehalfOf: { openId: 'ou_test' } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('+chat-list')) {
          return { stdout: JSON.stringify({ ok: true, data: { chats: [{ chat_id: 'oc_a' }, { chat_id: 'oc_b' }] } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('+chat-messages-list')) {
          return { stdout: '', stderr: 'timeout', code: 1, timedOut: true, truncated: false };
        }
        if (argv.includes('+agenda')) {
          return { stdout: JSON.stringify({ ok: true, data: [] }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        throw new Error(`unexpected argv ${argv.join(' ')}`);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED);
    expect(result.extra).toMatchObject({ partial: true, chatsRead: 0, chatsFailed: 2, truncatedChats: 0 });
  });

  it('聊天可读但日历 scope 缺失时保留部分可读和本轮计数', async () => {
    const result = await readFeishu({
      allowAll: true,
      runner: async (argv) => {
        if (argv.includes('whoami')) {
          return { stdout: JSON.stringify({ identity: 'user', available: true, tokenStatus: 'ready', onBehalfOf: { openId: 'ou_test' } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('+chat-list')) {
          return { stdout: JSON.stringify({ ok: true, data: { chats: [{ chat_id: 'oc_a' }] } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('+chat-messages-list')) {
          return {
            stdout: JSON.stringify({ ok: true, data: { messages: [{ message_id: 'om_scope', create_time: String(Math.floor(Date.now() / 1000) - 60), body: { content: '{"text":"待确认事项"}' } }] } }),
            stderr: '', code: 0, timedOut: false, truncated: false,
          };
        }
        if (argv.includes('+agenda')) {
          return { stdout: JSON.stringify({ ok: false, error: { code: 99991672, message: 'app_scope_not_applied' } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        throw new Error(`unexpected argv ${argv.join(' ')}`);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.errorCode).toBe(PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED);
    expect(result.items).toHaveLength(1);
    expect(result.extra).toMatchObject({ partial: true, chatsRead: 1, chatsFailed: 0, truncatedChats: 0, hasCurrentUserId: true });
  });

  it('needs_refresh 会继续执行只读命令，由 CLI 自动刷新', async () => {
    const called: string[] = [];
    const result = await readFeishu({
      allowAll: true,
      runner: async (argv) => {
        called.push(argv.slice(1).join(' '));
        if (argv.includes('whoami')) {
          return { stdout: JSON.stringify({ identity: 'user', available: true, tokenStatus: 'needs_refresh', onBehalfOf: { openId: 'ou_test' } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('+chat-list')) {
          return { stdout: JSON.stringify({ ok: true, identity: 'user', data: { chats: [] } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('+agenda')) {
          return { stdout: JSON.stringify({ ok: true, data: [] }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        throw new Error(`unexpected argv ${argv.join(' ')}`);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.extra?.hasCurrentUserId).toBe(true);
    expect(called.some((c) => c.includes('+chat-list'))).toBe(true);
  });

  it('用户身份缺少稳定 ID 时 fail-closed，不读取会话', async () => {
    const called: string[] = [];
    const result = await readFeishu({
      allowAll: true,
      runner: async (argv) => {
        called.push(argv.slice(1).join(' '));
        if (argv.includes('whoami')) {
          return { stdout: JSON.stringify({ identity: 'user', available: true, tokenStatus: 'ready' }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('auth') && argv.includes('status')) {
          return { stdout: JSON.stringify({ identities: { user: { available: false, tokenStatus: 'missing' } } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        throw new Error(`unexpected argv ${argv.join(' ')}`);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED);
    expect(result.extra?.hasCurrentUserId).toBe(false);
    expect(called.some((c) => c.includes('+chat-list'))).toBe(false);
  });

  it('会话列表命令失败时本轮必须不可读，不能把空数组当成功', async () => {
    const result = await readFeishu({
      allowAll: true,
      runner: async (argv) => {
        if (argv.includes('whoami')) {
          return { stdout: JSON.stringify({ identity: 'user', available: true, tokenStatus: 'ready', onBehalfOf: { openId: 'ou_test' } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('+chat-list')) {
          return { stdout: '', stderr: 'unauthorized', code: 1, timedOut: false, truncated: false };
        }
        throw new Error(`unexpected argv ${argv.join(' ')}`);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.itemsSeen).toBe(0);
    expect(result.errorCode).toBe(PRODUCTIVITY_ERROR_CODES.FEISHU_UNAUTHORIZED);
    expect(result.extra?.hasCurrentUserId).toBe(true);
  });

  it('只保留最近 3 天消息，更早的丢掉', () => {
    expect(FEISHU_MESSAGE_LOOKBACK_DAYS).toBe(3);
    const now = Date.parse('2026-08-24T06:00:00.000Z');
    const since = feishuMessageLookbackStart(new Date(now)).getTime();
    const kept = filterMessagesSince(
      [
        { message_id: 'old', create_time: String(Math.floor((now - 5 * 86400000) / 1000)) },
        { message_id: 'new', create_time: String(Math.floor((now - 1 * 86400000) / 1000)) },
      ],
      since
    );
    expect(kept.map((m) => m.message_id)).toEqual(['new']);
  });

  it('拉消息时 --start 落在 3 天窗口内', async () => {
    const starts: string[] = [];
    const pageLimits: string[] = [];
    const maxBytes: number[] = [];
    await readFeishu({
      allowAll: true,
      runner: async (argv, options) => {
        if (argv.includes('whoami')) {
          return { stdout: JSON.stringify({ identity: 'user', available: true, tokenStatus: 'ready', onBehalfOf: { openId: 'ou_test' } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('+chat-list')) {
          return { stdout: JSON.stringify({ ok: true, data: { chats: [{ chat_id: 'oc_a', chat_mode: 'group' }] } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('+chat-messages-list')) {
          const i = argv.indexOf('--start');
          if (i >= 0) starts.push(String(argv[i + 1]));
          const limitIndex = argv.indexOf('--page-limit');
          if (limitIndex >= 0) pageLimits.push(String(argv[limitIndex + 1]));
          maxBytes.push(Number(options?.maxBytes || 0));
          return { stdout: JSON.stringify({ ok: true, data: { messages: [] } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        return { stdout: JSON.stringify({ ok: true, data: [] }), stderr: '', code: 0, timedOut: false, truncated: false };
      },
    });
    expect(starts).toHaveLength(1);
    const startMs = Date.parse(starts[0]);
    const delta = Date.now() - startMs;
    expect(delta).toBeGreaterThan(2.5 * 86400000);
    expect(delta).toBeLessThan(3.5 * 86400000);
    expect(pageLimits).toEqual([String(FEISHU_MESSAGE_PAGE_LIMIT)]);
    expect(FEISHU_MESSAGE_PAGE_LIMIT).toBe(10);
    expect(maxBytes).toEqual([FEISHU_MESSAGE_MAX_BYTES]);
    expect(FEISHU_MESSAGE_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('提高分页上限后仍检测服务端 has_more 截断', async () => {
    const result = await readFeishu({
      allowAll: true,
      runner: async (argv) => {
        if (argv.includes('whoami')) {
          return { stdout: JSON.stringify({ identity: 'user', available: true, tokenStatus: 'ready', onBehalfOf: { openId: 'ou_test' } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('+chat-list')) {
          return { stdout: JSON.stringify({ ok: true, data: { chats: [{ chat_id: 'oc_truncated' }] } }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        if (argv.includes('+chat-messages-list')) {
          return {
            stdout: JSON.stringify({ ok: true, data: { has_more: true, messages: [{ message_id: 'om_truncated', create_time: String(Math.floor(Date.now() / 1000) - 60), body: { content: '{"text":"待跟进"}' } }] } }),
            stderr: '', code: 0, timedOut: false, truncated: false,
          };
        }
        if (argv.includes('+agenda')) {
          return { stdout: JSON.stringify({ ok: true, data: [] }), stderr: '', code: 0, timedOut: false, truncated: false };
        }
        throw new Error(`unexpected argv ${argv.join(' ')}`);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.extra).toMatchObject({ partial: true, chatsRead: 1, chatsFailed: 0, truncatedChats: 1 });
  });

  it('agenda data 为数组时能计数', async () => {
    const { parseAgenda } = await import('../src/connectors/feishu');
    expect(parseAgenda(JSON.stringify({ ok: true, data: [{ event_id: 'e1', summary: '会' }] }))).toHaveLength(1);
    expect(parseAgenda(JSON.stringify({ ok: true, data: [] }))).toHaveLength(0);
  });
});
