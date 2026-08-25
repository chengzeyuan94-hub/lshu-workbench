export interface TodoActionFlags {
  canConfirm: boolean;
  canIgnore: boolean;
  canPlan: boolean;
  canCommitPlan: boolean;
  canComplete: boolean;
  canReopen: boolean;
}

export function todoActionFlags(input: {
  status: string;
  lifecycleStatus?: string;
  autoScheduleEnabled?: boolean;
  calendarAvailable?: boolean;
  sourceReadonly?: boolean;
  visibility?: string;
  sourceStatus?: string;
}): TodoActionFlags {
  const life = input.lifecycleStatus || mapStatusToLifecycle(input.status);
  const blocked = ['ignored', 'completed', 'canceled'].includes(life) || input.visibility === 'archived' || input.visibility === 'hidden_local' || ['missing', 'out_of_scope', 'canceled'].includes(String(input.sourceStatus || ''));
  const openish = !blocked && input.status !== 'ignored';
  const readonly = input.sourceReadonly === true;
  return {
    canConfirm: !readonly && (input.status === 'pending' || life === 'candidate'),
    canIgnore: openish,
    canPlan: openish,
    canCommitPlan: false,
    canComplete: openish && !readonly,
    canReopen: !readonly && (life === 'completed' || life === 'suspected_done'),
  };
}

export function mapStatusToLifecycle(status: string): string {
  if (status === 'confirmed') return 'confirmed';
  if (status === 'ignored') return 'ignored';
  return 'candidate';
}

export function emptyStateText(view: string): string {
  switch (view) {
    case 'inbox':
    case 'pending':
      return '智能收件箱是空的。可以先同步桌面、Things 或飞书。';
    case 'today':
      return '今天还没有计划中的时间块。';
    case 'planned':
      return '还没有已排程的待办。';
    case 'suspected_done':
      return '没有疑似完成的任务。';
    case 'completed':
      return '还没有已完成的任务。';
    case 'things':
      return '还没有来自 Things 的待推进任务。';
    case 'ai':
      return '还没有 AI 建议。开启分析并同步后才会出现。';
    case 'review':
      return '没有待复核的 AI 建议。';
    case 'ignored':
      return '没有已忽略的任务。';
    default:
      return '这里还没有内容。';
  }
}
