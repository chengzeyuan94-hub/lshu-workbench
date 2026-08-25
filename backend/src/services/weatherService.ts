import type { LocationLabelResolver } from './locationLabelService';

const WEATHER_HOST = 'api.open-meteo.com';
const WEATHER_PATH = '/v1/forecast';
const FRESH_MS = 15 * 60 * 1000;
const STALE_MAX_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 5_000;
const LOCATION_LABEL = '电脑当前位置';

export type WeatherStatus = 'live' | 'cache' | 'stale' | 'unavailable';
export type WeatherErrorCode =
  | 'WEATHER_DISABLED'
  | 'WEATHER_TIMEOUT'
  | 'WEATHER_UPSTREAM_UNAVAILABLE'
  | 'WEATHER_RESPONSE_INVALID';

export interface TodayWeatherResponse {
  status: WeatherStatus;
  locationLabel: string;
  timezone: string;
  localDate: string;
  fetchedAt: string | null;
  current: {
    temperatureC: number;
    apparentTemperatureC: number | null;
    conditionCode: string;
    conditionLabel: string;
    windKph: number | null;
  } | null;
  today: {
    minC: number;
    maxC: number;
    precipitationProbabilityPct: number | null;
  } | null;
  errorCode?: WeatherErrorCode;
}

export interface WeatherQuery {
  latitude: number;
  longitude: number;
  timezone: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WeatherClientOptions {
  isEnabled?: () => boolean;
  fetchImpl?: FetchLike;
  now?: () => Date;
  locationLabelResolver?: LocationLabelResolver;
}

const CONDITION_BY_CODE: Record<number, { code: string; label: string }> = {
  0: { code: 'clear', label: '晴' },
  1: { code: 'mainly_clear', label: '大部晴朗' },
  2: { code: 'partly_cloudy', label: '多云' },
  3: { code: 'overcast', label: '阴' },
  45: { code: 'fog', label: '雾' },
  48: { code: 'rime_fog', label: '雾凇' },
  51: { code: 'drizzle_light', label: '小毛毛雨' },
  53: { code: 'drizzle', label: '毛毛雨' },
  55: { code: 'drizzle_dense', label: '大毛毛雨' },
  56: { code: 'freezing_drizzle', label: '冻毛毛雨' },
  57: { code: 'freezing_drizzle_dense', label: '强冻毛毛雨' },
  61: { code: 'rain_light', label: '小雨' },
  63: { code: 'rain', label: '雨' },
  65: { code: 'rain_heavy', label: '大雨' },
  66: { code: 'freezing_rain', label: '冻雨' },
  67: { code: 'freezing_rain_heavy', label: '强冻雨' },
  71: { code: 'snow_light', label: '小雪' },
  73: { code: 'snow', label: '雪' },
  75: { code: 'snow_heavy', label: '大雪' },
  77: { code: 'snow_grains', label: '雪粒' },
  80: { code: 'showers_light', label: '小阵雨' },
  81: { code: 'showers', label: '阵雨' },
  82: { code: 'showers_heavy', label: '强阵雨' },
  85: { code: 'snow_showers', label: '阵雪' },
  86: { code: 'snow_showers_heavy', label: '强阵雪' },
  95: { code: 'thunder', label: '雷阵雨' },
  96: { code: 'thunder_hail', label: '雷阵雨伴冰雹' },
  99: { code: 'thunder_hail_heavy', label: '强雷暴冰雹' },
};

function weatherEnabled(): boolean {
  const raw = String(process.env.WEATHER_ENABLED ?? '').trim();
  return raw !== 'false';
}

export function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 80 || /[^\w+\-/]/.test(timeZone)) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function sanitizeWeatherRequest(body: unknown): WeatherQuery | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const lat = typeof raw.latitude === 'number' ? raw.latitude : Number(raw.latitude);
  const lon = typeof raw.longitude === 'number' ? raw.longitude : Number(raw.longitude);
  const timezone = typeof raw.timezone === 'string' ? raw.timezone.trim() : '';
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  if (!isValidTimeZone(timezone)) return null;
  return {
    latitude: roundCoord(lat),
    longitude: roundCoord(lon),
    timezone,
  };
}

export function cacheKey(query: WeatherQuery, localDate: string): string {
  return `${query.latitude.toFixed(2)}|${query.longitude.toFixed(2)}|${query.timezone}|${localDate}`;
}

export function localDateInZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function mapWeatherCode(code: number): { code: string; label: string } {
  return CONDITION_BY_CODE[code] || { code: 'unknown', label: '天气不明' };
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

interface CacheEntry {
  key: string;
  payload: TodayWeatherResponse;
  fetchedAtMs: number;
}

function invalidRequest(): TodayWeatherResponse {
  return {
    status: 'unavailable',
    locationLabel: LOCATION_LABEL,
    timezone: '',
    localDate: '',
    fetchedAt: null,
    current: null,
    today: null,
    errorCode: 'WEATHER_RESPONSE_INVALID',
  };
}

function unavailable(partial: Pick<TodayWeatherResponse, 'errorCode' | 'timezone' | 'localDate'>): TodayWeatherResponse {
  return {
    status: 'unavailable',
    locationLabel: LOCATION_LABEL,
    fetchedAt: null,
    current: null,
    today: null,
    ...partial,
  };
}

function parseUpstream(raw: unknown, timezone: string, localDate: string, fetchedAt: string, locationLabel = LOCATION_LABEL): TodayWeatherResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const current = data.current && typeof data.current === 'object' ? (data.current as Record<string, unknown>) : null;
  const daily = data.daily && typeof data.daily === 'object' ? (data.daily as Record<string, unknown>) : null;
  if (!current || !daily) return null;
  const temp = finiteNumber(current.temperature_2m, -80, 80);
  const weatherCode = finiteNumber(current.weather_code, 0, 99);
  if (temp == null || weatherCode == null) return null;
  const maxList = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const minList = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
  const popList = Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max : [];
  const dateList = Array.isArray(daily.time) ? daily.time : [];
  if (dateList[0] && String(dateList[0]) !== localDate) return null;
  const maxC = finiteNumber(maxList[0], -80, 80);
  const minC = finiteNumber(minList[0], -80, 80);
  if (maxC == null || minC == null) return null;
  const mapped = mapWeatherCode(Math.round(weatherCode));
  return {
    status: 'live',
    locationLabel,
    timezone,
    localDate,
    fetchedAt,
    current: {
      temperatureC: Math.round(temp * 10) / 10,
      apparentTemperatureC: finiteNumber(current.apparent_temperature, -80, 80),
      conditionCode: mapped.code,
      conditionLabel: mapped.label,
      windKph: finiteNumber(current.wind_speed_10m, 0, 400),
    },
    today: {
      minC: Math.round(minC * 10) / 10,
      maxC: Math.round(maxC * 10) / 10,
      precipitationProbabilityPct: finiteNumber(popList[0], 0, 100),
    },
  };
}

export function createWeatherClient(options: WeatherClientOptions = {}) {
  const caches = new Map<string, CacheEntry>();
  const inflights = new Map<string, Promise<TodayWeatherResponse>>();
  const nowFn = options.now || (() => new Date());
  const fetchImpl = options.fetchImpl || fetch;
  const isEnabled = options.isEnabled || weatherEnabled;
  const locationLabelResolver = options.locationLabelResolver;

  function snapshotUnavailable(key: string, errorCode: WeatherErrorCode, timezone: string, localDate: string): TodayWeatherResponse {
    const hit = caches.get(key);
    if (hit && nowFn().getTime() - hit.fetchedAtMs <= STALE_MAX_MS) {
      return { ...hit.payload, status: 'stale', errorCode };
    }
    return unavailable({ errorCode, timezone, localDate });
  }

  async function fetchLive(query: WeatherQuery, key: string, localDate: string): Promise<TodayWeatherResponse> {
    const url = new URL(`https://${WEATHER_HOST}${WEATHER_PATH}`);
    if (url.protocol !== 'https:' || url.hostname !== WEATHER_HOST) {
      return unavailable({ errorCode: 'WEATHER_RESPONSE_INVALID', timezone: query.timezone, localDate });
    }
    url.searchParams.set('latitude', String(query.latitude));
    url.searchParams.set('longitude', String(query.longitude));
    url.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m');
    url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('timezone', query.timezone);
    const locationLabelPromise = locationLabelResolver
      ? locationLabelResolver({ latitude: query.latitude, longitude: query.longitude }).catch(() => LOCATION_LABEL)
      : Promise.resolve(LOCATION_LABEL);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url.toString(), { method: 'GET', signal: controller.signal });
      if (!res.ok) {
        return snapshotUnavailable(key, 'WEATHER_UPSTREAM_UNAVAILABLE', query.timezone, localDate);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return snapshotUnavailable(key, 'WEATHER_RESPONSE_INVALID', query.timezone, localDate);
      }
      const fetchedAt = nowFn().toISOString();
      const locationLabel = await locationLabelPromise;
      const parsed = parseUpstream(json, query.timezone, localDate, fetchedAt, locationLabel);
      if (!parsed) return snapshotUnavailable(key, 'WEATHER_RESPONSE_INVALID', query.timezone, localDate);
      caches.set(key, { key, payload: parsed, fetchedAtMs: nowFn().getTime() });
      return parsed;
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
      return snapshotUnavailable(key, aborted ? 'WEATHER_TIMEOUT' : 'WEATHER_UPSTREAM_UNAVAILABLE', query.timezone, localDate);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getToday(body: unknown): Promise<TodayWeatherResponse> {
    const query = sanitizeWeatherRequest(body);
    if (!query) return invalidRequest();
    const localDate = localDateInZone(nowFn(), query.timezone);
    if (!isEnabled()) {
      return unavailable({ errorCode: 'WEATHER_DISABLED', timezone: query.timezone, localDate });
    }
    const key = cacheKey(query, localDate);
    const fresh = caches.get(key);
    if (fresh && nowFn().getTime() - fresh.fetchedAtMs <= FRESH_MS) {
      return { ...fresh.payload, status: 'cache' };
    }
    const existing = inflights.get(key);
    if (existing) return existing;
    const pending = fetchLive(query, key, localDate).finally(() => {
      inflights.delete(key);
    });
    inflights.set(key, pending);
    return pending;
  }

  function resetForTests() {
    caches.clear();
    inflights.clear();
  }

  return { getToday, resetForTests };
}
