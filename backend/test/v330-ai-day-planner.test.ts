import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'wb-v330-ai-day-plan-'));
process.env.WORKBENCH_DATA_DIR = dbDir;
process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
process.env.DEEPSEEK_DAILY_MAX_ESTIMATED_USD = '1.00';
process.env.VITEST = '1';

const { default: db, updateSettings, productivity } = await import('../src/db');
const { LSHU_WORK_PROFILE } = await import('../src/config/lshuWorkProfile');
const { buildWorkPatternProfile, selectTodayFocusWithAi } = await import('../src/services/aiDayPlanner');
const { createTodayDayPlan, getTodayDayPlan } = await import('../src/services/dayPlanService');
const { localDayBounds } = await import('../src/services/localDay');

afterAll(() => rmSync(dbDir, { recursive: true, force: true }));

function responseFor(stableKeys: string[], dailyMessage = '今天把最重要的五件事稳稳落地') {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          schemaVersion: 'day-planner-v1',
          profileSummary: '以创作和产品交付为主，保留必要缓冲',
          planSummary: '上午先完成深度创作，下午处理开发与交付',
          dailyMessage,
          dailyMessageEn: 'MAKE THE IMPORTANT WORK VISIBLE.',
          selections: stableKeys.map((stableKey, index) => ({
            stableKey,
            rank: index + 1,
            estimatedMinutes: 45,
            preferredWindow: index < 2 ? 'morning' : 'afternoon',
            reason: `第 ${index + 1} 项有明确交付价值`,
          })),
        }),
      },
    }],
    usage: { prompt_tokens: 120, completion_tokens: 80 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('AI 今日规划 V1', () => {
  it('固化画像来自一次性梳理，运行时不包含本机路径或原始文件名', () => {
    const profile = buildWorkPatternProfile();
    expect(profile.version).toBe(LSHU_WORK_PROFILE.version);
    expect(profile.workingStyle.dailyFocusLimit).toBe(5);
    expect(profile.coreDomains.length).toBeGreaterThan(4);
    expect(JSON.stringify(profile)).not.toContain('/Users/');
    expect(JSON.stringify(profile)).not.toContain('Desktop/');
  });

  it('每次只发送固化画像、今日脱敏候选和固定忙碌时间', async () => {
    updateSettings({ aiAnalysisEnabled: true, aiPlanningConsent: true });
    let sent = '';
    const tasks = Array.from({ length: 6 }, (_, index) => ({
      stableKey: `things:t-${index}`,
      sourceType: 'things' as const,
      kind: 'task' as const,
      title: `今日任务 ${index + 1}`,
      estimatedMinutes: 45,
      readonly: true,
      fixed: false,
      schedulable: true,
      evidenceCount: 1,
      state: 'confirmed',
    }));
    const result = await selectTodayFocusWithAi({
      candidates: [
        ...tasks,
        {
          stableKey: 'cal:fixed',
          sourceType: 'apple_calendar',
          kind: 'fixed_event',
          title: '不应上传的会议标题',
          startAt: '2026-08-25T03:00:00.000Z',
          endAt: '2026-08-25T04:00:00.000Z',
          readonly: true,
          fixed: true,
          schedulable: false,
          evidenceCount: 1,
          state: 'fixed',
        },
      ],
      date: '2026-08-25',
      timezone: 'Asia/Shanghai',
      now: new Date('2026-08-25T09:00:00+08:00'),
      fetchImpl: async (_url, init) => {
        sent = String(init.body || '');
        return responseFor(tasks.slice(0, 5).map((task) => task.stableKey));
      },
    });
    expect(result.selectedCount).toBe(5);
    expect(result.dailyMessage).toContain('最重要');
    expect(sent).toContain(LSHU_WORK_PROFILE.version);
    expect(sent).toContain('今日任务 1');
    expect(sent).toContain('fixedBusy');
    expect(sent).not.toContain('不应上传的会议标题');
    expect(sent).not.toContain('/Users/');
  });

  it('单按钮 AI 规划最多排入五件，避开固定事件并持久化寄语', async () => {
    updateSettings({ aiAnalysisEnabled: true, aiPlanningConsent: true });
    db.prepare(`DELETE FROM todos`).run();
    db.prepare(`DELETE FROM agenda_event_cache`).run();
    const createdAt = '2026-08-25T00:30:00.000Z';
    for (let index = 0; index < 6; index += 1) {
      db.prepare(
        `INSERT INTO todos (title, source_path, cluster, priority, reason, status, created_at, updated_at, source_type, source_external_id, source_fingerprint, lifecycle_status, origin_mode, source_status, visibility, source_readonly, estimated_minutes, source_scope)
         VALUES (?, ?, '', 'medium', '', 'confirmed', ?, ?, 'things', ?, ?, 'confirmed', 'structured', 'open', 'visible', 1, 45, 'things_today')`
      ).run(`今日重点 ${index + 1}`, `thing-${index}`, createdAt, createdAt, `thing-${index}`, `fp-ai-plan-${index}`);
    }
    const timezone = 'Asia/Shanghai';
    const bounds = localDayBounds('2026-08-25', timezone);
    productivity.commitAgendaProvider({
      provider: 'apple',
      timezone,
      fromAt: bounds.start.toISOString(),
      toAt: bounds.end.toISOString(),
      complete: true,
      status: 'ok',
      events: [{
        provider: 'apple',
        canonical_event_key: 'apple:fixed-ai-plan',
        calendar_identifier: 'calendar-work',
        event_identifier: 'event-fixed',
        occurrence_start_at: '2026-08-25T03:00:00.000Z',
        calendar_name: '工作',
        title: '固定会议',
        start_at: '2026-08-25T03:00:00.000Z',
        end_at: '2026-08-25T04:00:00.000Z',
        original_timezone: timezone,
        all_day: 0,
        all_day_local_start: null,
        all_day_local_end: null,
        availability: 'busy',
        readonly: 1,
        owned_by_workbench: 0,
        calendar_type: 'standard',
        last_seen_at: createdAt,
      }],
    });

    const selected = Array.from({ length: 5 }, (_, index) => `things:thing-${index}`);
    const plan = await createTodayDayPlan({
      date: '2026-08-25',
      timezone,
      now: new Date('2026-08-25T09:30:00+08:00'),
      syncIfStale: false,
      mode: 'ai',
      fetchImpl: async () => responseFor(selected, '今天先把课程与内容交付稳稳推进'),
    });
    const scheduled = plan.blocks.filter((block) => !block.fixed && !block.unscheduled);
    const fixed = plan.blocks.find((block) => block.fixed);
    expect(plan.strategy).toBe('ai');
    expect(plan.planner?.selectedCount).toBe(5);
    expect(scheduled).toHaveLength(5);
    expect(plan.unscheduled.some((entry) => entry.reason === 'AI_FOCUS_LIMIT')).toBe(true);
    expect(fixed?.title).toBe('固定会议');
    for (const block of scheduled) {
      expect(Date.parse(block.endAt as string) <= Date.parse(fixed?.startAt as string)
        || Date.parse(block.startAt as string) >= Date.parse(fixed?.endAt as string)).toBe(true);
    }
    const persisted = getTodayDayPlan({ date: '2026-08-25', timezone, now: new Date('2026-08-25T09:30:00+08:00') });
    expect(persisted?.planner?.dailyMessage).toBe('今天先把课程与内容交付稳稳推进');
  });
});
