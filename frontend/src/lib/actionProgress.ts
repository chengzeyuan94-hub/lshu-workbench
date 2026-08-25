import { useCallback, useEffect, useRef, useState } from 'react';

export type ActionProgressState = 'idle' | 'running' | 'success' | 'error';
export type ActionProgressMode = 'indeterminate' | 'determinate';

export interface ActionProgressModel {
  label: string;
  state: ActionProgressState;
  mode: ActionProgressMode;
  value?: number;
  max?: number;
  errorMessage?: string;
  successMessage?: string;
}

const IDLE: ActionProgressModel = {
  label: '',
  state: 'idle',
  mode: 'indeterminate',
};

export function useActionProgress(successHoldMs = 1000) {
  const [model, setModel] = useState<ActionProgressModel>(IDLE);
  const aliveRef = useRef(true);
  const retryRef = useRef<(() => void) | null>(null);
  const timerRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      window.clearTimeout(timerRef.current);
      setModel(IDLE);
    };
  }, []);

  const run = useCallback(async <T,>(
    fn: () => Promise<T>,
    opts: {
      label: string;
      successMessage?: string;
      mode?: ActionProgressMode;
      value?: number;
      max?: number;
    }
  ): Promise<T> => {
    window.clearTimeout(timerRef.current);
    retryRef.current = () => {
      void run(fn, opts);
    };
    setModel({
      label: opts.label,
      state: 'running',
      mode: opts.mode ?? 'indeterminate',
      value: opts.value,
      max: opts.max,
    });
    try {
      const result = await fn();
      if (!aliveRef.current) return result;
      setModel({
        label: opts.label,
        state: 'success',
        mode: opts.mode ?? 'indeterminate',
        value: opts.mode === 'determinate' ? (opts.max ?? 1) : undefined,
        max: opts.max,
        successMessage: opts.successMessage || '已完成',
      });
      timerRef.current = window.setTimeout(() => {
        if (aliveRef.current) setModel((current) => (current.state === 'success' ? IDLE : current));
      }, successHoldMs);
      return result;
    } catch (err) {
      if (!aliveRef.current) throw err;
      setModel({
        label: opts.label,
        state: 'error',
        mode: opts.mode ?? 'indeterminate',
        errorMessage: err instanceof Error ? err.message : '操作失败',
      });
      throw err;
    }
  }, [successHoldMs]);

  const retry = useCallback(() => {
    retryRef.current?.();
  }, []);

  return {
    progress: model,
    running: model.state === 'running',
    run,
    retry,
  };
}
