const DEFAULT_REVERSE_ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const DEFAULT_LABEL = '电脑当前位置';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const MIN_REQUEST_INTERVAL_MS = 1_100;

export type LocationLabelQuery = {
  latitude: number;
  longitude: number;
};

export type LocationLabelResolver = (query: LocationLabelQuery) => Promise<string>;

export type LocationLabelResolverOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  endpoint?: string;
  isEnabled?: () => boolean;
};

type CachedLabel = {
  value: string;
  expiresAt: number;
};

function reverseGeocodingEnabled(): boolean {
  return String(process.env.LOCATION_REVERSE_ENABLED ?? '').trim() !== 'false';
}

function cleanPart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > 40) return null;
  return cleaned;
}

/** Extract only a city-level label; never expose a street or full address. */
export function parseLocationLabel(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const addressRaw = (raw as Record<string, unknown>).address;
  if (!addressRaw || typeof addressRaw !== 'object') return null;
  const address = addressRaw as Record<string, unknown>;
  const locality =
    cleanPart(address.city)
    || cleanPart(address.town)
    || cleanPart(address.municipality)
    || cleanPart(address.village)
    || cleanPart(address.county)
    || cleanPart(address.state);
  return locality || null;
}

function cacheKey(query: LocationLabelQuery): string {
  return `${query.latitude.toFixed(2)}|${query.longitude.toFixed(2)}`;
}

function safeEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function createLocationLabelResolver(options: LocationLabelResolverOptions = {}): LocationLabelResolver {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const isEnabled = options.isEnabled || reverseGeocodingEnabled;
  const cache = new Map<string, CachedLabel>();
  const inflight = new Map<string, Promise<string>>();
  let nextRequestAt = 0;

  return async (query) => {
    if (!isEnabled()) return DEFAULT_LABEL;
    const key = cacheKey(query);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    const pending = inflight.get(key);
    if (pending) return pending;

    const request = (async () => {
      const endpoint = safeEndpoint(options.endpoint || process.env.LOCATION_REVERSE_URL || DEFAULT_REVERSE_ENDPOINT);
      if (!endpoint) return DEFAULT_LABEL;
      endpoint.searchParams.set('format', 'jsonv2');
      endpoint.searchParams.set('lat', query.latitude.toFixed(2));
      endpoint.searchParams.set('lon', query.longitude.toFixed(2));
      // zoom=7 returns the prefecture/city level reliably for Chinese OSM data.
      endpoint.searchParams.set('zoom', '7');
      endpoint.searchParams.set('addressdetails', '1');
      endpoint.searchParams.set('accept-language', 'zh-CN,zh,en');

      const waitMs = Math.max(0, nextRequestAt - now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      nextRequestAt = now() + MIN_REQUEST_INTERVAL_MS;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(endpoint.toString(), {
          method: 'GET',
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            'user-agent': process.env.LOCATION_REVERSE_USER_AGENT || 'LShuWorkbench/0.1 (local personal dashboard)',
          },
        });
        if (!response.ok) return DEFAULT_LABEL;
        const label = parseLocationLabel(await response.json()) || DEFAULT_LABEL;
        cache.set(key, { value: label, expiresAt: now() + CACHE_TTL_MS });
        return label;
      } catch {
        return DEFAULT_LABEL;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, request);
    return request;
  };
}
