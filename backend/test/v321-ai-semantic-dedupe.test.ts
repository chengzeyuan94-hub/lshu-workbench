import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'wb-v321-semantic-'));
process.env.WORKBENCH_DATA_DIR = dbDir;
process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
process.env.DEEPSEEK_DAILY_MAX_ESTIMATED_USD = '1.00';
process.env.VITEST = '1';

const { default: db, productivity, updateSettings } = await import('../src/db');
const { analyzeUnstructuredSources } = await import('../src/services/actionIntentAnalyzer');
const { queryTodayOverview } = await import('../src/services/todayOverview');
const { AI_SCHEMA_VERSION } = await import('../src/services/aiAnalysisSchema');
const { fingerprintSource } = await import('../src/services/hash');
const {
  areSemanticallyEquivalentActions,
  buildActionIdentity,
} = await import('../src/services/actionIdentity');

afterAll(() => rmSync(dbDir, { recursive: true, force: true }));

function message(id: string, text: string, createdAt = '2026-08-24T02:00:00.000Z') {
  return {
    sourceType: 'feishu_message' as const,
    sourceExternalId: id,
    sourceFingerprint: fingerprintSource('feishu_message', id),
    title: text.slice(0, 20),
    summary: text,
    status: 'open' as const,
    createdAt,
    payload: {
      chat_hash: 'semantic-dedupe-chat',
      senderRole: 'other',
      atSelf: true,
      replyToSelf: false,
      chatType: 'p2p',
    },
  };
}

function responseFor(
  choose: (focus: string) => { title: string; hint?: string; owner?: 'self' | 'shared'; dueAt?: string | null }
): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body || '{}'));
    const payload = JSON.parse(String(request.messages[1].content || '{}'));
    const units = payload.units.map((unit: Record<string, unknown>) => {
      const snippets = unit.snippets as Array<{ ref: string; text: string; isFocus?: boolean }>;
      const focus = snippets.find((snippet) => snippet.isFocus)?.text || '';
      const selected = choose(focus);
      return {
        unitRef: unit.unitRef,
        decision: 'actionable',
        actions: [{
          actionHint: selected.hint || 'semantic-action',
          owner: selected.owner || 'self',
          intent: 'create',
          title: selected.title,
          reasonCode: 'request_to_self',
          priority: 'medium',
          dueAt: selected.dueAt ?? null,
          estimatedMinutes: 45,
          confidence: 0.9,
          project: null,
          evidenceRefs: [unit.focusRef],
        }],
      };
    });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ schemaVersion: AI_SCHEMA_VERSION, units }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 12 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('V4 AI semantic identity and overview dedupe', () => {
  it('轻微措辞可判为同一动作，但 owner / due / source day 都隔离', () => {
    expect(areSemanticallyEquivalentActions('提供播客引流私域微信二维码', '提供私域引流微信二维码')).toBe(true);
    expect(areSemanticallyEquivalentActions('提供科技频道两到三条选题链接', '提供科技赛道选题链接')).toBe(true);
    expect(areSemanticallyEquivalentActions('安排将10kg物品运回', '安排将10kg物品运回')).toBe(true);
    expect(areSemanticallyEquivalentActions('提供课程资料链接', '确认课程资料链接')).toBe(false);

    const base = {
      sourceNamespace: 'feishu_message' as const,
      sourceLocalDate: '2026-08-24',
      objectHint: '整理项目摘要',
      owner: 'self',
      dueAt: '2026-08-24T10:00:00+08:00',
      project: null,
    };
    const identity = buildActionIdentity(base);
    expect(buildActionIdentity({ ...base, owner: 'shared' })).not.toBe(identity);
    expect(buildActionIdentity({ ...base, dueAt: '2026-08-24T11:00:00+08:00' })).not.toBe(identity);
    expect(buildActionIdentity({ ...base, sourceLocalDate: '2026-08-25' })).not.toBe(identity);
    expect(buildActionIdentity({ ...base, sourceNamespace: 'desktop' })).not.toBe(identity);
  });

  it('不同飞书消息的同一语义动作只落一个 todo，并追加两份 link/evidence', async () => {
    updateSettings({ aiAnalysisEnabled: true, timezone: 'Asia/Shanghai' });
    const stats = await analyzeUnstructuredSources([
      message('qr-semantic-a', '请提供播客引流私域二维码'),
      message('qr-semantic-b', '麻烦提供私域引流微信二维码'),
    ], {
      aiEnabled: true,
      fetchImpl: responseFor((focus) => focus.includes('播客')
        ? { title: '提供播客引流私域微信二维码', hint: 'provide-qr-code' }
        : { title: '提供私域引流微信二维码', hint: 'share-private-qr' }),
    });

    expect(stats.createdTodoIds).toHaveLength(1);
    expect(stats.updatedTodoIds).toHaveLength(1);
    const rows = db.prepare(
      `SELECT id, title, action_owner FROM todos
       WHERE origin_mode='ai' AND source_type='feishu_message' AND title LIKE '%二维码%'`
    ).all() as Array<{ id: number; title: string; action_owner: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].action_owner).toBe('self');
    expect(productivity.getEvidence(rows[0].id)).toHaveLength(2);
    const links = db.prepare(`SELECT COUNT(*) AS n FROM todo_source_links WHERE todo_id=?`).get(rows[0].id) as { n: number };
    expect(links.n).toBe(2);

    const replay = await analyzeUnstructuredSources([
      message('qr-semantic-a', '请提供播客引流私域二维码'),
      message('qr-semantic-b', '麻烦提供私域引流微信二维码'),
    ], {
      aiEnabled: true,
      fetchImpl: async () => {
        throw new Error('cache replay must not call model');
      },
    });
    expect(replay.cacheHits).toBe(2);
    expect(replay.createdTodoIds).toHaveLength(0);
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM todos
       WHERE origin_mode='ai' AND source_type='feishu_message' AND title LIKE '%二维码%'`
    ).get()).toMatchObject({ n: 1 });
    expect(productivity.getEvidence(rows[0].id)).toHaveLength(2);
  });

  it('相同标题但不同截止时间或不同责任类型，不会误并', async () => {
    updateSettings({ aiAnalysisEnabled: true, timezone: 'Asia/Shanghai' });
    await analyzeUnstructuredSources([
      message('due-a', '十点提交排期'),
      message('due-b', '十一点提交排期'),
      message('owner-a', '我整理责任边界'),
      message('owner-b', '我们共同整理责任边界'),
    ], {
      aiEnabled: true,
      fetchImpl: responseFor((focus) => {
        if (focus.includes('十点')) return { title: '提交今日排期', dueAt: '2026-08-24T10:00:00+08:00' };
        if (focus.includes('十一点')) return { title: '提交今日排期', dueAt: '2026-08-24T11:00:00+08:00' };
        if (focus.includes('共同')) return { title: '整理责任边界', owner: 'shared' };
        return { title: '整理责任边界', owner: 'self' };
      }),
    });

    const dueRows = db.prepare(`SELECT id FROM todos WHERE origin_mode='ai' AND title='提交今日排期'`).all();
    const ownerRows = db.prepare(`SELECT action_owner FROM todos WHERE origin_mode='ai' AND title='整理责任边界' ORDER BY action_owner`).all() as Array<{ action_owner: string }>;
    expect(dueRows).toHaveLength(2);
    expect(ownerRows.map((row) => row.action_owner)).toEqual(['self', 'shared']);
  });

  it('历史重复不删除：总览折叠语义重复，但保留不同 due / owner', () => {
    db.exec('SAVEPOINT semantic_overview_history');
    try {
      const insert = db.prepare(
        `INSERT INTO todos (
           title, source_path, cluster, priority, reason, status, created_at, updated_at,
           source_type, source_external_id, source_fingerprint, lifecycle_status,
           origin_mode, source_status, visibility, source_readonly, estimated_minutes,
           source_occurred_at, due_at, action_identity, action_owner
         ) VALUES (
           @title, @identity, '', 'medium', 'request_to_self', 'pending', @now, @now,
           'feishu_message', @identity, @fingerprint, 'candidate',
           'ai', 'open', 'visible', 0, 45,
           '2026-08-24T02:00:00.000Z', @due, @identity, @owner
         )`
      );
      const now = '2026-08-24T03:00:00.000Z';
      const rows = [
        { title: '提供历史播客引流私域二维码', due: null, owner: null },
        { title: '提供历史私域引流微信二维码', due: null, owner: null },
        { title: '提供历史播客引流私域的微信二维码', due: null, owner: null },
        { title: '提交品牌方案', due: '2026-08-24T10:00:00+08:00', owner: 'self' },
        { title: '提交品牌方案', due: '2026-08-24T11:00:00+08:00', owner: 'self' },
        { title: '确认直播流程', due: null, owner: 'self' },
        { title: '确认直播流程', due: null, owner: 'shared' },
      ];
      rows.forEach((row, index) => insert.run({
        ...row,
        identity: `legacy-semantic-${index}`,
        fingerprint: `legacy-semantic-fp-${index}`,
        now,
      }));

      const overview = queryTodayOverview({
        date: '2026-08-24', timezone: 'Asia/Shanghai', now: new Date('2026-08-24T08:00:00+08:00'),
      });
      expect(overview.items.filter((item) => item.title.includes('历史') && item.title.includes('二维码'))).toHaveLength(1);
      expect(overview.items.filter((item) => item.title === '提交品牌方案')).toHaveLength(2);
      expect(overview.items.filter((item) => item.title === '确认直播流程')).toHaveLength(2);
      const stored = db.prepare(`SELECT COUNT(*) AS n FROM todos WHERE source_external_id LIKE 'legacy-semantic-%'`).get() as { n: number };
      expect(stored.n).toBe(7);
    } finally {
      db.exec('ROLLBACK TO semantic_overview_history');
      db.exec('RELEASE semantic_overview_history');
    }
  });
});
