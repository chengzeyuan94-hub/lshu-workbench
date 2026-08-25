import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { TodayWeatherResponse } from '../types';
import { systemTimeZone } from '../lib/homeClock';
import {
  formatFetchedAt,
  geoErrorPhase,
  getCurrentPositionOnce,
  phaseLabel,
  readGeoPermission,
  roundCoord,
  type WeatherUiPhase,
} from '../lib/geoWeather';
import { weatherKindFromCode, weatherStatusPhrase } from '../lib/weatherKind';
import WeatherPixelIcon from './WeatherPixelIcon';

function phaseFromWeather(status: TodayWeatherResponse['status']): WeatherUiPhase {
  if (status === 'live' || status === 'cache' || status === 'stale') return status;
  return 'unavailable';
}

export default function HomeWeather({ onLocationResolved }: { onLocationResolved?: (label: string) => void }) {
  const [phase, setPhase] = useState<WeatherUiPhase>('need_permission');
  const [data, setData] = useState<TodayWeatherResponse | null>(null);
  const coordsRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const locatingRef = useRef(false);
  const aliveRef = useRef(true);
  const lastLocatedAtRef = useRef(0);

  const fetchWeather = useCallback(async () => {
    const coords = coordsRef.current;
    if (!coords) {
      if (aliveRef.current) setPhase('unavailable');
      return;
    }
    if (aliveRef.current) setPhase('fetching');
    try {
      const weather = await api.postTodayWeather({
        latitude: coords.latitude,
        longitude: coords.longitude,
        timezone: systemTimeZone(),
      });
      if (!aliveRef.current) return;
      setData(weather);
      setPhase(phaseFromWeather(weather.status));
      if (weather.locationLabel) onLocationResolved?.(weather.locationLabel);
    } catch {
      if (!aliveRef.current) return;
      setData(null);
      setPhase('unavailable');
    }
  }, [onLocationResolved]);

  const locateAndFetch = useCallback(async (fresh = false) => {
    if (!navigator.geolocation) {
      setPhase('unsupported');
      return;
    }
    if (locatingRef.current) return;
    locatingRef.current = true;
    if (aliveRef.current) setPhase('locating');
    try {
      const pos = await getCurrentPositionOnce({ fresh });
      coordsRef.current = {
        latitude: roundCoord(pos.coords.latitude),
        longitude: roundCoord(pos.coords.longitude),
      };
      lastLocatedAtRef.current = Date.now();
      await fetchWeather();
    } catch (err) {
      coordsRef.current = null;
      if (!aliveRef.current) return;
      setData(null);
      setPhase(geoErrorPhase(err));
    } finally {
      locatingRef.current = false;
    }
  }, [fetchWeather]);

  useEffect(() => {
    let cancelled = false;
    aliveRef.current = true;
    if (!navigator.geolocation) {
      setPhase('unsupported');
      return () => {
        cancelled = true;
        aliveRef.current = false;
        coordsRef.current = null;
      };
    }
    let permissionStatus: PermissionStatus | null = null;
    let permissionChangeHandler: (() => void) | null = null;
    const applyPermission = (state: PermissionState | 'unknown') => {
      if (cancelled) return;
      if (state === 'granted') {
        void locateAndFetch();
        return;
      }
      if (state === 'denied') {
        setPhase('geo_denied');
        return;
      }
      setPhase('need_permission');
    };
    readGeoPermission().then(applyPermission);
    navigator.permissions?.query?.({ name: 'geolocation' }).then((status) => {
      if (cancelled) return;
      permissionStatus = status;
      permissionChangeHandler = () => applyPermission(status.state);
      status.addEventListener('change', permissionChangeHandler);
    }).catch(() => undefined);
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastLocatedAtRef.current < 5 * 60 * 1000) return;
      readGeoPermission().then((state) => {
        if (state === 'granted') void locateAndFetch(true);
      });
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      aliveRef.current = false;
      coordsRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (permissionStatus && permissionChangeHandler) {
        permissionStatus.removeEventListener('change', permissionChangeHandler);
      }
    };
  }, [locateAndFetch]);

  const timeZone = data?.timezone || systemTimeZone();
  const showWeather = Boolean(data?.current && data?.today) && (phase === 'live' || phase === 'cache' || phase === 'stale');
  const fallbackText =
    phase === 'need_permission' ? '使用电脑位置获取天气'
      : phase === 'locating' ? '正在获取位置'
        : phase === 'fetching' ? '正在获取天气'
          : phase === 'geo_denied' ? '位置权限未开启，请在浏览器或系统设置中授权'
            : phase === 'geo_timeout' ? '暂时无法获取电脑位置'
              : phase === 'unsupported' ? '当前浏览器不支持电脑定位'
                : '天气暂不可用';
  const kind = weatherKindFromCode(data?.current?.conditionCode);
  const iconLabel = showWeather && data?.current
    ? `${data.current.conditionLabel}，${weatherStatusPhrase(phase)}，电脑当前位置`
    : fallbackText;

  return (
    <section className="home-weather-panel" aria-label="今日天气">
      <div className="ui-page-kicker">WX · LOCAL</div>
      {showWeather && data?.current && data.today ? (
        <>
          <span className="sr-only">{phaseLabel(phase)}，电脑当前位置</span>
          <WeatherPixelIcon kind={kind} label={iconLabel} />
          <div className="home-weather-zone">{data.locationLabel || '电脑当前位置'}</div>
          <div className="home-weather-temp">{Math.round(data.current.temperatureC)}°</div>
          <div className="home-weather-meta">
            <span>{data.current.conditionLabel}</span>
            <span>体感 {data.current.apparentTemperatureC == null ? '—' : `${Math.round(data.current.apparentTemperatureC)}°`}</span>
            <span>高 {Math.round(data.today.maxC)}° / 低 {Math.round(data.today.minC)}°</span>
            <span className={data.today.precipitationProbabilityPct != null && data.today.precipitationProbabilityPct >= 40 ? 'home-weather-precip' : undefined}>
              降水 {data.today.precipitationProbabilityPct == null ? '—' : `${Math.round(data.today.precipitationProbabilityPct)}%`}
            </span>
            {data.fetchedAt ? <span>更新 {formatFetchedAt(data.fetchedAt, timeZone)}</span> : null}
          </div>
        </>
      ) : (
        <p className="home-weather-fallback">{fallbackText}</p>
      )}
      {phase === 'need_permission' || phase === 'geo_timeout' || phase === 'geo_denied' ? (
        <button type="button" className="nb-btn nb-btn--primary home-weather-allow" onClick={() => void locateAndFetch(true)}>
          {phase === 'need_permission' ? '允许定位' : '重试定位'}
        </button>
      ) : null}
      {showWeather ? (
        <button type="button" className="nb-btn home-weather-refresh" onClick={() => void locateAndFetch(true)}>刷新定位</button>
      ) : null}
      <div className="home-weather-credit">
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">天气 · Open-Meteo</a>
        <span aria-hidden="true"> · </span>
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">位置 © OpenStreetMap</a>
      </div>
    </section>
  );
}
