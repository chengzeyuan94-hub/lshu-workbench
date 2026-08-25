import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';

interface ClickSparkProps {
  children: ReactNode;
  color?: string;
  count?: number;
  duration?: number;
  className?: string;
}

interface Burst {
  id: number;
  x: number;
  y: number;
}

function prefersReducedMotion(): boolean {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** A small, dependency-free radial click burst implemented with local CSS. */
export default function ClickSpark({
  children,
  color = '#FFD12E',
  count = 8,
  duration = 420,
  className = '',
}: ClickSparkProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const timers = useRef<number[]>([]);
  const [bursts, setBursts] = useState<Burst[]>([]);

  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  const createBurst = (event: MouseEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root || prefersReducedMotion()) return;
    const rect = root.getBoundingClientRect();
    const keyboardClick = event.detail === 0;
    const burst = {
      id: nextId.current++,
      x: keyboardClick ? rect.width / 2 : event.clientX - rect.left,
      y: keyboardClick ? rect.height / 2 : event.clientY - rect.top,
    };
    setBursts((current) => [...current, burst]);
    timers.current.push(window.setTimeout(() => {
      setBursts((current) => current.filter((item) => item.id !== burst.id));
    }, duration + 80));
  };

  return (
    <div ref={rootRef} className={`click-spark ${className}`.trim()} onClick={createBurst}>
      <span className="click-spark__layer" aria-hidden="true">
        {bursts.flatMap((burst) => Array.from({ length: count }, (_, index) => {
          const angle = (360 / count) * index;
          const style = {
            '--spark-x': `${burst.x}px`,
            '--spark-y': `${burst.y}px`,
            '--spark-angle': `${angle}deg`,
            '--spark-color': color,
            '--spark-duration': `${duration}ms`,
          } as CSSProperties;
          return <i key={`${burst.id}-${index}`} className="click-spark__ray" style={style} />;
        }))}
      </span>
      {children}
    </div>
  );
}
