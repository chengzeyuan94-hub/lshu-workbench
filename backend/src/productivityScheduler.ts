import { commitSync } from './services/productivitySync';
import { getSettings } from './db';

const isBackendRuntime =
  process.env.WORKBENCH_DEV_MODE !== 'true' && process.env.NODE_ENV !== 'test' && !process.env.VITEST && !process.env.CI;

let timers: NodeJS.Timeout[] = [];

export function startProductivityScheduler(): void {
  if (!isBackendRuntime) return;
  timers = [
    setInterval(() => {
      const s = getSettings();
      const includeAi = s.aiAnalysisEnabled === true && s.aiAutoSyncEnabled === true;
      void commitSync({ includeAi }).catch(() => undefined);
    }, 30 * 60 * 1000),
  ];
}

export function stopProductivityScheduler(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}
