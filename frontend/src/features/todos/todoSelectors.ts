import type { TodoItem } from '../../types';

export const HOME_TODAY_LIMIT = 5;

export function homeTodayPreview(items: TodoItem[], limit = HOME_TODAY_LIMIT): TodoItem[] {
  return items.slice(0, limit);
}
