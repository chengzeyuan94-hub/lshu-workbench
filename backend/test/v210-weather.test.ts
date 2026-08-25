import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cacheKey,
  createWeatherClient,
  localDateInZone,
  roundCoord,
  sanitizeWeatherRequest,
} from '../src/services/weatherService';
import { formatHomeClock, systemTimeZone } from '../../frontend/src/lib/homeClock';

const NOW = new Date('2026-08-24T08:00:00.000Z');
const TZ = 'Asia/Shanghai';
const LOCAL_DATE = '2026-08-24';
const QUERY = { latitude: 31.23, longitude: 121.47, timezone: TZ };

function sampleJson(overrides: Record<string, unknown> = {}) {
  return {
    current: {
      temperature_2m: 31.2,
      apparent_temperature: 34.8,
      weather_code: 2,
      wind_speed_10m: 12.4,
    },
    daily: {
      time: [LOCAL_DATE],
      temperature_2m_max: [34.1],
      temperature_2m_min: [26.0],
      precipitation_probability_max: [40],
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Open-Meteo 今日天气（电脑位置）', () => {
  it('live 数据正确解析，坐标取整，DTO 不含经纬度或完整 URL', async () => {
    const calls: string[] = [];
    const client = createWeatherClient({
      now: () => NOW,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return jsonResponse(sampleJson());
      },
    });
    const data = await client.getToday({ latitude: 31.2349, longitude: 121.4737, timezone: TZ });
    expect(data.status).toBe('live');
    expect(data.locationLabel).toBe('电脑当前位置');
    expect(data.localDate).toBe(LOCAL_DATE);
    expect(data.timezone).toBe(TZ);
    expect(data.current?.temperatureC).toBe(31.2);
    expect(data.current?.conditionLabel).toBe('多云');
    expect(data.today?.maxC).toBe(34.1);
    const blob = JSON.stringify(data);
    expect(blob).not.toMatch(/31\.23/);
    expect(blob).not.toMatch(/121\.47/);
    expect(blob).not.toMatch(/latitude/);
    expect(blob).not.toMatch(/longitude/);
    expect(blob).not.toMatch(/open-meteo\.com/);
    expect(calls[0]).toContain('https://api.open-meteo.com/v1/forecast');
    expect(calls[0]).toContain('latitude=31.23');
    expect(calls[0]).toContain('longitude=121.47');
  });

  it('非法经纬度或非法时区 fail-closed，且不回显输入', async () => {
    const client = createWeatherClient({ now: () => NOW, fetchImpl: async () => jsonResponse(sampleJson()) });
    const badLat = await client.getToday({ latitude: 91, longitude: 0, timezone: TZ });
    const badTz = await client.getToday({ latitude: 0, longitude: 0, timezone: 'Not/AZone' });
    expect(badLat.status).toBe('unavailable');
    expect(badTz.status).toBe('unavailable');
    expect(JSON.stringify(badLat)).not.toMatch(/91/);
    expect(JSON.stringify(badTz)).not.toMatch(/Not\/AZone/);
  });

  it('15 分钟内二次读取不再次请求上游', async () => {
    let hits = 0;
    const client = createWeatherClient({
      now: () => NOW,
      fetchImpl: async () => {
        hits += 1;
        return jsonResponse(sampleJson());
      },
    });
    const first = await client.getToday(QUERY);
    const second = await client.getToday(QUERY);
    expect(hits).toBe(1);
    expect(first.status).toBe('live');
    expect(second.status).toBe('cache');
  });

  it('timeout + 同位置同日缓存返回 stale；无缓存返回 unavailable', async () => {
    let now = NOW;
    const client = createWeatherClient({
      now: () => now,
      fetchImpl: async () => {
        if (now === NOW) return jsonResponse(sampleJson());
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    await client.getToday(QUERY);
    now = new Date(NOW.getTime() + 16 * 60 * 1000);
    const stale = await client.getToday(QUERY);
    expect(stale.status).toBe('stale');
    expect(stale.errorCode).toBe('WEATHER_TIMEOUT');
    expect(stale.current?.temperatureC).toBe(31.2);
    expect(stale.locationLabel).toBe('电脑当前位置');

    const empty = createWeatherClient({
      now: () => NOW,
      fetchImpl: async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    const miss = await empty.getToday(QUERY);
    expect(miss.status).toBe('unavailable');
    expect(miss.errorCode).toBe('WEATHER_TIMEOUT');
    expect(miss.current).toBeNull();
  });

  it('位置变化后不得返回旧位置缓存', async () => {
    const client = createWeatherClient({
      now: () => NOW,
      fetchImpl: async (url) => {
        if (String(url).includes('latitude=40')) return jsonResponse({ broken: true });
        return jsonResponse(sampleJson());
      },
    });
    const first = await client.getToday(QUERY);
    expect(first.status).toBe('live');
    const moved = await client.getToday({ latitude: 40.12, longitude: 116.38, timezone: TZ });
    expect(moved.status).toBe('unavailable');
    expect(moved.current).toBeNull();
  });

  it('只返回城市级位置标签，不回显经纬度', async () => {
    const client = createWeatherClient({
      now: () => NOW,
      fetchImpl: async () => jsonResponse(sampleJson()),
      locationLabelResolver: async () => '广州市',
    });
    const data = await client.getToday(QUERY);
    expect(data.locationLabel).toBe('广州市');
    expect(JSON.stringify(data)).not.toMatch(/31\.23|121\.47|latitude|longitude/);
  });

  it('昨日缓存不可使用', async () => {
    let now = NOW;
    const client = createWeatherClient({
      now: () => now,
      fetchImpl: async () => {
        if (localDateInZone(now, TZ) === LOCAL_DATE) return jsonResponse(sampleJson());
        return jsonResponse({ broken: true });
      },
    });
    await client.getToday(QUERY);
    now = new Date('2026-08-25T08:00:00.000Z');
    const next = await client.getToday(QUERY);
    expect(next.status).toBe('unavailable');
    expect(next.current).toBeNull();
  });

  it('非法 JSON 和越界温度 fail-closed', async () => {
    const badJson = createWeatherClient({
      now: () => NOW,
      fetchImpl: async () => new Response('not-json', { status: 200 }),
    });
    const a = await badJson.getToday(QUERY);
    expect(a.status).toBe('unavailable');
    expect(a.errorCode).toBe('WEATHER_RESPONSE_INVALID');

    const hot = createWeatherClient({
      now: () => NOW,
      fetchImpl: async () => jsonResponse(sampleJson({
        current: { temperature_2m: 999, weather_code: 2, apparent_temperature: 0, wind_speed_10m: 1 },
      })),
    });
    const b = await hot.getToday(QUERY);
    expect(b.status).toBe('unavailable');
    expect(b.errorCode).toBe('WEATHER_RESPONSE_INVALID');
  });

  it('源码不记录坐标、不默认上海、不打印日志', () => {
    const text = readFileSync(resolve(process.cwd(), 'src/services/weatherService.ts'), 'utf8');
    expect(text).not.toMatch(/console\.(log|info|warn|error)/);
    expect(text).not.toMatch(/上海/);
    expect(text).not.toMatch(/WEATHER_LATITUDE/);
    expect(text).not.toMatch(/31\.2304/);
    expect(sanitizeWeatherRequest({ latitude: 31.234, longitude: 121.476, timezone: TZ })).toEqual({
      latitude: 31.23,
      longitude: 121.48,
      timezone: TZ,
    });
    expect(roundCoord(31.2349)).toBe(31.23);
    expect(cacheKey(QUERY, LOCAL_DATE)).toBe('31.23|121.47|Asia/Shanghai|2026-08-24');
  });
});

describe('时钟格式与隔离边界', () => {
  it('使用传入 IANA 时区格式化，不把 Asia/Shanghai 写死为默认实现', () => {
    const shanghai = formatHomeClock(new Date('2026-08-24T08:00:00.000Z'), 'Asia/Shanghai');
    expect(shanghai.hhmm).toBe('16:00');
    expect(shanghai.seconds).toBe('00');
    expect(shanghai.date).toBe('2026.08.24');
    expect(shanghai.weekday).toContain('星期');
    expect(shanghai.timeZone).toBe('Asia/Shanghai');

    const ny = formatHomeClock(new Date('2026-08-24T08:00:00.000Z'), 'America/New_York');
    expect(ny.hhmm).toBe('04:00');
    expect(ny.timeZone).toBe('America/New_York');
    expect(typeof systemTimeZone()).toBe('string');
    expect(systemTimeZone().length).toBeGreaterThan(0);
  });

  it('Productivity Sync、AI、Scheduler 不引用 weatherService', () => {
    const files = [
      'src/services/productivitySync.ts',
      'src/services/actionIntentAnalyzer.ts',
      'src/productivityScheduler.ts',
      'src/scheduler.ts',
    ];
    for (const file of files) {
      const text = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(text).not.toMatch(/weatherService/);
      expect(text).not.toMatch(/\/api\/weather/);
    }
  });
});
