import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AppSettings, XhsAccountInfo, XhsVerificationStatus, HotspotStatus, KnowledgeStatus, ConnectorStatus } from '../types';
import ActionProgress from '../components/ActionProgress';
import { useActionProgress } from '../lib/actionProgress';
import { calendarConnectSuccessCopy, shouldHintCalendarPermissionDialog } from '../lib/calendarStatus';

function statusLabel(status: XhsVerificationStatus): string {
  switch (status) {
    case 'verified':
      return '已验证';
    case 'mismatch':
      return '账号不匹配';
    case 'unconnected':
      return '未连接';
    default:
      return '未知';
  }
}

function formatNumber(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return n.toLocaleString();
}

function formatTime(t: string | null | undefined): string {
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return d.toLocaleString();
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [scanRoot, setScanRoot] = useState('');
  const [refreshMinutes, setRefreshMinutes] = useState(30);
  const [saved, setSaved] = useState(false);
  // 后端连接状态：'loading' | 'online' | 'offline' | 'error'
  const [backend, setBackend] = useState<'loading' | 'online' | 'offline' | 'error'>('loading');
  const [backendMsg, setBackendMsg] = useState('');
  // 小红书账号连接状态
  const [account, setAccount] = useState<XhsAccountInfo | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountSync, setAccountSync] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [accountMsg, setAccountMsg] = useState('');
  // 次幂数据与热点雷达（V1.3）
  const [hotspot, setHotspot] = useState<HotspotStatus | null>(null);
  const [hotspotLoading, setHotspotLoading] = useState(false);
  const [hotspotMsg, setHotspotMsg] = useState('');
  const [scheduleTimes, setScheduleTimes] = useState('13:30,20:30');
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [hotspotSaved, setHotspotSaved] = useState(false);
  // 知识大脑连接（V1.4）
  const [knowledge, setKnowledge] = useState<KnowledgeStatus | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeMsg, setKnowledgeMsg] = useState('');
  const [aiNotice, setAiNotice] = useState('');
  const verifyProgress = useActionProgress();
  const hotspotTestProgress = useActionProgress();
  const knowledgeTestProgress = useActionProgress();
  const knowledgeRefreshProgress = useActionProgress();
  const calendarProgress = useActionProgress();
  const aiCacheProgress = useActionProgress();
  const [calendarNote, setCalendarNote] = useState('');
  const [calendarConnector, setCalendarConnector] = useState<ConnectorStatus | null>(null);
  const [feishuCoverageNote, setFeishuCoverageNote] = useState('');

  const loadAccount = useCallback(async () => {
    setAccountLoading(true);
    setAccountMsg('');
    try {
      const a = await api.getAccount();
      setAccount(a);
    } catch (e) {
      setAccountMsg((e as Error).message);
    } finally {
      setAccountLoading(false);
    }
  }, []);

  const verifyAndSync = useCallback(async () => {
    setAccountSync('loading');
    setAccountMsg('');
    try {
      await verifyProgress.run(async () => {
        const r = await api.verifyAndSync();
        setAccountMsg(r.message ?? '');
        setAccountSync(r.ok ? 'done' : 'error');
      }, { label: '正在验证并同步账号', successMessage: '验证完成' });
    } catch (e) {
      setAccountMsg((e as Error).message);
      setAccountSync('error');
    } finally {
      await loadAccount();
      setAccountSync('idle');
    }
  }, [loadAccount, verifyProgress.run]);

  const loadBackend = useCallback(async () => {
    setBackend('loading');
    setBackendMsg('');
    try {
      await api.health();
      setBackend('online');
    } catch (e) {
      setBackend('offline');
      setBackendMsg((e as Error).message);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      setScanRoot(s.scanRoot);
      setRefreshMinutes(s.refreshMinutes);
      setScheduleTimes((s.hotspotScheduleTimes || ['13:30', '20:30']).join(','));
      setAutoEnabled(s.hotspotAutoEnabled !== false);
    } catch (e) {
      setBackend('offline');
      setBackendMsg((e as Error).message);
    }
  }, []);

  const loadHotspot = useCallback(async () => {
    setHotspotLoading(true);
    try {
      const h = await api.getHotspotStatus();
      setHotspot(h);
    } catch (e) {
      setHotspotMsg((e as Error).message);
    } finally {
      setHotspotLoading(false);
    }
  }, []);

  const testHotspotConnection = useCallback(async () => {
    setHotspotMsg('');
    try {
      await hotspotTestProgress.run(async () => {
        const h = await api.getHotspotStatus();
        setHotspot(h);
        if (h.cimi.hasCredentials) {
          setHotspotMsg(`次幂数据已配置（App ID ${h.cimi.appIdMasked}），接口可用。`);
        } else {
          setHotspotMsg('尚未配置次幂凭证，请在 backend/.env.local 填写后重启后端。');
        }
      }, { label: '正在测试热点连接', successMessage: '连接检测完成' });
    } catch (e) {
      setHotspotMsg(`测试失败：${(e as Error).message}`);
    }
  }, [hotspotTestProgress.run]);

  const loadKnowledge = useCallback(async () => {
    setKnowledgeLoading(true);
    try {
      const k = await api.getKnowledgeStatus();
      setKnowledge(k);
      setKnowledgeMsg('');
    } catch (e) {
      setKnowledge(null);
      setKnowledgeMsg((e as Error).message);
    } finally {
      setKnowledgeLoading(false);
    }
  }, []);

  const testKnowledgeConnection = useCallback(async () => {
    setKnowledgeMsg('');
    setKnowledgeLoading(true);
    try {
      await knowledgeTestProgress.run(async () => {
        const k = await api.getKnowledgeStatus();
        setKnowledge(k);
        if (k.online) {
          const modelHint = k.modelsConfigured ? '模型密钥已配置' : '模型密钥未配置（仅可浏览，无法问答）';
          setKnowledgeMsg(`知识库服务在线（文档 ${k.documents} · 片段 ${k.chunks}）· ${modelHint}。`);
        } else {
          setKnowledgeMsg('知识库服务离线，请检查 KNOWLEDGE_BASE_URL 或服务是否已启动。');
        }
      }, { label: '正在测试知识库连接', successMessage: '连接检测完成' });
    } catch (e) {
      setKnowledgeMsg(`测试失败：${(e as Error).message}`);
    } finally {
      setKnowledgeLoading(false);
    }
  }, [knowledgeTestProgress.run]);

  const refreshKnowledge = useCallback(async () => {
    setKnowledgeLoading(true);
    try {
      await knowledgeRefreshProgress.run(async () => {
        const k = await api.getKnowledgeStatus();
        setKnowledge(k);
        setKnowledgeMsg('');
      }, { label: '正在刷新知识库连接', successMessage: '连接已刷新' });
    } catch (e) {
      setKnowledge(null);
      setKnowledgeMsg((e as Error).message);
    } finally {
      setKnowledgeLoading(false);
    }
  }, [knowledgeRefreshProgress.run]);

  const loadCalendarStatus = useCallback(async () => {
    try {
      const [status, agenda] = await Promise.all([api.getConnectorStatus(), api.getAgenda()]);
      const cal = status.connectors.find((c) => c.id === 'calendar') || null;
      setCalendarConnector(cal);
      if (agenda.coverageError === 'feishu_coverage') {
        setFeishuCoverageNote('飞书日程覆盖：不完整');
      } else {
        setFeishuCoverageNote('');
      }
      if (cal?.available && cal.permission === 'fullAccess') {
        setCalendarNote(calendarConnectSuccessCopy('fullAccess', cal.itemsRead ?? 0));
      }
      return { status, agenda, cal };
    } catch {
      return { status: null, agenda: null, cal: null };
    }
  }, []);

  useEffect(() => {
    loadBackend();
    loadSettings();
    loadAccount();
    loadHotspot();
    loadKnowledge();
    void loadCalendarStatus();
  }, [loadBackend, loadSettings, loadAccount, loadHotspot, loadKnowledge, loadCalendarStatus]);

  const save = async () => {
    try {
      await api.updateSettings({ scanRoot, refreshMinutes });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setBackend('offline');
      setBackendMsg((e as Error).message);
    }
  };

  const saveHotspot = async () => {
    try {
      const arr = scheduleTimes.split(',').map((t) => t.trim()).filter(Boolean);
      await api.updateSettings({ hotspotScheduleTimes: arr, hotspotAutoEnabled: autoEnabled });
      setHotspotSaved(true);
      setTimeout(() => setHotspotSaved(false), 2000);
    } catch (e) {
      setHotspotMsg(`保存失败：${(e as Error).message}`);
    }
  };

  // 后端未连接：显示明确错误，不再永久"加载设置中…"
  if (backend === 'offline' || backend === 'error') {
    return (
      <div className="ui-page">
        <div className="ui-page-head">
          <div>
            <div className="ui-page-kicker">S-07 · SETTINGS</div>
            <h1>设置</h1>
          </div>
        </div>
        <div className="ui-alert ui-alert--error">
          <h2 className="nb-section-title" style={{ fontSize: 20 }}>后端未连接</h2>
          <p style={{ fontSize: 14, lineHeight: 1.7 }}>
            无法连接到本机后端服务。设置页需要后端提供数据，当前处于离线状态。
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12, fontSize: 14 }}>
            <div><strong>1. 确认后端已启动</strong> — 在项目目录运行：<code>./start.sh</code></div>
            <div><strong>2. 手动检查</strong> — 浏览器访问 <code>http://localhost:3456/api/health</code>，应返回 <code>{'{ "ok": true }'}</code></div>
            <div><strong>3. 常见原因</strong> — Node 版本不匹配或 better-sqlite3 编译失败，请根据后端控制台提示修复。</div>
          </div>
          {backendMsg && (
            <div className="nb-muted" style={{ fontSize: 13, marginTop: 10, wordBreak: 'break-all' }}>
              错误信息：{backendMsg}
            </div>
          )}
          <button className="nb-btn nb-btn--denim" style={{ marginTop: 16 }} onClick={loadBackend}>
            重试连接
          </button>
        </div>
      </div>
    );
  }

  if (!settings) {
    return <div className="nb-card empty-state"><p>加载设置中…</p></div>;
  }

  return (
    <div className="ui-page">
      <div className="ui-page-head">
        <div>
          <div className="ui-page-kicker">S-07 · SETTINGS</div>
          <h1>设置</h1>
        </div>
      </div>

      <div className="grid-2 setting-section" style={{ alignItems: 'start' }}>
        <div className="ui-module">
          <h2 className="ui-module-title"><span className="ui-code">SYS</span>系统 · 桌面扫描</h2>

          <label className="setting-label">扫描根目录</label>
          <input className="nb-input" value={scanRoot} onChange={(e) => setScanRoot(e.target.value)} />

          <label className="setting-label">数据刷新间隔（分钟）</label>
          <input
            className="nb-input"
            type="number"
            min={5}
            value={refreshMinutes}
            onChange={(e) => setRefreshMinutes(Number(e.target.value))}
          />

          <div className="mt-4">
            <button className="nb-btn nb-btn--primary" onClick={save}>{saved ? '已保存' : '保存设置'}</button>
          </div>
        </div>

        <div className="ui-module">
          <h2 className="ui-module-title"><span className="ui-code">SYS</span>排除目录</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {settings.excludedDirs.map((d) => (
              <div key={d} className="cluster-row">
                <span className="nb-badge nb-badge--denim">跳过</span>
                <div style={{ fontSize: 14 }}>{d}</div>
              </div>
            ))}
          </div>
          <p className="nb-muted" style={{ fontSize: 13, marginTop: 12 }}>
            扫描时会自动跳过隐藏目录、node_modules、.git、缓存目录、构建产物与系统文件，避免噪音。
          </p>
        </div>
      </div>

      {/* 小红书账号连接（V1.2 账号隔离） */}
      <div className={`ui-module mt-4 setting-section${account?.verificationStatus === 'mismatch' ? ' ui-alert--error' : ''}`}>
        <h2 className="ui-module-title"><span className="ui-code">XHS</span>小红书账号连接</h2>
        <p className="nb-muted" style={{ fontSize: 13, marginTop: 4, marginBottom: 12 }}>
          工作台只会同步你在本机环境变量中配置的目标账号。以下信息由后端实时校验，避免把其他账号的数据误展示为当前账号。
        </p>

        {accountLoading && !account ? (
          <div className="nb-muted" style={{ fontSize: 14 }}>正在核对账号…</div>
        ) : account ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14 }}>
            {/* 验证状态徽标 */}
            <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
              <span className={`nb-badge ${account.verificationStatus === 'verified' ? 'nb-badge--olive' : account.verificationStatus === 'mismatch' ? 'nb-badge--red' : 'nb-badge--denim'}`}>
                {statusLabel(account.verificationStatus)}
              </span>
              <span className="nb-muted" style={{ fontSize: 13 }}>最后验证 {account.verifiedAt ? new Date(account.verifiedAt).toLocaleString() : '—'}</span>
            </div>

            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">预期账号</span>
              <div style={{ fontSize: 14 }}><strong>{account.expected.displayName}</strong></div>
            </div>
            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">公开主页ID</span>
              <div style={{ fontSize: 13, wordBreak: 'break-all' }}>{account.expected.publicUserId}</div>
            </div>
            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">OpenCLI 当前账号</span>
              <div style={{ fontSize: 14 }}>{account.loginDisplayName ?? '—'}</div>
            </div>
            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">粉丝</span>
              <div style={{ fontSize: 14 }}>{account.followers != null ? formatNumber(account.followers) : '—'}</div>
            </div>
            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">笔记数</span>
              <div style={{ fontSize: 14 }}>{account.notesCount ?? '—'}</div>
            </div>
            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">最后同步</span>
              <div style={{ fontSize: 14 }}>{account.lastSyncAt ? new Date(account.lastSyncAt).toLocaleString() : '尚未同步'}</div>
            </div>

            <div className="flex gap-2" style={{ marginTop: 6, flexWrap: 'wrap' }}>
              <button
                className="nb-btn nb-btn--primary"
                onClick={verifyAndSync}
                disabled={accountSync === 'loading' || verifyProgress.running}
              >
                {verifyProgress.running ? '验证并同步中…' : '验证并同步'}
              </button>
              <a className="nb-btn nb-btn--ghost" href={account.publicProfileUrl} target="_blank" rel="noreferrer">
                查看公开主页 ↗
              </a>
              <a className="nb-btn nb-btn--ghost" href={account.creatorCenterUrl} target="_blank" rel="noreferrer">
                打开创作中心 ↗
              </a>
            </div>

            {accountMsg && (
              <div className="nb-muted" style={{ fontSize: 13, color: account.verificationStatus === 'verified' ? 'inherit' : 'var(--red)' }}>
                {accountMsg}
              </div>
            )}
            <ActionProgress progress={verifyProgress.progress} onRetry={verifyAndSync} />
          </div>
        ) : (
          <div className="nb-muted" style={{ fontSize: 14 }}>{accountMsg || '无法获取账号信息。'}</div>
        )}
      </div>

      {/* 次幂数据与热点雷达（V1.3） */}
      <div className={`ui-module mt-4 setting-section${hotspot && !hotspot.cimi.hasCredentials ? ' ui-alert--warn' : ''}`}>
        <h2 className="ui-module-title"><span className="ui-code">HOT</span>热点雷达</h2>
        <p className="nb-muted" style={{ fontSize: 13, marginTop: 4, marginBottom: 12 }}>
          每天自动抓取「虎嗅APP」「36氪」微信公众号推文（标题、摘要、封面、正文、原文链接），用于热点雷达页。
          凭证请填写在 <code>backend/.env.local</code>（<code>CIMIDATA_APP_ID</code> / <code>CIMIDATA_APP_SECRET</code>），绝不出现在前端或日志。
        </p>

        <div className="flex gap-2" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <span className={`nb-badge ${hotspot?.cimi.hasCredentials ? 'nb-badge--olive' : 'nb-badge--denim'}`}>
            {hotspotLoading ? '检查中…' : hotspot?.cimi.hasCredentials ? '已配置' : '未配置'}
          </span>
          {hotspot?.cimi.hasCredentials && (
            <span className="nb-muted" style={{ fontSize: 13 }}>App ID：<code>{hotspot.cimi.appIdMasked}</code></span>
          )}
          <button className="nb-btn nb-btn--ghost" onClick={testHotspotConnection} disabled={hotspotLoading || hotspotTestProgress.running}>
            {hotspotTestProgress.running ? '检测中…' : '测试连接'}
          </button>
        </div>
        <ActionProgress progress={hotspotTestProgress.progress} onRetry={testHotspotConnection} />
        {hotspotMsg && <div className="nb-muted" style={{ fontSize: 13, marginBottom: 12 }}>{hotspotMsg}</div>}

        {/* 来源状态 */}
        {hotspot && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            {hotspot.sources.map((s) => (
              <div key={s.id} className="cluster-row">
                <span className={`nb-badge ${s.enabled ? 'nb-badge--olive' : 'nb-badge--red'}`}>{s.enabled ? '启用' : '停用'}</span>
                <div style={{ fontSize: 14 }}><strong>{s.displayName}</strong></div>
                <div className="nb-muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                  {s.cimiSynced ? '已成次幂' : '待同步'} · 上次 {s.lastFetchAt ? new Date(s.lastFetchAt).toLocaleString() : '—'}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 调度与开关 */}
        <div className="grid-2" style={{ gap: 14, marginBottom: 12 }}>
          <div>
            <label className="setting-label">自动抓取时间（HH:mm，逗号分隔）</label>
            <input className="nb-input" value={scheduleTimes} onChange={(e) => setScheduleTimes(e.target.value)} placeholder="13:30,20:30" />
          </div>
          <div>
            <label className="setting-label">自动调度开关</label>
            <div className="flex items-center gap-2" style={{ marginTop: 6 }}>
              <label className="flex items-center gap-2" style={{ fontSize: 14 }}>
                <input type="checkbox" checked={autoEnabled} onChange={(e) => setAutoEnabled(e.target.checked)} />
                启用定时抓取
              </label>
            </div>
          </div>
        </div>

        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          <button className="nb-btn nb-btn--primary" onClick={saveHotspot}>{hotspotSaved ? '已保存' : '保存热点设置'}</button>
          {hotspot && (
            <span className="nb-muted" style={{ fontSize: 13, alignSelf: 'center' }}>
              今日 {hotspot.todayCount} 篇 · 累计 {hotspot.totalCount} 篇 · 成本 {hotspot.estimatedCost.toFixed(3)} 元
            </span>
          )}
        </div>
        <p className="nb-muted" style={{ fontSize: 12, marginTop: 10 }}>
          说明：定时抓取由后台运行时承担（需用 <code>start.sh</code> 启动）。正式抓取会按次幂接口计费（当天发文 0.04/次、正文 0.01/次）。
        </p>
      </div>

      {/* 知识大脑连接（V1.4） */}
      <div className={`ui-module mt-4 setting-section${knowledge && !knowledge.online ? ' ui-alert--error' : ''}`}>
        <h2 className="ui-module-title"><span className="ui-code">KB</span>知识库</h2>
        <p className="nb-muted" style={{ fontSize: 13, marginTop: 4, marginBottom: 12 }}>
          知识大脑依赖外部独立的「L叔线下课知识库项目」（本地 Python 服务，默认 <code>127.0.0.1:8765</code>）。
          工作台通过白名单代理访问，不迁移、不重建、不修改外部项目；外部项目的 API Key 保存在其自身 <code>.env</code>，不会进入本工作台或前端。
        </p>

        <div className="flex gap-2" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <span className={`nb-badge ${knowledgeLoading ? 'nb-badge--denim' : knowledge?.online ? 'nb-badge--olive' : 'nb-badge--red'}`}>
            {knowledgeLoading ? '检查中…' : knowledge?.online ? '在线' : '离线/未配置'}
          </span>
          {knowledge?.online && (
            <span className={`nb-badge ${knowledge.modelsConfigured ? 'nb-badge--olive' : 'nb-badge--red'}`}>
              {knowledge.modelsConfigured ? '模型已配置' : '模型未配置'}
            </span>
          )}
          {knowledge?.baseUrl && (
            <span className="nb-muted" style={{ fontSize: 13 }}>服务地址：<code>{knowledge.baseUrl}</code></span>
          )}
          <button className="nb-btn nb-btn--ghost" onClick={testKnowledgeConnection} disabled={knowledgeLoading || knowledgeTestProgress.running}>
            {knowledgeTestProgress.running ? '检测中…' : '测试连接'}
          </button>
          {knowledge?.checkedAt && (
            <span className="nb-muted" style={{ fontSize: 13 }}>最近检测 {formatTime(knowledge.checkedAt)}</span>
          )}
        </div>
        {knowledgeMsg && <div className="nb-muted" style={{ fontSize: 13, marginBottom: 12 }}>{knowledgeMsg}</div>}
        <ActionProgress progress={knowledgeTestProgress.progress} onRetry={testKnowledgeConnection} />
        <ActionProgress progress={knowledgeRefreshProgress.progress} onRetry={refreshKnowledge} />

        {knowledge?.online ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14, fontSize: 14 }}>
            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">文档数</span>
              <div style={{ fontSize: 14 }}><strong>{knowledge.documents}</strong></div>
              <span className="nb-muted" style={{ fontSize: 12, marginLeft: 8 }}>个 Markdown 文档</span>
            </div>
            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">知识片段</span>
              <div style={{ fontSize: 14 }}><strong>{knowledge.chunks}</strong></div>
              <span className="nb-muted" style={{ fontSize: 12, marginLeft: 8 }}>个检索向量片段</span>
            </div>
            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">检索上下文</span>
              <div style={{ fontSize: 14 }}><strong>{knowledge.retrieval_context_chars?.toLocaleString() ?? '—'}</strong></div>
              <span className="nb-muted" style={{ fontSize: 12, marginLeft: 8 }}>字符</span>
            </div>
            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">LLM</span>
              <div style={{ fontSize: 14 }}><code>{knowledge.llm_model}</code></div>
            </div>
            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">Embedding</span>
              <div style={{ fontSize: 14 }}><code>{knowledge.embedding_model}</code></div>
            </div>
            <div className="cluster-row">
              <span className="nb-badge nb-badge--denim">Reranker</span>
              <div style={{ fontSize: 14 }}><code>{knowledge.reranker_model}</code></div>
            </div>
          </div>
        ) : (
          <div className="nb-muted" style={{ fontSize: 13, lineHeight: 1.8, marginBottom: 14 }}>
            知识库服务未在线。启用步骤：
            <div style={{ marginTop: 6 }}>1. 重新运行 <code>./start.sh</code>（会自动启动知识库服务），或手动启动：</div>
            <div style={{ marginTop: 4, marginLeft: 12 }}>
              <code>cd "$KNOWLEDGE_BASE_ROOT"</code>
            </div>
            <div style={{ marginTop: 4, marginLeft: 12 }}>
              <code>python3 app.py</code>
            </div>
            <div style={{ marginTop: 6 }}>2. 启动日志：<code>logs/knowledge-base.log</code>；3. 本卡片信息来自 <code>/api/knowledge/status</code>。</div>
          </div>
        )}

        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          {knowledge?.online ? (
            <a className="nb-btn nb-btn--ghost" href="http://127.0.0.1:8765" target="_blank" rel="noreferrer">
              打开原知识库 ↗
            </a>
          ) : (
            <span className="nb-btn nb-btn--ghost" style={{ opacity: 0.5, cursor: 'not-allowed' }}>打开原知识库 ↗</span>
          )}
          <button className="nb-btn nb-btn--ghost" onClick={refreshKnowledge} disabled={knowledgeLoading || knowledgeRefreshProgress.running}>
            {knowledgeRefreshProgress.running ? '刷新中…' : '刷新连接'}
          </button>
        </div>
      </div>

      <div className="ui-module mt-4 setting-section">
        <h2 className="ui-module-title"><span className="ui-code">TODO</span>待办连接器</h2>
        <p className="nb-muted" style={{ fontSize: 13, marginBottom: 12 }}>
          默认只读。飞书当前是 bot 身份，可见群为 0，用户 token 缺失。若要读取个人聊天，请本机运行：
          <code> lark-cli auth login --domain im,calendar,vc</code>
          然后在此配置群聊 allowlist，或打开「允许全部会话」。P2P 默认关闭。
        </p>
        <label className="todo-switch"><input type="checkbox" checked={settings.desktopEnabled !== false} onChange={(e) => api.updateSettings({ desktopEnabled: e.target.checked }).then(setSettings)} />桌面扫描</label>
        <label className="todo-switch"><input type="checkbox" checked={settings.thingsEnabled !== false} onChange={(e) => api.updateSettings({ thingsEnabled: e.target.checked }).then(setSettings)} />Things 只读</label>
        <label className="todo-switch"><input type="checkbox" checked={settings.feishuEnabled !== false} onChange={(e) => api.updateSettings({ feishuEnabled: e.target.checked }).then(setSettings)} />飞书只读</label>
        <label className="todo-switch"><input type="checkbox" checked={settings.calendarEnabled !== false} onChange={(e) => api.updateSettings({ calendarEnabled: e.target.checked }).then(setSettings)} />Apple Calendar 只读忙闲</label>
        <label className="todo-switch"><input type="checkbox" checked={Boolean(settings.autoScheduleEnabled)} onChange={(e) => api.updateSettings({ autoScheduleEnabled: e.target.checked }).then(setSettings)} />自动排程（写入「L叔工作台」）</label>
        <label className="todo-switch"><input type="checkbox" checked={Boolean(settings.autoCompleteEnabled)} onChange={(e) => api.updateSettings({ autoCompleteEnabled: e.target.checked }).then(setSettings)} />自动确认完成</label>
        <label className="todo-switch"><input type="checkbox" checked={Boolean(settings.feishuP2pEnabled)} onChange={(e) => api.updateSettings({ feishuP2pEnabled: e.target.checked }).then(setSettings)} />飞书 P2P（需 user identity）</label>
        <label className="todo-switch"><input type="checkbox" checked={Boolean(settings.feishuAllowAll)} onChange={(e) => api.updateSettings({ feishuAllowAll: e.target.checked }).then(setSettings)} />飞书允许全部可见会话（含群与已开的 P2P）</label>
        <label className="todo-switch"><input type="checkbox" checked={Boolean(settings.aiAnalysisEnabled)} onChange={async (e) => {
          const enable = e.target.checked;
          if (enable && !window.confirm('开启后，经过脱敏裁剪的飞书/桌面片段会发送给 DeepSeek。Things 与 Calendar 不会上传。确认开启？')) return;
          try {
            const next = await api.updateSettings({ aiAnalysisEnabled: enable, confirmAiUpload: enable });
            setSettings(next);
            setAiNotice(enable
              ? 'AI 分析已开启；请到待办页点击立即同步，或等待下一次自动同步。'
              : '');
          } catch (err) {
            window.alert((err as Error).message);
          }
        }} />AI 分析飞书/桌面（默认关）</label>
        {aiNotice && <p className="nb-muted" style={{ fontSize: 13, margin: '6px 0 10px' }}>{aiNotice}</p>}
        <label className="todo-switch"><input type="checkbox" checked={Boolean(settings.aiAutoSyncEnabled)} disabled={!settings.aiAnalysisEnabled} onChange={(e) => api.updateSettings({ aiAutoSyncEnabled: e.target.checked }).then(setSettings)} />定时自动 AI 同步（依赖上一开关）</label>
        <div className="flex gap-2" style={{ flexWrap: 'wrap', marginTop: 12 }}>
          <button className="nb-btn nb-btn--ghost" disabled={calendarProgress.running} onClick={() => {
            void calendarProgress.run(
              async () => {
                const r = await api.connectAppleCalendar();
                const refreshed = await loadCalendarStatus();
                if (!r.ok) {
                  const err = new Error(r.errorMessage || 'Apple Calendar 未同步：需要完整访问权限') as Error & { code?: string };
                  err.code = r.errorCode || undefined;
                  throw err;
                }
                const events = r.events ?? refreshed.cal?.itemsRead ?? 0;
                const permission = r.permission || refreshed.cal?.permission || '';
                setCalendarNote(calendarConnectSuccessCopy(permission, events));
                if (shouldHintCalendarPermissionDialog(permission)) {
                  setCalendarNote((prev) => `${prev}。若系统尚未授权，请在系统设置中开启完整访问。`);
                }
              },
              { label: '正在连接 Apple Calendar', successMessage: '日历已连接' }
            ).catch((err) => setCalendarNote((err as Error).message));
          }}>{calendarProgress.running ? '连接中…' : '连接 Apple Calendar'}</button>
          <button className="nb-btn nb-btn--ghost" disabled={aiCacheProgress.running} onClick={() => {
            void aiCacheProgress.run(
              () => api.clearAiCache().then(() => window.alert('已清空 AI 分析缓存与待复核派生数据，未删除待办/Things/日程')),
              { label: '正在清空 AI 缓存', successMessage: '缓存已清空' }
            ).catch((err) => window.alert((err as Error).message));
          }}>{aiCacheProgress.running ? '清理中…' : '清空 AI 分析缓存'}</button>
        </div>
        {calendarNote && <p className="nb-muted" style={{ fontSize: 13, margin: '8px 0 0' }}>{calendarNote}</p>}
        {calendarConnector && (
          <p className="nb-muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
            Apple Calendar：{calendarConnector.available ? '已连接' : (calendarConnector.statusLabel || '未连接')}
            {feishuCoverageNote ? ` · ${feishuCoverageNote}` : ''}
          </p>
        )}
        <ActionProgress progress={calendarProgress.progress} />
        <ActionProgress progress={aiCacheProgress.progress} />
      </div>

      <div className="ui-module mt-4 setting-section ui-alert--warn">
        <h2 className="ui-module-title"><span className="ui-code">PRIV</span>隐私说明</h2>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>{settings.privacyNotice}</p>
      </div>

      <div className="ui-module mt-4 setting-section">
        <h2 className="ui-module-title"><span className="ui-code">FIX</span>小红书数据修复指引</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 14 }}>
          <div><strong>1. 检查 OpenCLI</strong> — 确认命令行可用：<code>opencli xiaohongshu whoami -f json</code></div>
          <div><strong>2. 检查浏览器桥接</strong> — 确保 Chrome 扩展已连接、OpenCLI daemon 在运行。</div>
          <div><strong>3. 检查登录态</strong> — 运行 <code>opencli xiaohongshu whoami</code> 确认已登录；若未登录，用 <code>opencli xiaohongshu login</code> 登录。</div>
          <div><strong>4. 账号匹配</strong> — 工作台会核对 <code>XHS_ACCOUNT_KEY</code>。若 OpenCLI 当前登录的是其他账号，同步会被拒绝（<code>ACCOUNT_MISMATCH</code>），需先切换到正确账号。</div>
          <div className="nb-muted" style={{ fontSize: 13 }}>
            说明：正式模式同步失败不会自动展示「演示数据」。演示数据（demo）只能在显式开启 demo 模式时出现，且页面会显著标记「演示数据」。同步失败时，请先修复上述问题，工作台会对失效请求返回明确错误提示。
          </div>
        </div>
      </div>
    </div>
  );
}
