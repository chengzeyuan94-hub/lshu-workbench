import type { ActionProgressModel } from '../lib/actionProgress';

interface Props {
  progress: ActionProgressModel;
  onRetry?: () => void;
}

export default function ActionProgress({ progress, onRetry }: Props) {
  if (progress.state === 'idle') return null;

  const running = progress.state === 'running';
  const determinate = progress.mode === 'determinate' && progress.max != null && progress.max > 0;
  const valueNow = determinate ? Math.max(0, Math.min(progress.max ?? 0, progress.value ?? 0)) : undefined;
  const percent = determinate && progress.max ? Math.round((valueNow! / progress.max) * 100) : 32;
  const valueText = running
    ? progress.label
    : progress.state === 'success'
      ? (progress.successMessage || '已完成')
      : (progress.errorMessage || '失败');
  const statusText = running
    ? progress.label
    : progress.state === 'success'
      ? (progress.successMessage || '已完成')
      : (progress.errorMessage || '操作失败');

  return (
    <div className={`action-progress action-progress--${progress.state}`} aria-busy={running}>
      <div
        className="action-progress-bar"
        role="progressbar"
        aria-label={progress.label || '任务进度'}
        aria-valuetext={valueText}
        {...(determinate
          ? { 'aria-valuenow': valueNow, 'aria-valuemin': 0, 'aria-valuemax': progress.max }
          : { 'aria-valuemin': 0, 'aria-valuemax': 100 })}
      >
        <div className="action-progress-track">
          <div
            className={`action-progress-fill action-progress-fill--${progress.state}${determinate ? '' : ' action-progress-fill--indet'}`}
            style={determinate ? { width: `${percent}%` } : undefined}
          />
        </div>
      </div>
      <div className="action-progress-copy" role="status" aria-live="polite">
        {statusText}
      </div>
      {progress.state === 'error' && onRetry ? (
        <button type="button" className="nb-btn nb-btn--ghost action-progress-retry" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}
