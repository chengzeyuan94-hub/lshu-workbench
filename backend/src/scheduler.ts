import { runHotspotSync, isSyncing } from './hotspotSync';
import { getSettings, countFetchRunsByTriggerPrefix } from './db';

// 调度器：13:30 / 20:30 两次自动抓取
// 后台运行时才生效（前台 dev/测试不触发定时器）
const isBackendRuntime =
  process.env.WORKBENCH_DEV_MODE !== 'true' && (process.env.NODE_ENV === 'production' || !process.env.CI);

function parseTimes(times: string[]): Array<{ h: number; m: number }> {
  return (times || [])
    .map((t) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
      return m ? { h: parseInt(m[1], 10), m: parseInt(m[2], 10) } : null;
    })
    .filter((x): x is { h: number; m: number } => !!x && x.h >= 0 && x.h < 24 && x.m >= 0 && x.m < 60);
}

/** 上海时区墙钟 HH:mm */
function shanghaiWallClock(d = new Date()): { dateStr: string; hh: string; mm: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  let hh = get('hour');
  if (hh === '24') hh = '00';
  const mm = get('minute');
  return { dateStr, hh, mm };
}

function slotPassed(slot: { h: number; m: number }, clock: { hh: string; mm: string }): boolean {
  const nowMin = parseInt(clock.hh, 10) * 60 + parseInt(clock.mm, 10);
  const slotMin = slot.h * 60 + slot.m;
  return nowMin >= slotMin;
}

function schedulerTriggerKey(dateStr: string, slot: { h: number; m: number }): string {
  const hh = slot.h.toString().padStart(2, '0');
  const mm = slot.m.toString().padStart(2, '0');
  return `scheduler:${dateStr}:${hh}:${mm}`;
}

function hasTriggered(dateStr: string, slot: { h: number; m: number }): boolean {
  return countFetchRunsByTriggerPrefix(schedulerTriggerKey(dateStr, slot)) > 0;
}

/** 触发一次同步（防重入：若正在同步则跳过，并返回提示） */
async function triggerSync(reason: string): Promise<void> {
  if (isSyncing()) {
    console.log(`[scheduler] 跳过同步（已在运行），reason=${reason}`);
    return;
  }
  console.log(`[scheduler] 触发热点雷达同步，reason=${reason}`);
  try {
    const r = await runHotspotSync(reason);
    console.log(
      `[scheduler] 同步完成 ${r.total} 个来源，插入 ${r.sources.reduce((n, s) => n + s.inserted, 0)} 篇，去重 ${r.sources.reduce((n, s) => n + s.duplicate, 0)} 篇`
    );
  } catch (e) {
    console.error(`[scheduler] 同步异常：${(e as Error).message}`);
  }
}

/** 判断是否到点触发（每 30s tick 一次） */
function tick(): void {
  const settings = getSettings() as { hotspotScheduleTimes?: string[]; hotspotAutoEnabled?: boolean };
  if (settings.hotspotAutoEnabled === false) {
    return;
  }
  const times = parseTimes(settings.hotspotScheduleTimes as string[]);
  const clock = shanghaiWallClock();

  // 当天已经错过的档位：补抓一次（后端在当天任意时间启动时，不应只补 5 分钟内）
  // 当天已执行过的档位通过持久化运行记录判断，不依赖进程内 lastScheduledKey。
  for (const t of times) {
    if (!slotPassed(t, clock)) continue;
    if (hasTriggered(clock.dateStr, t)) continue;
    void triggerSync(schedulerTriggerKey(clock.dateStr, t));
  }
}

export function startScheduler(): void {
  if (!isBackendRuntime) {
    console.log('[scheduler] 前台/测试环境，不启用自动调度定时器');
    return;
  }
  console.log('[scheduler] 已达到定时抓取时刻，后台运行中，定时器已启动');
  // 立即 tick 一次，处理漏跑补抓；随后每 30s 检查一次
  tick();
  setInterval(tick, 30 * 1000);
}

export { isBackendRuntime };

export function _tick(): void { tick(); }
export function _parseTimes(times: string[]): Array<{ h: number; m: number }> { return parseTimes(times); }
export function _shanghaiWallClock(d = new Date()): { dateStr: string; hh: string; mm: string } { return shanghaiWallClock(d); }
export function _schedulerTriggerKey(dateStr: string, slot: { h: number; m: number }): string { return schedulerTriggerKey(dateStr, slot); }
