import type { ComponentType, SVGProps } from 'react';
import { CircleQuestion, Cloud, Snowflake, Sun, Zap } from 'pixelarticons/react';
import type { WeatherKind } from '../lib/weatherKind';

type IconProps = SVGProps<SVGSVGElement>;

function DropIcon(props: IconProps) {
  // Official pixelarticons 1.8.1 `drop.svg` (MIT). 2.4.1 removed this glyph.
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M13 2h-2v2H9v4H7v4H5v6h2v2h2v2h6v-2h2v-2h2v-6h-2V8h-2V4h-2V2zm0 2v4h2v4h2v6h-2v2H9v-2H7v-6h2V8h2V4h2z" fill="currentColor" />
    </svg>
  );
}

const ICON_BY_KIND: Record<WeatherKind, ComponentType<IconProps>> = {
  clear: Sun,
  cloudy_or_fog: Cloud,
  rain: DropIcon,
  snow: Snowflake,
  thunderstorm: Zap,
  unknown: CircleQuestion,
};

interface Props {
  kind: WeatherKind;
  label: string;
}

export default function WeatherPixelIcon({ kind, label }: Props) {
  const Icon = ICON_BY_KIND[kind];
  const tone = kind === 'clear' ? 'sun' : kind === 'thunderstorm' ? 'storm' : 'ink';
  return (
    <span className={`weather-pixel weather-pixel--${tone}`} role="img" aria-label={label}>
      <Icon aria-hidden="true" focusable="false" />
    </span>
  );
}
