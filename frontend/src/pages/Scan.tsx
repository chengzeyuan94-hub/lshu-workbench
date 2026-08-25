import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ScanReport } from '../types';
import { formatNumber } from '../components/widgets';
import ActionProgress from '../components/ActionProgress';
import { useActionProgress } from '../lib/actionProgress';

export default function ScanPage() {
  const [reports, setReports] = useState<ScanReport[]>([]);
  const [selected, setSelected] = useState<ScanReport | null>(null);
  const scanProgress = useActionProgress();
  const [error, setError] = useState('');

  useEffect(() => {
    api.getScanReports().then((r) => {
      setReports(r);
      if (r.length > 0) setSelected(r[0]);
    }).catch(() => {});
  }, []);

  const runScan = async () => {
    setError('');
    try {
      await scanProgress.run(async () => {
        const r = await api.scanDesktop();
        setReports((prev) => [r, ...prev.filter((x) => x.id !== r.id)]);
        setSelected(r);
      }, { label: '正在扫描桌面', successMessage: '扫描完成' });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="ui-page">
      <div className="ui-page-head">
        <div>
          <div className="ui-page-kicker">S-06 · SCAN</div>
          <h1>扫描报告</h1>
        </div>
        <button className="nb-btn nb-btn--primary" onClick={runScan} disabled={scanProgress.running}>
          {scanProgress.running ? '扫描中…' : '重新扫描桌面'}
        </button>
      </div>

      <ActionProgress progress={scanProgress.progress} onRetry={runScan} />

      {error && (
        <div className="ui-alert ui-alert--error">{error}</div>
      )}

      <div className="scan-layout">
        <div className="ui-module">
          <h2 className="ui-module-title"><span className="ui-code">H-06</span>历史扫描</h2>
          {reports.length === 0 ? (
            <div className="empty-state"><p>还没有扫描记录，点击「重新扫描桌面」开始。</p></div>
          ) : (
            <div className="ui-stack">
              {reports.map((r) => (
                <button
                  key={r.id}
                  className={`scan-history-row ${selected?.id === r.id ? 'scan-selected' : ''}`}
                  onClick={() => setSelected(r)}
                >
                  <div className="flex items-center justify-between">
                    <strong>{r.scannedAt}</strong>
                    <span className="nb-badge">{r.fileCount} 文件</span>
                  </div>
                  <div className="nb-muted" style={{ fontSize: 12, marginTop: 6 }}>{r.rootDir}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 选中报告详情 */}
        <div className="ui-module">
          <h2 className="ui-module-title">
            <span className="ui-code">R-06</span>
            {selected ? `报告详情 · ${selected.scannedAt}` : '报告详情'}
          </h2>
          {!selected ? (
            <div className="empty-state"><p>选择一条扫描记录查看详情。</p></div>
          ) : (
            <>
              <div className="flex gap-3 mb-3" style={{ flexWrap: 'wrap' }}>
                <div className="nb-badge">扫描 {formatNumber(selected.fileCount)} 文件</div>
                <div className="nb-badge nb-badge--blush">跳过 {formatNumber(selected.skippedCount)}</div>
                <div className="nb-badge">{selected.clusters.length} 项目簇</div>
              </div>

              {/* 项目簇 */}
              <h3 style={{ fontSize: 16, margin: '12px 0 8px' }}>识别出的项目簇</h3>
              {selected.clusters.length === 0 ? (
                <p className="nb-muted" style={{ fontSize: 13 }}>未识别到明显的项目簇。</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {selected.clusters.map((c) => (
                    <div key={c.name} className="cluster-row">
                      <span className="nb-badge">{c.fileCount} 文件</span>
                      <div>
                        <strong>{c.name}</strong>
                        <div className="nb-muted" style={{ fontSize: 12 }}>{c.reason}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 文件样本 */}
              <h3 style={{ fontSize: 16, margin: '16px 0 8px' }}>文件样本（前 40）</h3>
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {selected.files.slice(0, 40).map((f) => (
                  <div key={f.path} className="file-row">
                    <span className="file-type">{f.type || '?'}</span>
                    <div className="min-0">
                      <div className="file-name" title={f.name}>{f.name}</div>
                      <div className="file-path" title={f.path}>{f.path}</div>
                    </div>
                    <span className="nb-muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{formatNumber(f.size)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
