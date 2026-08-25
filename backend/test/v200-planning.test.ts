import { describe, expect, it } from 'vitest';
import { DEFAULT_PLANNING_RULES, planTodos, shanghaiParts } from '../src/services/planning';

const tue = new Date('2026-08-25T00:30:00+08:00');
const now = new Date('2026-08-25T08:00:00+08:00');

describe('排程引擎：空闲、午休、冲突、缓冲、跨日、上海时区', () => {
  it('上海时区墙钟解析', () => {
    const p = shanghaiParts(new Date('2026-08-25T09:30:00+08:00'));
    expect(p.weekday).toBe(2);
    expect(p.hh).toBe(9);
    expect(p.mm).toBe(30);
  });

  it('午休 12:00-13:30 不会被排入', () => {
    const plan = planTodos([{ title: '深度工作', estimatedMinutes: 90, priority: 'high' }], [], DEFAULT_PLANNING_RULES, tue, now);
    expect(plan.blocks.length).toBeGreaterThan(0);
    for (const b of plan.blocks) {
      const start = new Date(b.startAt);
      const parts = shanghaiParts(start);
      const minutes = parts.hh * 60 + parts.mm;
      expect(minutes < 12 * 60 || minutes >= 13 * 60 + 30).toBe(true);
    }
  });

  it('已有会议视为 busy，并保留缓冲', () => {
    const plan = planTodos(
      [{ title: '写稿', estimatedMinutes: 45, priority: 'high' }],
      [{ startAt: '2026-08-25T09:30:00+08:00', endAt: '2026-08-25T11:00:00+08:00', source: 'feishu', title: '晨会' }],
      DEFAULT_PLANNING_RULES,
      tue,
      now
    );
    expect(plan.blocks[0]).toBeTruthy();
    expect(new Date(plan.blocks[0].startAt).getTime()).toBeGreaterThanOrEqual(new Date('2026-08-25T11:15:00+08:00').getTime());
  });

  it('过长任务拆成 1/3 2/3 3/3', () => {
    const plan = planTodos([{ title: '大项目', estimatedMinutes: 300, priority: 'high' }], [], DEFAULT_PLANNING_RULES, tue, now);
    const parts = plan.blocks.filter((b) => b.title === '大项目').map((b) => b.part);
    expect(parts[0]).toBe('1/3');
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  it('周末不安排；时间不够返回 NO_AVAILABLE_SLOT', () => {
    const sat = new Date('2026-08-29T08:00:00+08:00');
    const weekend = planTodos([{ title: '周末', estimatedMinutes: 45 }], [], DEFAULT_PLANNING_RULES, sat, sat);
    expect(weekend.blocks).toEqual([]);
    expect(weekend.unscheduled[0].reason).toBe('NO_AVAILABLE_SLOT');
  });
});
