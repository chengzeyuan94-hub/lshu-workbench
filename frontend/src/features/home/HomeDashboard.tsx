import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, Heart, Star, UserPlus } from 'pixelarticons/react';
import type { NotePerformance, TodoItem } from '../../types';
import { formatMetricValue, formatNumber, NoteRow, TodoRow } from '../../components/widgets';
import HomeClock from '../../components/HomeClock';
import HomeWeather from '../../components/HomeWeather';
import LieflatChunkyBars from '../../components/charts/LieflatChunkyBars';
import {
  HOME_CORE_METRIC_KEYS,
  HOME_NOTES_LIMIT,
  type HomeCoreMetricKey,
  type HomeCoreMetricSlot,
} from './homeMetrics';

const HOME_CORE_METRIC_ICONS = {
  views: Eye,
  likes: Heart,
  collects: Star,
  new_followers: UserPlus,
} as const;

function HomeCoreMetricCard({ slot }: { slot: HomeCoreMetricSlot }) {
  const MetricIcon = HOME_CORE_METRIC_ICONS[slot.key];
  return (
    <div
      className={`ui-metric home-core-metric${slot.missing ? ' is-missing' : ''}`}
      data-metric-key={slot.key}
    >
      <div className="home-core-metric-head">
        <div className="ui-metric-label">{slot.label}</div>
        <span className="home-core-metric-icon" aria-hidden="true">
          <MetricIcon width={32} height={32} />
        </span>
      </div>
      {slot.missing || !slot.metric ? (
        <>
          <div className="ui-data">—</div>
          <div className="home-core-metric-empty">数据暂缺</div>
        </>
      ) : (
        <div className="ui-data">{formatMetricValue(slot.metric)}</div>
      )}
    </div>
  );
}

export function HomeContextRow() {
  const [locationLabel, setLocationLabel] = useState<string>();
  return (
    <section className="home-context-row" aria-label="本地环境">
      <div className="ui-module home-context-clock">
        <HomeClock locationLabel={locationLabel} />
      </div>
      <div className="ui-module home-context-weather">
        <HomeWeather onLocationResolved={setLocationLabel} />
      </div>
    </section>
  );
}

export function HomeInsightRow({
  sourceLabel,
  source,
  period,
  onPeriod,
  slots,
  trendMetricKey,
  onTrendMetric,
  trendData,
  maxTrend,
}: {
  sourceLabel: string;
  source: string;
  period: 'seven' | 'thirty';
  onPeriod: (period: 'seven' | 'thirty') => void;
  slots: HomeCoreMetricSlot[];
  trendMetricKey: HomeCoreMetricKey;
  onTrendMetric: (key: HomeCoreMetricKey) => void;
  trendData: Array<{ label: string; value: number }>;
  maxTrend: number;
}) {
  const metricsByKey = new Map(slots.map((slot) => [slot.key, slot]));
  return (
    <section className="home-insight-row" aria-label="内容走势">
      <div className="ui-module home-insight-trend">
        <div className="ui-module-head">
          <h2 className="ui-module-title"><span className="ui-code">T-01</span>趋势</h2>
          <div className="ui-tabs" style={{ marginBottom: 0 }}>
            <button className={`ui-tab ${period === 'seven' ? 'ui-tab--active' : ''}`} onClick={() => onPeriod('seven')}>7 天</button>
            <button className={`ui-tab ${period === 'thirty' ? 'ui-tab--active' : ''}`} onClick={() => onPeriod('thirty')}>30 天</button>
          </div>
        </div>
        {trendData.length === 0 ? (
          <div className="empty-state"><p>同步后展示每日趋势。</p></div>
        ) : (
          <div className="home-insight-trend-body">
            <div className="flex gap-2 mb-3" style={{ flexWrap: 'wrap' }}>
              {HOME_CORE_METRIC_KEYS.map((key) => {
                const slot = metricsByKey.get(key);
                return (
                  <button
                    key={key}
                    className={`nb-chip ${trendMetricKey === key ? 'nb-chip--active' : ''}`}
                    onClick={() => onTrendMetric(key)}
                  >
                    {slot?.label ?? key}
                  </button>
                );
              })}
            </div>
            <div className="trend-scroll">
              <LieflatChunkyBars
                data={trendData}
                maxValue={maxTrend}
                height={248}
                valueFormatter={formatNumber}
                ariaLabel={`T-01 ${metricsByKey.get(trendMetricKey)?.label ?? trendMetricKey}趋势`}
              />
            </div>
          </div>
        )}
      </div>
      <div className="ui-module home-insight-metrics">
        <div className="ui-module-head">
          <h2 className="ui-module-title"><span className="ui-code">M-01</span>小红书关键指标</h2>
          <span className={`nb-badge ${source === 'error' ? 'nb-badge--red' : ''}`}>{sourceLabel}</span>
        </div>
        <div className="home-metric-grid">
          {slots.map((slot) => (
            <HomeCoreMetricCard key={slot.key} slot={slot} />
          ))}
        </div>
      </div>
    </section>
  );
}

export function HomeWorkRow({
  notes,
  todos,
  todoTotal,
  todoStale,
}: {
  notes: NotePerformance[];
  todos: TodoItem[];
  todoTotal: number;
  todoStale: boolean;
}) {
  const navigate = useNavigate();
  const previewNotes = notes.slice(0, HOME_NOTES_LIMIT);
  return (
    <section className="home-work-row" aria-label="笔记与任务">
      <div className="ui-module home-work-notes">
        <div className="ui-module-head">
          <h2 className="ui-module-title"><span className="ui-code">N-01</span>最近笔记表现</h2>
          <Link to="/performance" className="nb-btn nb-btn--ghost">详情</Link>
        </div>
        {previewNotes.length === 0 ? (
          <div className="empty-state"><p>同步后展示最近笔记表现。</p></div>
        ) : (
          <div className="ui-stack">
            {previewNotes.map((n) => (
              <NoteRow key={n.id} note={n} />
            ))}
            <Link to="/performance" className="nb-btn nb-btn--ghost">查看全部笔记</Link>
          </div>
        )}
      </div>
      <div className="ui-module home-work-todos">
        <div className="ui-module-head">
          <h2 className="ui-module-title"><span className="ui-code">Q-01</span>今日待办</h2>
          <span className="nb-badge">{todoTotal} 条</span>
        </div>
        {todoStale && (
          <div className="nb-muted" style={{ fontSize: 13, marginBottom: 10 }}>更新延迟</div>
        )}
        {todos.length === 0 ? (
          <div className="empty-state">
            <div className="empty-face">✓</div>
            <p>今天暂无待推进事项</p>
          </div>
        ) : (
          <div className="ui-stack">
            {todos.map((t) => (
              <TodoRow
                key={t.id}
                todo={t}
                compact
                official
                onOpen={(id) => navigate(`/todos?focus=${id}`)}
              />
            ))}
            <Link to="/todos" className="nb-btn nb-btn--ghost">
              查看全部 {todoTotal} 条
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
