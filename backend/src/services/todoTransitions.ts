import { PRODUCTIVITY_ERROR_CODES, ProductivityError } from '../connectors/errors';

export type OriginMode = 'structured' | 'ai' | 'manual' | 'legacy';
export type SourceStatus = 'open' | 'completed' | 'canceled' | 'missing' | 'out_of_scope';
export type SourceFreshness = 'fresh' | 'stale' | 'unknown';
export type Visibility = 'visible' | 'archived' | 'hidden_local';
export type LifecycleStatus =
  | 'candidate'
  | 'confirmed'
  | 'planned'
  | 'in_progress'
  | 'suspected_done'
  | 'completed'
  | 'canceled'
  | 'ignored';

export type TodoUserAction = 'confirm' | 'ignore' | 'hide' | 'unhide' | 'edit' | 'complete' | 'reopen' | 'archive';

export interface TodoTransitionState {
  status: string;
  lifecycle_status: string;
  origin_mode: OriginMode | string;
  source_status: SourceStatus | string;
  source_freshness: SourceFreshness | string;
  source_readonly: number;
  visibility: Visibility | string;
  consecutive_missing_count: number;
  last_full_seen_at?: string | null;
  archived_at?: string | null;
  archive_reason?: string | null;
  title?: string;
  due_at?: string | null;
  cluster?: string;
  estimated_minutes?: number | null;
  user_edited_at?: string | null;
  completed_at?: string | null;
  completion_source?: string | null;
  completion_confidence?: number | null;
}

const TERMINAL_USER = new Set(['completed', 'ignored']);

const UNSCHEDULABLE_VISIBILITY = new Set(['archived', 'hidden_local']);
const UNSCHEDULABLE_SOURCE = new Set(['completed', 'canceled', 'ignored', 'missing', 'out_of_scope']);
const UNSCHEDULABLE_LIFE = new Set(['completed', 'canceled', 'ignored', 'archived']);

export function canScheduleTodo(state: {
  visibility?: string | null;
  source_status?: string | null;
  lifecycle_status?: string | null;
  status?: string | null;
}): boolean {
  if (UNSCHEDULABLE_VISIBILITY.has(String(state.visibility || 'visible'))) return false;
  if (UNSCHEDULABLE_SOURCE.has(String(state.source_status || 'open'))) return false;
  if (UNSCHEDULABLE_LIFE.has(String(state.lifecycle_status || ''))) return false;
  if (state.status === 'ignored') return false;
  return true;
}

export function applyTodoTransition(
  current: TodoTransitionState,
  patch: Partial<TodoTransitionState>,
  now = new Date().toISOString()
): TodoTransitionState {
  const next: TodoTransitionState = { ...current };

  if (patch.source_freshness) next.source_freshness = patch.source_freshness;

  if (current.source_readonly === 1) {
    if (patch.title !== undefined && patch.title === current.title) next.title = patch.title;
    if (Object.prototype.hasOwnProperty.call(patch, 'due_at')) {
      next.due_at = patch.due_at ?? null;
    }
    if (patch.cluster !== undefined) next.cluster = patch.cluster;
  } else {
    if (patch.title !== undefined) next.title = patch.title;
    if (Object.prototype.hasOwnProperty.call(patch, 'due_at')) next.due_at = patch.due_at ?? null;
    if (patch.cluster !== undefined) next.cluster = patch.cluster;
    if (patch.estimated_minutes !== undefined) next.estimated_minutes = patch.estimated_minutes;
    if (patch.title !== undefined || Object.prototype.hasOwnProperty.call(patch, 'due_at')) {
      next.user_edited_at = now;
    }
  }

  if (patch.visibility === 'hidden_local' || patch.visibility === 'visible') {
    next.visibility = patch.visibility;
  }

  if (patch.source_status) {
    next.source_status = patch.source_status;
    if (current.origin_mode === 'structured') {
      if (patch.source_status === 'open') {
        next.lifecycle_status = current.visibility === 'hidden_local' ? current.lifecycle_status : 'confirmed';
        next.status = 'confirmed';
        if (current.source_status === 'missing' || current.source_status === 'out_of_scope') {
          next.consecutive_missing_count = 0;
        }
        if (current.visibility === 'hidden_local') next.visibility = 'hidden_local';
        else if (next.visibility === 'archived' && (current.source_status === 'missing' || current.source_status === 'out_of_scope')) {
          next.visibility = 'visible';
        }
      } else if (patch.source_status === 'completed') {
        next.lifecycle_status = 'completed';
        next.status = 'confirmed';
        next.visibility = current.visibility === 'hidden_local' ? 'hidden_local' : 'visible';
      } else if (patch.source_status === 'canceled') {
        next.lifecycle_status = 'canceled';
        next.visibility = 'archived';
        next.archived_at = now;
        next.archive_reason = 'things_canceled';
      } else if (patch.source_status === 'missing') {
        next.source_status = 'missing';
        next.visibility = 'archived';
        next.archived_at = now;
        next.archive_reason = 'things_missing';
      } else if (patch.source_status === 'out_of_scope') {
        next.source_status = 'out_of_scope';
        next.source_freshness = 'fresh';
        next.archive_reason = 'not_in_today';
        if (current.visibility === 'hidden_local') next.visibility = 'hidden_local';
      }
    }
  }

  if (patch.consecutive_missing_count !== undefined) next.consecutive_missing_count = patch.consecutive_missing_count;
  if (Object.prototype.hasOwnProperty.call(patch, 'last_full_seen_at')) next.last_full_seen_at = patch.last_full_seen_at;

  if (patch.lifecycle_status && current.origin_mode !== 'structured') {
    if (!TERMINAL_USER.has(current.lifecycle_status) || patch.lifecycle_status === 'confirmed') {
      next.lifecycle_status = patch.lifecycle_status;
    }
  }
  if (patch.status && current.origin_mode !== 'structured') {
    next.status = patch.status;
  }

  if (patch.visibility === 'archived') {
    next.visibility = 'archived';
    next.archived_at = patch.archived_at || now;
    next.archive_reason = patch.archive_reason || next.archive_reason || 'archived';
  }

  return next;
}

export function thingsMirrorFields(sourceStatus: SourceStatus, hiddenLocal: boolean): Partial<TodoTransitionState> {
  if (sourceStatus === 'open') {
    return {
      status: 'confirmed',
      lifecycle_status: 'confirmed',
      origin_mode: 'structured',
      source_status: 'open',
      source_freshness: 'fresh',
      source_readonly: 1,
      visibility: hiddenLocal ? 'hidden_local' : 'visible',
    };
  }
  if (sourceStatus === 'completed') {
    return {
      status: 'confirmed',
      lifecycle_status: 'completed',
      origin_mode: 'structured',
      source_status: 'completed',
      source_freshness: 'fresh',
      source_readonly: 1,
      visibility: hiddenLocal ? 'hidden_local' : 'visible',
    };
  }
  if (sourceStatus === 'canceled') {
    return {
      status: 'ignored',
      lifecycle_status: 'canceled',
      origin_mode: 'structured',
      source_status: 'canceled',
      source_freshness: 'fresh',
      source_readonly: 1,
      visibility: 'archived',
      archive_reason: 'things_canceled',
    };
  }
  if (sourceStatus === 'out_of_scope') {
    return {
      origin_mode: 'structured',
      source_status: 'out_of_scope',
      source_freshness: 'fresh',
      source_readonly: 1,
      visibility: hiddenLocal ? 'hidden_local' : 'visible',
      archive_reason: 'not_in_today',
    };
  }
  return {
    source_status: 'missing',
    source_freshness: 'fresh',
    origin_mode: 'structured',
    source_readonly: 1,
    visibility: 'archived',
    archive_reason: 'things_missing',
  };
}

export function dispatchTodoAction(
  current: TodoTransitionState,
  action: TodoUserAction,
  patch: Partial<TodoTransitionState> = {},
  now = new Date().toISOString()
): TodoTransitionState {
  const readonly = current.source_readonly === 1 || current.origin_mode === 'structured';
  if (readonly && (action === 'confirm' || action === 'edit' || action === 'complete' || action === 'reopen' || action === 'archive')) {
    throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.TODO_READONLY, '只读来源不能在工作台改写业务真值');
  }
  if (action === 'hide' || (action === 'ignore' && readonly)) {
    return applyTodoTransition(current, { visibility: 'hidden_local' }, now);
  }
  if (action === 'unhide') {
    return applyTodoTransition(current, { visibility: 'visible' }, now);
  }
  if (action === 'ignore') {
    return applyTodoTransition(current, { status: 'ignored', lifecycle_status: 'ignored' }, now);
  }
  if (action === 'confirm') {
    return applyTodoTransition(current, { status: 'confirmed', lifecycle_status: 'confirmed' }, now);
  }
  if (action === 'edit') {
    return applyTodoTransition(current, patch, now);
  }
  if (action === 'complete') {
    return applyTodoTransition(
      current,
      {
        status: 'confirmed',
        lifecycle_status: 'completed',
        completed_at: now,
        completion_source: 'user',
        completion_confidence: 1,
      },
      now
    );
  }
  if (action === 'reopen') {
    return applyTodoTransition(
      current,
      {
        status: 'confirmed',
        lifecycle_status: 'confirmed',
        completed_at: null,
        completion_source: patch.completion_source ?? null,
        completion_confidence: null,
      },
      now
    );
  }
  if (action === 'archive') {
    return applyTodoTransition(current, { visibility: 'archived', archive_reason: patch.archive_reason || 'archived' }, now);
  }
  throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.VALIDATION_ERROR, '未知状态转换');
}

export function rowToTransitionState(row: Record<string, unknown>): TodoTransitionState {
  return {
    status: String(row.status || 'pending'),
    lifecycle_status: String(row.lifecycle_status || 'candidate'),
    origin_mode: String(row.origin_mode || 'legacy'),
    source_status: String(row.source_status || 'open'),
    source_freshness: String(row.source_freshness || 'unknown'),
    source_readonly: Number(row.source_readonly || 0),
    visibility: String(row.visibility || 'visible'),
    consecutive_missing_count: Number(row.consecutive_missing_count || 0),
    last_full_seen_at: (row.last_full_seen_at as string | null) ?? null,
    archived_at: (row.archived_at as string | null) ?? null,
    archive_reason: (row.archive_reason as string | null) ?? null,
    title: String(row.title || ''),
    due_at: (row.due_at as string | null) ?? null,
    cluster: String(row.cluster || ''),
    estimated_minutes: (row.estimated_minutes as number | null) ?? null,
    user_edited_at: (row.user_edited_at as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
    completion_source: (row.completion_source as string | null) ?? null,
    completion_confidence: (row.completion_confidence as number | null) ?? null,
  };
}
