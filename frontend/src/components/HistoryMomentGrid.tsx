import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'pixelarticons/react';
import { ChevronDown2 } from 'pixelarticons/react/ChevronDown2.js';
import { ChevronUp2 } from 'pixelarticons/react/ChevronUp2.js';
import { Copy } from 'pixelarticons/react/Copy.js';
import lshuAvatar from '../assets/avatar/lshu-avatar.source.svg';
import type { KnowledgeMomentDraft } from '../types';

export interface HistoryMomentGridProps {
  items: KnowledgeMomentDraft[];
  busy?: boolean;
}

const ROW_HEIGHT = 8;
const ROW_GAP = 8;

const MODE_COPY: Record<KnowledgeMomentDraft['generation_mode'], string> = {
  single: '单篇生成',
  batch: '批量生成',
  retry: '重新生成',
};

function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function copyDraft(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('当前浏览器无法访问剪贴板');
  await navigator.clipboard.writeText(text);
}

/**
 * 用细网格行计算卡片跨度，保留 DOM 的时间顺序，同时获得稳定瀑布布局。
 * 不使用 grid-auto-flow:dense，避免视觉顺序与键盘顺序发生重排。
 */
function MasonryCell({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState(1);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return undefined;

    const measure = () => {
      const height = element.getBoundingClientRect().height;
      setSpan(Math.max(1, Math.ceil((height + ROW_GAP) / (ROW_HEIGHT + ROW_GAP))));
    };
    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="kb-history-grid-cell" role="listitem" style={{ gridRowEnd: `span ${span}` }}>
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

function HistoryMomentCard({ item, index }: { item: KnowledgeMomentDraft; index: number }) {
  const bodyId = useId();
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const longDraft = item.draft.length > 320;

  const handleCopy = async () => {
    setCopyError('');
    try {
      await copyDraft(item.draft);
      setCopied(true);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : '复制失败，请手动复制正文。');
    }
  };

  return (
    <article className="kb-moment-card kb-moment-card--success kb-history-moment-card" aria-labelledby={titleId}>
      <div className="kb-moment-topic">
        <span className="kb-moment-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="kb-history-topic-copy">
          <h3 id={titleId} title={item.source_title}>{item.source_title || '未命名选题'}</h3>
          {item.source_author && <span>{item.source_author}</span>}
        </div>
        <span className="nb-badge kb-moment-status kb-moment-status--success">
          {MODE_COPY[item.generation_mode] || '已生成'}
        </span>
      </div>

      <div className="kb-moment-layout">
        <img className="kb-moment-avatar" src={lshuAvatar} alt="" aria-hidden="true" />
        <div className="kb-moment-content">
          <div className="kb-moment-name">L叔 · LOCAL COMMAND</div>
          <div id={bodyId} className={`kb-moment-copy${expanded ? ' is-expanded' : ''}`}>
            {item.draft}
          </div>
          {longDraft && (
            <button
              type="button"
              className="kb-moment-expand"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? <ChevronUp2 width={16} height={16} aria-hidden="true" />
                : <ChevronDown2 width={16} height={16} aria-hidden="true" />}
              {expanded ? '收起正文' : '展开全文'}
            </button>
          )}

          {copyError && <div className="kb-history-copy-error" role="alert">{copyError}</div>}
          <div className="kb-moment-footer">
            <span>{formatGeneratedAt(item.created_at)} · 本地草稿 · 未发布</span>
            <div className="kb-history-card-actions">
              {item.source_url && (
                <a className="kb-moment-copy-button" href={item.source_url} target="_blank" rel="noreferrer">
                  查看选题
                </a>
              )}
              <button
                type="button"
                className="kb-moment-copy-button"
                aria-label={`复制朋友圈正文：${item.source_title || '未命名选题'}`}
                onClick={() => void handleCopy()}
              >
                {copied
                  ? <Check width={16} height={16} aria-hidden="true" />
                  : <Copy width={16} height={16} aria-hidden="true" />}
                {copied ? '已复制' : '复制正文'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

export default function HistoryMomentGrid({ items, busy = false }: HistoryMomentGridProps) {
  return (
    <div className="kb-history-view">
      <div className="kb-history-grid" role="list" aria-label="历史朋友圈草稿" aria-busy={busy}>
        {items.map((item, index) => (
          <MasonryCell key={item.id}>
            <HistoryMomentCard item={item} index={index} />
          </MasonryCell>
        ))}
      </div>
    </div>
  );
}
