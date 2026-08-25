import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { TodoItem } from '../../types';
import { HOME_TODAY_LIMIT, homeTodayPreview } from './todoSelectors';

export interface TodayTodosSnapshot {
  items: TodoItem[];
  total: number;
  asOf: string | null;
  revision: string | null;
  stale: boolean;
  loading: boolean;
}

const POLL_MS = 5000;

type Listener = () => void;

const listeners = new Set<Listener>();
const clientLimits = new Map<symbol, number | undefined>();

let snapshot: TodayTodosSnapshot = {
  items: [],
  total: 0,
  asOf: null,
  revision: null,
  stale: false,
  loading: false,
};
let inflight: Promise<void> | null = null;
let queued = false;
let abort: AbortController | null = null;
let pollId: ReturnType<typeof setInterval> | null = null;
let focusAttached = false;

function emit() {
  for (const listener of listeners) listener();
}

function wantedLimit(): number | undefined {
  const limits = [...clientLimits.values()];
  if (limits.length === 0 || limits.some((limit) => limit == null || limit <= 0)) return undefined;
  return Math.max(...(limits as number[]));
}

function stopPolling() {
  if (pollId != null) {
    clearInterval(pollId);
    pollId = null;
  }
}

function startPolling() {
  stopPolling();
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  pollId = setInterval(() => {
    void refreshTodayTodos();
  }, POLL_MS);
}

function onFocus() {
  void refreshTodayTodos();
}

function onVisibility() {
  if (document.visibilityState === 'hidden') {
    stopPolling();
    return;
  }
  startPolling();
  void refreshTodayTodos();
}

function attachWindow() {
  if (focusAttached || typeof window === 'undefined') return;
  focusAttached = true;
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
}

function detachWindow() {
  if (!focusAttached || typeof window === 'undefined') return;
  focusAttached = false;
  window.removeEventListener('focus', onFocus);
  document.removeEventListener('visibilitychange', onVisibility);
  stopPolling();
}

export async function refreshTodayTodos(): Promise<void> {
  if (inflight) {
    queued = true;
    return inflight;
  }
  const controller = new AbortController();
  abort = controller;
  snapshot = { ...snapshot, loading: snapshot.asOf == null };
  emit();
  const run = (async () => {
    try {
      const data = await api.getTodayTodos(wantedLimit(), controller.signal);
      if (controller.signal.aborted) return;
      snapshot = {
        items: data.items,
        total: data.total,
        asOf: data.asOf,
        revision: data.revision,
        stale: false,
        loading: false,
      };
      emit();
    } catch {
      if (controller.signal.aborted) return;
      snapshot = {
        ...snapshot,
        loading: false,
        stale: snapshot.asOf != null,
      };
      emit();
    } finally {
      if (abort === controller) abort = null;
    }
  })();
  inflight = run;
  void run.finally(() => {
    if (inflight === run) inflight = null;
    if (queued) {
      queued = false;
      void refreshTodayTodos();
    }
  });
  return inflight;
}

export function invalidateTodayTodos(): void {
  void refreshTodayTodos();
}

export function getTodayTodosSnapshot(): TodayTodosSnapshot {
  return snapshot;
}

export function subscribeTodayTodos(limit: number | undefined, listener: Listener): () => void {
  const key = Symbol();
  clientLimits.set(key, limit);
  listeners.add(listener);
  attachWindow();
  startPolling();
  void refreshTodayTodos();
  return () => {
    clientLimits.delete(key);
    listeners.delete(listener);
    if (listeners.size === 0) {
      abort?.abort();
      abort = null;
      queued = false;
      inflight = null;
      detachWindow();
    }
  };
}

export function resetTodayTodosStore(): void {
  abort?.abort();
  abort = null;
  inflight = null;
  queued = false;
  detachWindow();
  listeners.clear();
  clientLimits.clear();
  snapshot = {
    items: [],
    total: 0,
    asOf: null,
    revision: null,
    stale: false,
    loading: false,
  };
}

export function useTodayTodos(limit?: number): TodayTodosSnapshot & { preview: TodoItem[] } {
  const [, bump] = useState(0);
  useEffect(() => subscribeTodayTodos(limit, () => bump((n) => n + 1)), [limit]);
  const preview = homeTodayPreview(snapshot.items, limit ?? HOME_TODAY_LIMIT);
  return {
    ...snapshot,
    items: limit != null ? preview : snapshot.items,
    preview,
  };
}
