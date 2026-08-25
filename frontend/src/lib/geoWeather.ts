export type WeatherUiPhase =
  | 'need_permission'
  | 'locating'
  | 'fetching'
  | 'live'
  | 'cache'
  | 'stale'
  | 'geo_denied'
  | 'geo_timeout'
  | 'unsupported'
  | 'unavailable';

export function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

export function phaseLabel(phase: WeatherUiPhase): string {
  switch (phase) {
    case 'need_permission':
      return '尚未授权';
    case 'locating':
      return '正在获取位置';
    case 'fetching':
      return '正在获取天气';
    case 'live':
      return '实时数据';
    case 'cache':
      return '缓存数据';
    case 'stale':
      return '稍早数据';
    case 'geo_denied':
      return '定位被拒绝';
    case 'geo_timeout':
      return '定位超时';
    case 'unsupported':
      return '浏览器不支持定位';
    default:
      return '天气服务不可用';
  }
}

export function formatFetchedAt(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
}

export async function readGeoPermission(): Promise<'granted' | 'prompt' | 'denied' | 'unknown'> {
  const permissions = navigator.permissions;
  if (!permissions?.query) return 'unknown';
  try {
    const status = await permissions.query({ name: 'geolocation' });
    if (status.state === 'granted' || status.state === 'prompt' || status.state === 'denied') {
      return status.state;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function getCurrentPositionOnce(options: { fresh?: boolean } = {}): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: options.fresh ? 0 : 300000,
    });
  });
}

export function geoErrorPhase(err: unknown): 'geo_denied' | 'geo_timeout' {
  const code = err && typeof err === 'object' && 'code' in err ? Number((err as GeolocationPositionError).code) : NaN;
  if (code === 1) return 'geo_denied';
  return 'geo_timeout';
}
