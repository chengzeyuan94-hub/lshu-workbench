import type { DayPlanBlock, TodayOverviewItem } from '../../types';

export function getTimelineBlocks(blocks: DayPlanBlock[] = []): DayPlanBlock[] {
  return blocks.filter((block) => (
    !block.unscheduled
    && Boolean(block.startAt)
    && Boolean(block.endAt)
  ));
}

export function getScheduledBlocks(blocks: DayPlanBlock[] = []): DayPlanBlock[] {
  return getTimelineBlocks(blocks).filter((block) => !block.fixed);
}

export function humanizeUnscheduled(reason = '', suggestion = ''): string {
  const raw = `${reason} ${suggestion}`.toUpperCase();
  if (raw.includes('AI_FOCUS_LIMIT') || raw.includes('最多 5 件')) {
    return 'AI 将它留到下一轮，今天先聚焦最多 5 件主任务';
  }
  if (raw.includes('NO_AVAILABLE_SLOT') || raw.includes('没有足够') || raw.includes('无空闲')) {
    return '今天已没有足够的空闲时间';
  }
  if (raw.includes('DURATION') || raw.includes('TOO_LONG') || raw.includes('时长')) {
    return '预计时长超过剩余时间';
  }
  if (raw.includes('COVERAGE') || raw.includes('CALENDAR') || raw.includes('日历')) {
    return '日历覆盖不完整';
  }
  if (raw.includes('REVIEW') || raw.includes('CONFIRM') || raw.includes('确认')) {
    return '需要先确认事项';
  }
  return '需要改期、缩短时长或调整工作时间';
}

export function humanizePlanWarning(warning?: string | null, unverified = false): string {
  const raw = String(warning || '').toUpperCase();
  if (unverified || raw.includes('COVERAGE') || raw.includes('CALENDAR') || raw.includes('BUSY')) {
    return '日历覆盖不完整，本地草稿仅供参考';
  }
  if (raw.includes('FEISHU') || raw.includes('飞书')) {
    return '未叠加飞书日程，排程结果可能需要调整';
  }
  return warning ? '排程依据尚不完整，本地草稿仅供参考' : '';
}

export function overviewStateLabel(item: TodayOverviewItem, planned: boolean): string {
  if (item.kind === 'fixed_event' || item.fixed) return '固定日程';
  if (item.kind === 'needs_review') return '需确认';
  if (item.kind === 'completed') return '已完成';
  if (planned) return '已排程';
  if (item.schedulable) return '待排程';
  return '仅记录';
}
