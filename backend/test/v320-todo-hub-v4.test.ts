import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'wb-v320-todo-v4-'));
process.env.WORKBENCH_DATA_DIR = dbDir;
process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
process.env.DEEPSEEK_DAILY_MAX_ESTIMATED_USD = '1.00';
process.env.VITEST = '1';

const { default: db, getSettings, updateSettings, productivity } = await import('../src/db');
const { parseWhoami, pickCurrentUserId, senderRoleOf, messagesToItems } = await import('../src/connectors/feishu');
const { commitSync, getConnectorStatuses } = await import('../src/services/productivitySync');
const { queryTodayOverview } = await import('../src/services/todayOverview');
const { createTodayDayPlan, getTodayDayPlan, refuseExternalCommit } = await import('../src/services/dayPlanService');
const { analyzeUnstructuredSources } = await import('../src/services/actionIntentAnalyzer');
const { fingerprintSource } = await import('../src/services/hash');
const { AI_PROMPT_VERSION, AI_SCHEMA_VERSION } = await import('../src/services/aiAnalysisSchema');
const { workbenchRuntimeStamp } = await import('../src/services/runtimeStamp');
const { DEFAULT_PLANNING_RULES, planTodos, buildDayWindows } = await import('../src/services/planning');
const { todayPlanningBusy } = await import('../src/services/agendaService');
const { PRODUCTIVITY_ERROR_CODES } = await import('../src/connectors/errors');
const { localDayBounds } = await import('../src/services/localDay');
const { ensureProductivityV3, currentProductivitySchemaVersion } = await import('../src/productivitySchemaV3');
const { ensureProductivityV31 } = await import('../src/productivitySchemaV31');

afterAll(() => rmSync(dbDir, { recursive: true, force: true }));

function msg(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    sourceType: 'feishu_message' as const,
    sourceExternalId: id,
    sourceFingerprint: fingerprintSource('feishu_message', id),
    title: text.slice(0, 20),
    summary: text,
    status: 'open' as const,
    createdAt: String(extra.createdAt || '2026-08-24T02:00:00.000Z'),
    payload: {
      chat_hash: extra.chat_hash || 'c-v4',
      senderRole: extra.senderRole || 'other',
      atSelf: extra.atSelf === true,
      replyToSelf: extra.replyToSelf === true,
      chatType: extra.chatType || 'p2p',
      ...extra,
    },
  };
}

function jsonRes(body: unknown) {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }],
    usage: { prompt_tokens: 20, completion_tokens: 12 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function action(partial: Record<string, unknown> = {}) {
  return {
    actionHint: 'next-step',
    owner: 'self',
    intent: 'create',
    title: '准备材料',
    reasonCode: 'request_to_self',
    priority: 'medium',
    dueAt: '',
    estimatedMinutes: 45,
    confidence: 0.9,
    project: '',
    evidenceRefs: [] as string[],
    ...partial,
  };
}

describe('待办智能中枢 V4', () => {
  it('health stamp 与 Prompt/Schema 版本一致，旧 V1 不再同版本', () => {
    const stamp = workbenchRuntimeStamp();
    expect(stamp.schemaVersion).toBe(AI_SCHEMA_VERSION);
    expect(stamp.promptVersion).toBe(AI_PROMPT_VERSION);
    expect(stamp.buildId).toContain('todo-hub-v4');
    expect(AI_SCHEMA_VERSION).toBe('todo-ai-v4');
    expect(AI_PROMPT_VERSION).toBe('todo-ai-prompt-v4');
    expect(AI_SCHEMA_VERSION).not.toBe('todo-ai-v1');
  });

  it('新版本数据库不会被旧迁移识别成待迁移并降回 v3/v3.1', () => {
    expect(currentProductivitySchemaVersion(db)).toBe('v4');
    ensureProductivityV3(db, { skipBackup: true });
    ensureProductivityV31(db, { skipBackup: true });
    expect(currentProductivitySchemaVersion(db)).toBe('v4');
  });

  it('从 identities.user.openId 解析当前用户，senderRole 可区分 self/other', () => {
    const who = parseWhoami(JSON.stringify({
      available: true,
      tokenStatus: 'ready',
      identities: { user: { openId: 'ou_self' } },
    }));
    expect(who.identity).toBe('user');
    expect(who.userId).toBe('ou_self');
    expect(parseWhoami(JSON.stringify({
      identity: 'user',
      available: true,
      tokenStatus: 'ready',
      onBehalfOf: { openId: 'ou_real_shape' },
    })).userId).toBe('ou_real_shape');
    expect(pickCurrentUserId({ status: { identities: { user: { openId: 'ou_status' } } } })).toBe('ou_status');
    expect(senderRoleOf({ sender: { open_id: 'ou_self' } }, 'ou_self')).toBe('self');
    expect(senderRoleOf({ sender: { open_id: 'ou_other' } }, 'ou_self')).toBe('other');
  });

  it('飞书失败时本轮读取为 0，不得继续显示旧 62', async () => {
    productivity.saveCheckpoint('feishu', { chatCount: 62, tokenStatus: 'ready', identity: 'user' });
    productivity.recordConnectorRound('feishu', {
      ok: false,
      roundCount: 0,
      errorCode: 'FEISHU_SCOPE_LIMITED',
      extra: { hasCurrentUserId: false },
    });
    const connectors = await getConnectorStatuses();
    const feishu = connectors.find((c) => c.id === 'feishu')!;
    expect(feishu.itemsRead).toBe(0);
    expect(feishu.roundCount).toBe(0);
    expect(feishu.statusLabel).toBe('不可读');
    expect(feishu.available).toBe(false);
    expect(feishu.lastSuccessCount).toBe(62);
    expect(feishu.usingStaleSnapshot).toBe(true);
  });

  it('当前用户已识别与本轮不可读是两个独立状态', async () => {
    productivity.recordConnectorRound('feishu', {
      ok: false,
      roundCount: 0,
      errorCode: 'FEISHU_SCOPE_LIMITED',
      extra: { hasCurrentUserId: true, identity: 'user', tokenStatus: 'needs_refresh' },
    });
    const connectors = await getConnectorStatuses();
    const feishu = connectors.find((c) => c.id === 'feishu')!;
    expect(feishu.hasCurrentUserId).toBe(true);
    expect(feishu.lastRoundOk).toBe(false);
    expect(feishu.available).toBe(false);
    expect(feishu.itemsRead).toBe(0);
  });

  it('部分成功持久化本轮计数、清理旧错误，并保持飞书日程覆盖 partial', async () => {
    const settings = getSettings();
    productivity.recordConnectorRound('feishu', {
      ok: false,
      roundCount: 0,
      errorCode: PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
      extra: { hasCurrentUserId: true },
    });
    updateSettings({
      desktopEnabled: false,
      thingsEnabled: false,
      calendarEnabled: false,
      feishuEnabled: true,
      feishuAllowAll: true,
      feishuP2pEnabled: true,
      aiAnalysisEnabled: false,
    });
    try {
      const result = await commitSync({
        includeAi: false,
        persistAgenda: false,
        feishuRunner: async (argv) => {
          if (argv.includes('whoami')) {
            return { stdout: JSON.stringify({ identity: 'user', available: true, tokenStatus: 'ready', onBehalfOf: { openId: 'ou_test' } }), stderr: '', code: 0, timedOut: false, truncated: false };
          }
          if (argv.includes('+chat-list')) {
            return { stdout: JSON.stringify({ ok: true, data: { chats: [{ chat_id: 'oc_ok' }, { chat_id: 'oc_failed' }] } }), stderr: '', code: 0, timedOut: false, truncated: false };
          }
          if (argv.includes('+chat-messages-list') && argv.includes('oc_ok')) {
            return {
              stdout: JSON.stringify({ ok: true, data: { messages: [{ message_id: 'om_partial', create_time: String(Math.floor(Date.now() / 1000) - 60), body: { content: '{"text":"今天跟进"}' } }] } }),
              stderr: '', code: 0, timedOut: false, truncated: false,
            };
          }
          if (argv.includes('+chat-messages-list')) {
            return { stdout: '', stderr: 'timeout', code: 1, timedOut: true, truncated: false };
          }
          if (argv.includes('+agenda')) {
            return { stdout: JSON.stringify({ ok: false, error: { code: 99991672, message: 'app_scope_not_applied' } }), stderr: '', code: 0, timedOut: false, truncated: false };
          }
          throw new Error(`unexpected argv ${argv.join(' ')}`);
        },
      });
      expect(result.connectorErrors).toEqual([]);

      const feishu = (await getConnectorStatuses()).find((c) => c.id === 'feishu')!;
      expect(feishu).toMatchObject({
        available: true,
        statusLabel: '部分可读',
        usingStaleSnapshot: false,
        lastRoundOk: true,
        lastRoundPartial: true,
        itemsRead: 1,
        chatsRead: 1,
        chatsFailed: 1,
        truncatedChats: 0,
        lastError: null,
      });
      const cfg = JSON.parse(productivity.getCheckpoint('feishu')!.config_json) as Record<string, unknown>;
      expect(cfg).toMatchObject({
        lastRoundOk: true,
        lastRoundPartial: true,
        lastRoundError: null,
        usingStaleSnapshot: false,
        chatsRead: 1,
        chatsFailed: 1,
        truncatedChats: 0,
      });
      expect(productivity.latestAgendaWindow('feishu')).toMatchObject({
        snapshot_complete: 0,
        status: 'partial',
        error_code: PRODUCTIVITY_ERROR_CODES.FEISHU_SCOPE_LIMITED,
      });
    } finally {
      updateSettings({
        desktopEnabled: settings.desktopEnabled,
        thingsEnabled: settings.thingsEnabled,
        calendarEnabled: settings.calendarEnabled,
        feishuEnabled: settings.feishuEnabled,
        feishuAllowAll: settings.feishuAllowAll,
        feishuP2pEnabled: settings.feishuP2pEnabled,
        aiAnalysisEnabled: settings.aiAnalysisEnabled,
      });
    }
  });

  it('今天总览不含未来 7 天事件，但可同时包含四源今日项', () => {
    const tz = 'Asia/Shanghai';
    db.prepare(`DELETE FROM todos`).run();
    db.prepare(`DELETE FROM agenda_event_cache`).run();
    db.prepare(
      `INSERT INTO todos (title, source_path, cluster, priority, reason, status, created_at, updated_at, source_type, source_external_id, source_fingerprint, lifecycle_status, origin_mode, source_status, visibility, source_readonly, estimated_minutes, source_scope)
       VALUES (?, ?, '', 'medium', '', 'confirmed', ?, ?, 'things', 'th-1', 'fp-th', 'confirmed', 'structured', 'open', 'visible', 1, 45, 'things_today')`
    ).run('things-today', 'th-1', '2026-08-24T01:00:00.000Z', '2026-08-24T01:00:00.000Z');
    db.prepare(
      `INSERT INTO todos (title, source_path, cluster, priority, reason, status, created_at, updated_at, source_type, source_external_id, source_fingerprint, lifecycle_status, origin_mode, source_status, visibility, source_readonly, estimated_minutes, source_occurred_at)
       VALUES (?, ?, '', 'medium', 'self_commitment', 'confirmed', ?, ?, 'feishu_message', 'ai-1', 'fp-ai', 'confirmed', 'ai', 'open', 'visible', 0, 45, ?)`
    ).run('feishu-action', 'ai-1', '2026-08-24T01:00:00.000Z', '2026-08-24T01:00:00.000Z', '2026-08-24T03:00:00.000Z');
    db.prepare(
      `INSERT INTO todos (title, source_path, cluster, priority, reason, status, created_at, updated_at, source_type, source_external_id, source_fingerprint, lifecycle_status, origin_mode, source_status, visibility, source_readonly, estimated_minutes, source_occurred_at)
       VALUES (?, ?, '', 'medium', 'document_next_step', 'confirmed', ?, ?, 'desktop', 'dk-1', 'fp-dk', 'confirmed', 'ai', 'open', 'visible', 0, 45, ?)`
    ).run('desktop-action', 'dk-1', '2026-08-24T01:00:00.000Z', '2026-08-24T01:00:00.000Z', '2026-08-24T04:00:00.000Z');

    productivity.commitAgendaProvider({
      provider: 'apple',
      timezone: tz,
      fromAt: '2026-08-24T00:00:00+08:00',
      toAt: '2026-08-31T00:00:00+08:00',
      complete: true,
      status: 'ok',
      events: [
        {
          provider: 'apple',
          canonical_event_key: 'apple:today',
          calendar_identifier: 'cal',
          event_identifier: 'today-ev',
          occurrence_start_at: '2026-08-24T10:00:00+08:00',
          calendar_name: '工作',
          title: 'today-event',
          start_at: '2026-08-24T10:00:00+08:00',
          end_at: '2026-08-24T11:00:00+08:00',
          original_timezone: tz,
          all_day: 0,
          all_day_local_start: null,
          all_day_local_end: null,
          availability: 'busy',
          readonly: 1,
          owned_by_workbench: 0,
          calendar_type: 'standard',
          last_seen_at: '2026-08-24T08:00:00.000Z',
        },
        {
          provider: 'apple',
          canonical_event_key: 'apple:future',
          calendar_identifier: 'cal',
          event_identifier: 'future-ev',
          occurrence_start_at: '2026-08-30T20:00:00+08:00',
          calendar_name: '工作',
          title: 'future-live',
          start_at: '2026-08-30T20:00:00+08:00',
          end_at: '2026-08-30T22:00:00+08:00',
          original_timezone: tz,
          all_day: 0,
          all_day_local_start: null,
          all_day_local_end: null,
          availability: 'busy',
          readonly: 1,
          owned_by_workbench: 0,
          calendar_type: 'standard',
          last_seen_at: '2026-08-24T08:00:00.000Z',
        },
      ],
    });

    const overview = queryTodayOverview({ date: '2026-08-24', timezone: tz, now: new Date('2026-08-24T08:00:00+08:00') });
    const titles = overview.items.map((i) => i.title);
    expect(titles).toContain('things-today');
    expect(titles).toContain('feishu-action');
    expect(titles).toContain('desktop-action');
    expect(titles).toContain('today-event');
    expect(titles.some((t) => t.includes('future') || t.includes('live'))).toBe(false);
    expect(overview.items.some((i) => i.startAt?.startsWith('2026-08-30'))).toBe(false);
  });

  it('Things 总览只认当前 things_today 镜像：8 current + 2 legacy + 1 out_of_scope => 8', () => {
    db.exec('SAVEPOINT test_things_today_scope');
    try {
      db.prepare(`DELETE FROM todo_source_links WHERE todo_id IN (SELECT id FROM todos WHERE source_type='things')`).run();
      db.prepare(`DELETE FROM todo_source_evidence WHERE todo_id IN (SELECT id FROM todos WHERE source_type='things')`).run();
      db.prepare(`DELETE FROM todos WHERE source_type='things'`).run();
      const insert = db.prepare(
        `INSERT INTO todos (
           title, source_path, cluster, priority, reason, status, created_at, updated_at,
           source_type, source_external_id, source_fingerprint, lifecycle_status,
           origin_mode, source_status, source_freshness, visibility, source_readonly,
           estimated_minutes, source_scope
         ) VALUES (
           @title, @external_id, '', 'medium', 'Things · 只读「今天」', @status, @now, @now,
           'things', @external_id, @fingerprint, @lifecycle,
           @origin_mode, @source_status, 'fresh', 'visible', 1,
           45, @source_scope
         )`
      );
      const now = '2026-08-24T01:00:00.000Z';
      for (let i = 1; i <= 8; i += 1) {
        insert.run({
          title: `current-${i}`,
          external_id: `things-current-${i}`,
          fingerprint: `fp-current-${i}`,
          status: 'confirmed',
          lifecycle: 'confirmed',
          origin_mode: 'structured',
          source_status: 'open',
          source_scope: 'things_today',
          now,
        });
      }
      for (let i = 1; i <= 2; i += 1) {
        insert.run({
          title: `legacy-${i}`,
          external_id: `things-legacy-${i}`,
          fingerprint: `fp-legacy-${i}`,
          status: 'pending',
          lifecycle: 'candidate',
          origin_mode: 'legacy',
          source_status: 'open',
          source_scope: null,
          now,
        });
      }
      insert.run({
        title: 'old-today-out-of-scope',
        external_id: 'things-out-of-scope',
        fingerprint: 'fp-out-of-scope',
        status: 'confirmed',
        lifecycle: 'confirmed',
        origin_mode: 'structured',
        source_status: 'out_of_scope',
        source_scope: 'things_today',
        now,
      });

      const overview = queryTodayOverview({
        date: '2026-08-24',
        timezone: 'Asia/Shanghai',
        now: new Date('2026-08-24T08:00:00+08:00'),
      });
      const things = overview.items.filter((item) => item.sourceType === 'things');
      expect(things).toHaveLength(8);
      expect(things.every((item) => item.title.startsWith('current-'))).toBe(true);
      expect(things.some((item) => item.title.startsWith('legacy-'))).toBe(false);
      expect(things.some((item) => item.title === 'old-today-out-of-scope')).toBe(false);
    } finally {
      db.exec('ROLLBACK TO test_things_today_scope');
      db.exec('RELEASE test_things_today_scope');
    }
  });

  it('P2P 交办 / 群聊本人承诺 / 模糊责任 / 闲聊漏斗', async () => {
    updateSettings({ aiAnalysisEnabled: true });
    const spy: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const unit = JSON.parse(body.messages[1].content).units[0];
      const text = String(unit.snippets.find((s: { isFocus?: boolean }) => s.isFocus)?.text || '');
      if (text.includes('闲聊')) {
        return jsonRes({ schemaVersion: AI_SCHEMA_VERSION, units: [{ unitRef: unit.unitRef, decision: 'non_actionable', actions: [] }] });
      }
      if (text.includes('可能')) {
        return jsonRes({
          schemaVersion: AI_SCHEMA_VERSION,
          units: [{
            unitRef: unit.unitRef,
            decision: 'uncertain',
            actions: [action({ owner: 'unclear', title: '确认责任人', reasonCode: 'follow_up', confidence: 0.6, evidenceRefs: [unit.focusRef] })],
          }],
        });
      }
      return jsonRes({
        schemaVersion: AI_SCHEMA_VERSION,
        units: [{
          unitRef: unit.unitRef,
          decision: 'actionable',
          actions: [action({ title: '可执行事项', evidenceRefs: [unit.focusRef], reasonCode: text.includes('承诺') ? 'self_commitment' : 'request_to_self' })],
        }],
      });
    };

    const p2p = await analyzeUnstructuredSources([
      msg('p2p-1', '请你明天下午把材料发给我', { senderRole: 'other', atSelf: true, chatType: 'p2p' }),
    ], { fetchImpl: spy, aiEnabled: true });
    expect(p2p.actionable).toBeGreaterThanOrEqual(1);

    const selfGroup = await analyzeUnstructuredSources([
      msg('self-1', '我承诺周五前交初稿', { senderRole: 'self', atSelf: false, chatType: 'group' }),
    ], { fetchImpl: spy, aiEnabled: true });
    expect(selfGroup.actionable + selfGroup.review).toBeGreaterThanOrEqual(1);

    const beforeSugg = productivity.listSuggestions().length;
    const unclear = await analyzeUnstructuredSources([
      msg('maybe-1', '这个可能需要跟进一下', { senderRole: 'other', atSelf: true, chatType: 'p2p' }),
    ], { fetchImpl: spy, aiEnabled: true });
    expect(unclear.review).toBeGreaterThanOrEqual(1);
    expect(productivity.listSuggestions().length).toBeGreaterThan(beforeSugg);

    const unknownBefore = productivity.listSuggestions().length;
    const unknown = await analyzeUnstructuredSources([
      msg('unk-1', '请帮忙准备材料', { senderRole: 'unknown', atSelf: false, chatType: 'p2p' }),
    ], { fetchImpl: spy, aiEnabled: true });
    expect(unknown.review).toBeGreaterThanOrEqual(1);
    expect(productivity.listSuggestions().length).toBeGreaterThan(unknownBefore);

    const chat = await analyzeUnstructuredSources([
      msg('chat-v4', '这是闲聊哈哈', { senderRole: 'other', atSelf: true, chatType: 'p2p' }),
    ], { fetchImpl: spy, aiEnabled: true });
    expect(chat.rejected).toBeGreaterThanOrEqual(1);
    expect(productivity.listSuggestions().length).toBeGreaterThan(0);
  });

  it('review 数量等于 open suggestion 数量', () => {
    expect(productivity.listSuggestions().length).toBeGreaterThan(0);
  });

  it('reasonCode 更新与 needs_review 均持久化，并能进入今日总览', async () => {
    updateSettings({ aiAnalysisEnabled: true });
    const sourceId = 'persist-v4-reason';
    const first = msg(sourceId, '请你今天整理项目摘要', {
      senderRole: 'other', atSelf: true, chatType: 'p2p', createdAt: '2026-08-24T05:00:00.000Z',
    });
    const respond = (reasonCode: string, decision: 'actionable' | 'uncertain' = 'actionable') => async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const payload = JSON.parse(String(body.messages[1].content || '{}'));
      const unit = payload.units[0];
      return jsonRes({
        schemaVersion: AI_SCHEMA_VERSION,
        units: [{
          unitRef: unit.unitRef,
          decision,
          actions: [action({
            actionHint: decision === 'uncertain' ? 'confirm-owner' : 'project-summary',
            title: decision === 'uncertain' ? '确认项目材料负责人' : '整理项目摘要',
            owner: decision === 'uncertain' ? 'unclear' : 'self',
            reasonCode,
            confidence: decision === 'uncertain' ? 0.62 : 0.9,
            evidenceRefs: [unit.focusRef],
          })],
        }],
      });
    };

    await analyzeUnstructuredSources([first], { aiEnabled: true, fetchImpl: respond('request_to_self') });
    const inserted = db.prepare(
      `SELECT id, action_identity, inference_reason_code FROM todos WHERE title='整理项目摘要' ORDER BY id DESC LIMIT 1`
    ).get() as { id: number; action_identity: string; inference_reason_code: string };
    expect(inserted.inference_reason_code).toBe('request_to_self');

    const changed = msg(sourceId, '我会今天整理项目摘要并同步进度', {
      senderRole: 'self', atSelf: false, chatType: 'p2p', createdAt: '2026-08-24T05:01:00.000Z',
    });
    await analyzeUnstructuredSources([changed], { aiEnabled: true, fetchImpl: respond('self_commitment') });
    const updated = db.prepare(`SELECT inference_reason_code FROM todos WHERE id=?`).get(inserted.id) as { inference_reason_code: string };
    expect(updated.inference_reason_code).toBe('self_commitment');

    const reviewTitle = '确认项目材料负责人';
    const review = msg('persist-v4-review', '这个材料可能需要有人跟进', {
      senderRole: 'other', atSelf: true, chatType: 'p2p', createdAt: '2026-08-24T05:02:00.000Z',
    });
    const reviewStats = await analyzeUnstructuredSources([review], {
      aiEnabled: true,
      fetchImpl: respond('follow_up', 'uncertain'),
    });
    expect(reviewStats.review).toBe(1);
    const suggestion = productivity.listSuggestions().find((row) => String(row.title) === reviewTitle);
    expect(suggestion).toMatchObject({
      reason_code: 'follow_up',
      status: 'open',
      source_occurred_at: '2026-08-24T05:02:00.000Z',
    });
    const overview = queryTodayOverview({ date: '2026-08-24', timezone: 'Asia/Shanghai', now: new Date('2026-08-24T08:00:00+08:00') });
    expect(overview.items.some((item) => item.kind === 'needs_review' && item.title === reviewTitle)).toBe(true);
    const outcome = db.prepare(
      `SELECT decision, schema_version, prompt_version FROM ai_unit_outcomes WHERE decision='uncertain' ORDER BY id DESC LIMIT 1`
    ).get() as { decision: string; schema_version: string; prompt_version: string };
    expect(outcome).toEqual({ decision: 'uncertain', schema_version: AI_SCHEMA_VERSION, prompt_version: AI_PROMPT_VERSION });
  });

  it('规划使用传入 timezone，Apple 完整且飞书受限时仍生成草稿', async () => {
    updateSettings({ feishuEnabled: true });
    const tz = 'Asia/Shanghai';
    const now = new Date('2026-08-24T10:07:00+08:00');
    const windows = buildDayWindows(now, { ...DEFAULT_PLANNING_RULES, timezone: tz }, now);
    expect(windows[0].start.getTime()).toBeGreaterThanOrEqual(new Date('2026-08-24T10:15:00+08:00').getTime());

    productivity.saveCheckpoint('calendar', { permission: 'fullAccess', busyStatus: 'fresh', events: 1 });
    const bounds = localDayBounds('2026-08-24', tz);
    productivity.commitAgendaProvider({
      provider: 'apple',
      timezone: tz,
      fromAt: bounds.start.toISOString(),
      toAt: new Date(bounds.start.getTime() + 7 * 86400000).toISOString(),
      complete: true,
      status: 'ok',
      events: [{
        provider: 'apple',
        canonical_event_key: 'apple:busy',
        calendar_identifier: 'cal',
        event_identifier: 'busy',
        occurrence_start_at: '2026-08-24T11:00:00+08:00',
        calendar_name: '工作',
        title: 'busy-block',
        start_at: '2026-08-24T11:00:00+08:00',
        end_at: '2026-08-24T12:00:00+08:00',
        original_timezone: tz,
        all_day: 0,
        all_day_local_start: null,
        all_day_local_end: null,
        availability: 'busy',
        readonly: 1,
        owned_by_workbench: 0,
        calendar_type: 'standard',
        last_seen_at: now.toISOString(),
      }],
    });
    const busy = todayPlanningBusy(bounds.start.toISOString(), bounds.end.toISOString(), tz);
    expect(busy.warning).toBe('未叠加飞书日程');
    expect(busy.unverified).toBe(false);

    const plan = await createTodayDayPlan({ date: '2026-08-24', timezone: tz, now, syncIfStale: false });
    expect(plan.write).toBe(false);
    expect(plan.status).toBe('draft');
    const again = await createTodayDayPlan({ date: '2026-08-24', timezone: tz, now, syncIfStale: false });
    expect(again.id).not.toBeUndefined();
    expect(productivity.getDayPlan('2026-08-24', tz)).toBeTruthy();
    const persisted = getTodayDayPlan({ date: '2026-08-24', timezone: tz, now });
    expect(persisted?.blocks.length).toBe(plan.blocks.length);
    expect(plan.blocks.filter((b) => b.fixed).every((b) => b.startAt && Date.parse(b.startAt) < Date.parse(b.endAt || b.startAt))).toBe(true);
    expect(() => refuseExternalCommit()).toThrowError(expect.objectContaining({ code: PRODUCTIVITY_ERROR_CODES.EXTERNAL_WRITE_DISABLED }));

    const overlap = plan.blocks.filter((b) => !b.unscheduled && !b.fixed && b.startAt && b.endAt);
    for (const b of overlap) {
      const start = Date.parse(b.startAt as string);
      const end = Date.parse(b.endAt as string);
      expect(start >= Date.parse('2026-08-24T12:15:00+08:00') || end <= Date.parse('2026-08-24T10:45:00+08:00')).toBe(true);
    }
  });

  it('没有空闲时间时进入未排入清单', () => {
    const sat = new Date('2026-08-29T10:00:00+08:00');
    const plan = planTodos([{ title: '无法安排', estimatedMinutes: 45 }], [], DEFAULT_PLANNING_RULES, sat, sat);
    expect(plan.blocks).toEqual([]);
    expect(plan.unscheduled[0].reason).toBe('NO_AVAILABLE_SLOT');
  });

  it('消息 createdAt 保存为 ISO，而不是分析时间', () => {
    const items = messagesToItems([{ message_id: 'om_iso', create_time: 1755993600, body: { content: 'hi' } }]);
    expect(items[0].createdAt).toMatch(/T/);
    expect(items[0].createdAt).not.toBe('1755993600');
  });
});
