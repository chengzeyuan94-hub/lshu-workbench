import { describe, expect, it } from 'vitest';
import type { DayPlanBlock, TodayOverviewItem } from '../../types';
import {
  getScheduledBlocks,
  getTimelineBlocks,
  humanizePlanWarning,
  humanizeUnscheduled,
  overviewStateLabel,
} from './todoPresentation';

const block = (patch: Partial<DayPlanBlock> = {}): DayPlanBlock => ({
  stableKey: 'task:1',
  title: '写方案',
  startAt: '2026-08-24T10:00:00+08:00',
  endAt: '2026-08-24T11:00:00+08:00',
  sourceType: 'things',
  kind: 'task',
  fixed: false,
  schedulable: true,
  minutes: 60,
  unscheduled: false,
  ...patch,
});

const item = (patch: Partial<TodayOverviewItem> = {}): TodayOverviewItem => ({
  stableKey: 'task:1',
  sourceType: 'things',
  kind: 'task',
  title: '写方案',
  readonly: true,
  fixed: false,
  schedulable: true,
  evidenceCount: 1,
  state: 'open',
  ...patch,
});

describe('todo V4.2 presentation', () => {
  it('only treats non-fixed scheduled blocks with a complete range as scheduled work', () => {
    const blocks = [
      block(),
      block({ stableKey: 'fixed', fixed: true }),
      block({ stableKey: 'unscheduled', unscheduled: true }),
      block({ stableKey: 'missing-start', startAt: null }),
    ];
    expect(getTimelineBlocks(blocks).map((entry) => entry.stableKey)).toEqual(['task:1', 'fixed']);
    expect(getScheduledBlocks(blocks).map((entry) => entry.stableKey)).toEqual(['task:1']);
  });

  it('never exposes scheduling engineering codes in user-facing reasons', () => {
    expect(humanizeUnscheduled('NO_AVAILABLE_SLOT', 'move it')).toBe('今天已没有足够的空闲时间');
    expect(humanizeUnscheduled('DURATION_TOO_LONG', '')).toBe('预计时长超过剩余时间');
    expect(humanizeUnscheduled('CALENDAR_COVERAGE_LIMITED', '')).toBe('日历覆盖不完整');
    expect(humanizeUnscheduled('NEEDS_REVIEW', '')).toBe('需要先确认事项');
    expect(humanizeUnscheduled('AI_FOCUS_LIMIT', '')).toContain('最多 5 件');
    expect(humanizeUnscheduled('UNKNOWN_INTERNAL_CODE', '')).not.toContain('UNKNOWN_INTERNAL_CODE');
  });

  it('turns coverage warnings into concise product language', () => {
    expect(humanizePlanWarning('CALENDAR_COVERAGE_LIMITED')).toBe('日历覆盖不完整，本地草稿仅供参考');
    expect(humanizePlanWarning(null, true)).toBe('日历覆盖不完整，本地草稿仅供参考');
    expect(humanizePlanWarning(null, false)).toBe('');
  });

  it('uses human lifecycle labels for overview rows', () => {
    expect(overviewStateLabel(item(), false)).toBe('待排程');
    expect(overviewStateLabel(item(), true)).toBe('已排程');
    expect(overviewStateLabel(item({ kind: 'needs_review' }), false)).toBe('需确认');
    expect(overviewStateLabel(item({ kind: 'fixed_event', fixed: true }), false)).toBe('固定日程');
    expect(overviewStateLabel(item({ kind: 'completed' }), false)).toBe('已完成');
  });
});
