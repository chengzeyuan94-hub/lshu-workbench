export type WeatherKind = 'clear' | 'cloudy_or_fog' | 'rain' | 'snow' | 'thunderstorm' | 'unknown';

export function weatherKindFromCode(code: string | undefined): WeatherKind {
  const c = String(code || '').toLowerCase();
  if (!c) return 'unknown';
  if (c.includes('thunder')) return 'thunderstorm';
  if (c.includes('snow')) return 'snow';
  if (c.includes('rain') || c.includes('drizzle') || c.includes('shower')) return 'rain';
  if (c === 'clear' || c === 'mainly_clear') return 'clear';
  if (c.includes('cloud') || c.includes('fog') || c === 'overcast') return 'cloudy_or_fog';
  return 'unknown';
}

export function weatherStatusPhrase(status: 'live' | 'cache' | 'stale' | string): string {
  if (status === 'live') return '实时天气';
  if (status === 'cache') return '缓存天气';
  if (status === 'stale') return '稍早天气';
  return '天气';
}
