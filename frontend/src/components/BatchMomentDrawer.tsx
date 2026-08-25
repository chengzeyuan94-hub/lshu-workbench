import { useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'pixelarticons/react';
import { ChevronDown2 } from 'pixelarticons/react/ChevronDown2.js';
import { ChevronUp2 } from 'pixelarticons/react/ChevronUp2.js';
import { Copy } from 'pixelarticons/react/Copy.js';
import { RefreshSolid } from 'pixelarticons/react/RefreshSolid.js';
import lshuAvatar from '../assets/avatar/lshu-avatar.source.svg';
import type { BatchDraftItem } from '../features/hotspots/batchDrafts';

export interface BatchMomentDrawerProps {
  open: boolean;
  items: BatchDraftItem[];
  onClose: () => void;
  onRetry: (articleId: string) => void | Promise<void>;
}

type CopyState = 'idle' | 'success' | 'error';

const STATUS_COPY: Record<BatchDraftItem['status'], string> = {
  queued: '排队中',
  running: '正在生成',
  success: '已完成',
  error: '生成失败',
};

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

async function copyText(text: string): Promise<void> {
  if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('当前浏览器无法访问剪贴板');
  }
  await navigator.clipboard.writeText(text);
}

export default function BatchMomentDrawer({
  open,
  items,
  onClose,
  onRetry,
}: BatchMomentDrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [copiedIds, setCopiedIds] = useState<Set<string>>(() => new Set());
  const [copyAllState, setCopyAllState] = useState<CopyState>('idle');
  const [copyError, setCopyError] = useState('');

  const completed = useMemo(
    () => items.filter((item) => item.status === 'success' || item.status === 'error').length,
    [items],
  );
  const successful = useMemo(
    () => items.filter((item) => item.status === 'success' && item.draft),
    [items],
  );
  const failed = useMemo(
    () => items.filter((item) => item.status === 'error').length,
    [items],
  );
  const busy = items.some((item) => item.status === 'queued' || item.status === 'running');

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);

      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  useEffect(() => {
    const currentIds = new Set(items.map((item) => item.articleId));
    setExpandedIds((current) => new Set([...current].filter((id) => currentIds.has(id))));
    setCopiedIds((current) => new Set([...current].filter((id) => currentIds.has(id))));
  }, [items]);

  if (!open) return null;

  const toggleExpanded = (articleId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(articleId)) next.delete(articleId);
      else next.add(articleId);
      return next;
    });
  };

  const handleCopy = async (item: BatchDraftItem) => {
    if (!item.draft) return;
    setCopyError('');
    try {
      await copyText(item.draft);
      setCopiedIds((current) => new Set(current).add(item.articleId));
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : '复制失败，请手动复制正文。');
    }
  };

  const handleCopyAll = async () => {
    if (successful.length === 0) return;
    setCopyAllState('idle');
    setCopyError('');
    try {
      await copyText(successful.map((item) => item.draft).join('\n\n\n'));
      setCopyAllState('success');
      setCopiedIds(new Set(successful.map((item) => item.articleId)));
    } catch (error) {
      setCopyAllState('error');
      setCopyError(error instanceof Error ? error.message : '复制失败，请逐篇复制正文。');
    }
  };

  const handleRetry = async (articleId: string) => {
    setCopiedIds((current) => {
      const next = new Set(current);
      next.delete(articleId);
      return next;
    });
    setCopyError('');
    try {
      await onRetry(articleId);
    } catch {
      // The parent owns the per-item error state; keep this drawer stable if it rejects.
    }
  };

  const progressCopy = failed > 0
    ? `已完成 ${completed}/${items.length}，${failed} 篇需要重试`
    : `已完成 ${completed}/${items.length}`;

  return (
    <div className="drawer-overlay kb-batch-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="drawer drawer--batch"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kb-batch-drawer-title"
        aria-describedby="kb-batch-drawer-status"
        aria-busy={busy}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="drawer-header kb-batch-header">
          <div>
            <div className="drawer-kicker">L叔精选 · MOMENTS DRAFTS</div>
            <h2 id="kb-batch-drawer-title" className="drawer-title">批量朋友圈草稿</h2>
          </div>
          <div className="kb-batch-actions">
            <button
              type="button"
              className="nb-btn nb-btn--primary"
              disabled={successful.length === 0}
              onClick={() => void handleCopyAll()}
            >
              {copyAllState === 'success' ? <Check width={18} height={18} aria-hidden="true" /> : <Copy width={18} height={18} aria-hidden="true" />}
              {copyAllState === 'success' ? '已复制全部' : `全部复制${successful.length ? `（${successful.length}）` : ''}`}
            </button>
            <button
              ref={closeRef}
              type="button"
              className="nb-btn nb-btn--ghost drawer-close"
              aria-label="关闭批量朋友圈草稿"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </div>

        <div className="drawer-source kb-batch-summary">
          <div
            className="kb-batch-progress"
            role="progressbar"
            aria-label="批量朋友圈生成进度"
            aria-valuemin={0}
            aria-valuemax={items.length || 1}
            aria-valuenow={completed}
            aria-valuetext={progressCopy}
          >
            <span aria-hidden="true" className="kb-batch-progress-track">
              <span
                className="kb-batch-progress-fill"
                style={{ width: `${items.length ? Math.round((completed / items.length) * 100) : 0}%` }}
              />
            </span>
          </div>
          <span id="kb-batch-drawer-status" className="nb-muted" role="status" aria-live="polite">
            {busy ? `正在生成 · ${progressCopy}` : progressCopy}
          </span>
        </div>

        <div className="drawer-body kb-batch-body">
          {copyError && <div className="ui-alert ui-alert--error kb-batch-copy-error" role="alert">{copyError}</div>}

          {items.length === 0 ? (
            <div className="empty-state"><p>还没有可展示的朋友圈草稿。</p></div>
          ) : (
            <div className="kb-batch-grid" aria-label="朋友圈草稿列表">
              {items.map((item, index) => {
                const expanded = expandedIds.has(item.articleId);
                const copied = copiedIds.has(item.articleId);
                const longDraft = (item.draft?.length ?? 0) > 320;
                const itemTitleId = `kb-moment-title-${index}`;

                return (
                  <article
                    key={item.articleId}
                    className={`kb-moment-card kb-moment-card--${item.status}`}
                    aria-labelledby={itemTitleId}
                    aria-busy={item.status === 'queued' || item.status === 'running'}
                  >
                    <div className="kb-moment-topic">
                      <span className="kb-moment-index">{String(index + 1).padStart(2, '0')}</span>
                      <h3 id={itemTitleId} title={item.title}>{item.title}</h3>
                      <span className={`nb-badge kb-moment-status kb-moment-status--${item.status}`}>
                        {STATUS_COPY[item.status]}
                      </span>
                    </div>

                    <div className="kb-moment-layout">
                      <img className="kb-moment-avatar" src={lshuAvatar} alt="" aria-hidden="true" />
                      <div className="kb-moment-content">
                        <div className="kb-moment-name">L叔 · LOCAL COMMAND</div>

                        {item.status === 'queued' && (
                          <div className="kb-moment-pending">正在等待生成这条朋友圈正文…</div>
                        )}
                        {item.status === 'running' && (
                          <div className="kb-moment-pending" role="status">AI 正在撰写朋友圈正文…</div>
                        )}
                        {item.status === 'error' && (
                          <div className="kb-moment-error" role="alert">
                            <p>{item.errorMessage || '这篇朋友圈正文未能生成，请单独重试。'}</p>
                            <button
                              type="button"
                              className="nb-btn nb-btn--ghost"
                              onClick={() => void handleRetry(item.articleId)}
                            >
                              <RefreshSolid width={18} height={18} aria-hidden="true" />
                              重新生成
                            </button>
                          </div>
                        )}
                        {item.status === 'success' && item.draft && (
                          <>
                            <div className={`kb-moment-copy${expanded ? ' is-expanded' : ''}`}>
                              {item.draft}
                            </div>
                            {longDraft && (
                              <button
                                type="button"
                                className="kb-moment-expand"
                                aria-expanded={expanded}
                                onClick={() => toggleExpanded(item.articleId)}
                              >
                                {expanded ? <ChevronUp2 width={16} height={16} aria-hidden="true" /> : <ChevronDown2 width={16} height={16} aria-hidden="true" />}
                                {expanded ? '收起正文' : '展开全文'}
                              </button>
                            )}
                          </>
                        )}

                        <div className="kb-moment-footer">
                          <span>刚刚 · 本地草稿 · 未发布</span>
                          {item.status === 'success' && item.draft && (
                            <button
                              type="button"
                              className="kb-moment-copy-button"
                              aria-label={`复制第 ${index + 1} 条朋友圈正文`}
                              onClick={() => void handleCopy(item)}
                            >
                              {copied ? <Check width={16} height={16} aria-hidden="true" /> : <Copy width={16} height={16} aria-hidden="true" />}
                              {copied ? '已复制' : '复制正文'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
