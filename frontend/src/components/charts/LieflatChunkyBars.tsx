import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

export interface LieflatBarDatum {
  label: string;
  value: number;
}

interface LieflatChunkyBarsProps {
  data: LieflatBarDatum[];
  maxValue?: number;
  height?: number;
  ariaLabel: string;
  valueFormatter?: (value: number) => string;
  signed?: boolean;
}

const defaultFormatter = (value: number) => String(value);

/**
 * Lieflat Charts G3 "Chunky Bars" adapted to the workbench's hard-edge
 * pixel language: each value follows its own bar top, bars reveal in sequence,
 * and every real data mark can be focused or pinned without changing the data.
 */
export default function LieflatChunkyBars({
  data,
  maxValue,
  height = 220,
  ariaLabel,
  valueFormatter = defaultFormatter,
  signed = false,
}: LieflatChunkyBarsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const signature = useMemo(() => data.map((item) => `${item.label}:${item.value}`).join('|'), [data]);
  const resolvedMax = Math.max(
    1,
    maxValue ?? 0,
    ...data.map((item) => (signed ? Math.abs(item.value) : item.value)),
  );

  useEffect(() => {
    setSelectedIndex(null);
    setVisible(false);
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { threshold: 0.28 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [signature]);

  const minWidth = data.length > 12 ? Math.max(760, data.length * 42) : undefined;

  return (
    <div
      ref={rootRef}
      className={`lieflat-chunky-bars${visible ? ' is-visible' : ''}${data.length > 12 ? ' is-dense' : ''}${signed ? ' is-signed' : ''}`}
      style={{ height, minWidth }}
      role="group"
      aria-label={`${ariaLabel}。可聚焦或点击柱体查看数据，按 Escape 取消选中。`}
      data-chart-template="G3-chunky-bars"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setSelectedIndex(null);
      }}
    >
      {data.map((item, index) => {
        const formattedValue = valueFormatter(item.value);
        const magnitude = signed ? Math.abs(item.value) : item.value;
        const heightRatio = magnitude <= 0
          ? 0
          : Math.max(2, (magnitude / resolvedMax) * (signed ? 46 : 100));
        const style = {
          '--lieflat-bar-height': `${heightRatio}%`,
          '--lieflat-reveal-order': index,
        } as CSSProperties;
        return (
          <button
            key={`${item.label}-${index}`}
            type="button"
            className={`lieflat-chunky-bar${selectedIndex === index ? ' is-selected' : ''}${item.value < 0 ? ' is-negative' : ''}${item.value === 0 ? ' is-zero' : ''}`}
            style={style}
            title={`${item.label}：${formattedValue}`}
            aria-label={`${item.label}，${formattedValue}`}
            aria-pressed={selectedIndex === index}
            onClick={() => setSelectedIndex((current) => (current === index ? null : index))}
          >
            <span className="lieflat-chunky-track" aria-hidden="true">
              <span className="lieflat-chunky-plot">
                <i className="lieflat-chunky-fill" />
                <span className="lieflat-chunky-value">{formattedValue}</span>
              </span>
            </span>
            <span className="lieflat-chunky-label">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
