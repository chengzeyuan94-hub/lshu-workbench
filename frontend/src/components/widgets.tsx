import type { CreatorMetric, NotePerformance, TodoItem } from '../types';
import {
  IconEye,
  IconHeart,
  IconStar,
  IconComment,
  IconShare,
  IconUserPlus,
} from '../components/icons';

const metricMeta: Record<string, { icon: JSX.Element; unit: string }> = {
  views: { icon: <IconEye />, unit: '' },
  avg_view_time: { icon: <IconEye />, unit: '' },
  home_views: { icon: <IconUserPlus />, unit: '' },
  likes: { icon: <IconHeart />, unit: '' },
  collects: { icon: <IconStar />, unit: '' },
  comments: { icon: <IconComment />, unit: '' },
  shares: { icon: <IconShare />, unit: '' },
  new_followers: { icon: <IconUserPlus />, unit: '' },
};

export function formatNumber(n: number): string {
  if (n >= 10000) {
    return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + 'w';
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + 'k';
  }
  return String(n);
}

export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '0秒';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s}秒`;
  return `${m}分${s}秒`;
}

export function formatMetricValue(metric: CreatorMetric): string {
  if (metric.key === 'avg_view_time') {
    return formatDuration(metric.total);
  }
  return formatNumber(metric.total);
}

export function MetricCard({ metric }: { metric: CreatorMetric }) {
  const meta = metricMeta[metric.key] ?? {
    icon: <IconEye />,
    unit: '',
  };
  return (
    <div className="ui-metric">
      <div className="ui-metric-label">
        <span aria-hidden="true">{meta.icon}</span>
        {metric.label}
      </div>
      <div className="ui-data">{formatMetricValue(metric)}</div>
    </div>
  );
}

export function NoteRow({ note }: { note: NotePerformance }) {
  const rate = note.collectRate ?? (note.views > 0 ? (note.collects / note.views) * 100 : 0);
  const isGood = rate >= 5;
  const isLow = note.lowPerformance || (note.views > 0 && note.views < 500);
  return (
    <div className="ui-row">
      <div className="note-rank">{note.rank}</div>
      <div className="min-0" style={{ flex: 1 }}>
        <div className="note-title">{note.title}</div>
        <div className="nb-muted" style={{ fontSize: 12 }}>{note.date}</div>
        {note.url && (
          <a
            href={note.url}
            target="_blank"
            rel="noopener noreferrer"
            className="note-detail-link"
          >
            查看创作中心详情
          </a>
        )}
      </div>
      <div className="note-stats">
        <span title="观看"><IconEye size={14} />{formatNumber(note.views)}</span>
        <span title="点赞"><IconHeart size={14} />{formatNumber(note.likes)}</span>
        <span title="收藏"><IconStar size={14} />{formatNumber(note.collects)}</span>
        <span title="评论"><IconComment size={14} />{formatNumber(note.comments)}</span>
      </div>
      <div style={{ textAlign: 'right', minWidth: 84 }}>
        {isGood ? (
          <span className="nb-tag-good">高收藏 {rate.toFixed(1)}%</span>
        ) : isLow ? (
          <span className="nb-tag-low">低表现</span>
        ) : (
          <span className="nb-muted" style={{ fontSize: 12 }}>收藏 {rate.toFixed(1)}%</span>
        )}
      </div>
    </div>
  );
}

export function TodoRow({
  todo,
  onConfirm,
  onIgnore,
  onOpen,
  compact,
  official,
}: {
  todo: TodoItem;
  onConfirm?: (id: number) => void;
  onIgnore?: (id: number) => void;
  onOpen?: (id: number) => void;
  compact?: boolean;
  official?: boolean;
}) {
  const meta = official
    ? [
        todo.cluster,
        todo.sourceType,
        todo.plannedStartAt
          ? `开始 ${new Date(todo.plannedStartAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`
          : '',
        todo.dueAt ? `截止 ${new Date(todo.dueAt).toLocaleDateString()}` : '',
      ].filter(Boolean).join(' · ')
    : [todo.cluster, todo.sourcePath].filter(Boolean).join(' · ');
  const body = (
    <>
      <div className="flex items-center justify-between" style={{ gap: 12, width: '100%' }}>
        <div className="flex items-center min-0" style={{ gap: 12, flex: 1 }}>
          <span className={`priority-dot priority-${todo.priority}`} aria-label={`优先级 ${todo.priority}`} />
          <div className="min-0">
            <div className="note-title">{todo.title}</div>
            <div className="nb-muted" style={{ fontSize: 12, marginTop: 3 }}>
              {meta}
            </div>
          </div>
        </div>
        {!official && (
          <div className="flex gap-2" style={{ flexShrink: 0 }}>
            {onConfirm && (
              <button className="nb-btn nb-btn--primary" onClick={() => onConfirm(todo.id)}>
                确认
              </button>
            )}
            {onIgnore && (
              <button className="nb-btn nb-btn--ghost" onClick={() => onIgnore(todo.id)}>
                忽略
              </button>
            )}
          </div>
        )}
      </div>
      {todo.reason && !compact && (
        <div className="nb-muted" style={{ fontSize: 13, marginTop: 10, width: '100%' }}>
          建议：{todo.reason}
        </div>
      )}
    </>
  );
  if (onOpen) {
    return (
      <button type="button" className="ui-row home-today-row" onClick={() => onOpen(todo.id)}>
        {body}
      </button>
    );
  }
  return <div className="ui-row">{body}</div>;
}
