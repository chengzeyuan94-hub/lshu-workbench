import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type {
  KnowledgeStatus,
  KnowledgeDocument,
  KnowledgeChatSource,
} from '../types';
import ActionProgress from '../components/ActionProgress';
import { useActionProgress } from '../lib/actionProgress';

// ===== 工具 =====
function formatTime(t: string | null): string {
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return d.toLocaleString();
}

function formatChars(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return n.toLocaleString();
}

function formatSize(chars: number): string {
  // 粗略按 1 字符 ≈ 1 字节估算显示（仅展示用途）
  if (chars >= 1024 * 1024) return `${(chars / 1024 / 1024).toFixed(1)} MB`;
  if (chars >= 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${chars} B`;
}

/** 推荐问题（知识库高频提问） */
const RECOMMENDED_QUESTIONS = [
  'L叔线下课的核心方法论是什么？',
  '小红书涨粉的核心逻辑是什么？',
  '普通人如何找到适合自己的赛道？',
  '如何用 AI 辅助内容创作？',
];

// ===== 对话消息 =====
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: KnowledgeChatSource[];
  loading?: boolean;
}

type Tab = 'chat' | 'library';

export default function KnowledgePage() {
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  // 连接状态：'loading' | 'online' | 'offline'
  const [conn, setConn] = useState<'loading' | 'online' | 'offline'>('loading');
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [statusMsg, setStatusMsg] = useState('');

  // ===== 问知识库 =====
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [asking, setAsking] = useState(false);
  const askProgress = useActionProgress();
  const uploadProgress = useActionProgress();
  const chatBoxRef = useRef<HTMLDivElement>(null);

  // ===== 资料库 =====
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [docLoading, setDocLoading] = useState(false);
  const [docSearch, setDocSearch] = useState('');
  const [docFilter, setDocFilter] = useState<'all' | 'small' | 'large'>('all');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ===== 连接检测 =====
  const checkConnection = useCallback(async () => {
    setConn('loading');
    setStatusMsg('');
    try {
      const s = await api.getKnowledgeStatus();
      setStatus(s);
      setConn(s.online === false ? 'offline' : 'online');
    } catch (e) {
      setStatus(null);
      setConn('offline');
      setStatusMsg((e as Error).message);
    }
  }, []);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  // ===== 会话持久化（sessionStorage）=====
  useEffect(() => {
    const saved = sessionStorage.getItem('kb_chat_messages');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setMessages(parsed.filter((m) => m?.role && typeof m.content === 'string'));
      } catch {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem('kb_chat_messages', JSON.stringify(messages));
    } catch {
      /* ignore */
    }
  }, [messages]);

  // 自动滚动到底部
  useEffect(() => {
    if (chatBoxRef.current) {
      chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }
  }, [messages, asking]);

  // ===== 提问 =====
  const ask = useCallback(
    async (q?: string) => {
      const finalQ = (q ?? question).trim();
      if (!finalQ || asking) return;
      setQuestion('');
      setAsking(true);
      const history = messages
        .filter((m) => !m.loading && m.role)
        .slice(-6)
        .map((m) => ({ role: m.role, content: m.content }));
      // 立即插入用户问题
      setMessages((prev) => [...prev, { role: 'user', content: finalQ }]);
      try {
        await askProgress.run(async () => {
          const res = await api.chatKnowledge(finalQ, history);
          setMessages((prev) => [...prev, { role: 'assistant', content: res.answer, sources: res.sources }]);
        }, { label: '正在检索知识库并生成回答', successMessage: '回答已生成' });
      } catch (e) {
        const err = e as { message?: string };
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `提问失败：${err.message ?? '未知错误'}` },
        ]);
      } finally {
        setAsking(false);
      }
    },
    [question, messages, asking, askProgress.run]
  );

  const clearChat = useCallback(() => {
    setMessages([]);
    sessionStorage.removeItem('kb_chat_messages');
  }, []);

  // ===== 资料库 =====
  const loadDocuments = useCallback(async () => {
    setDocLoading(true);
    try {
      const r = await api.getKnowledgeDocuments();
      setDocuments(r.documents);
    } catch (e) {
      setDocLoading(false);
      setUploadMsg((e as Error).message);
      return;
    }
    setDocLoading(false);
  }, []);

  useEffect(() => {
    if (activeTab === 'library' || activeTab === 'chat') {
      // 进入任一 tab 都尝试加载文档（当前缓存 60s）
      loadDocuments();
    }
  }, [activeTab, loadDocuments]);

  const handleUpload = useCallback(
    async (file: File) => {
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.md')) {
        setUploadMsg('目前仅支持 .md Markdown 文件');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setUploadMsg('文件不能超过 10 MB');
        return;
      }
      setUploading(true);
      setUploadMsg('');
      try {
        await uploadProgress.run(async () => {
          const r = await api.uploadKnowledge(file);
          setUploadMsg(`已上传「${r.document.name}」，解析 ${r.document.chunks} 个知识片段。`);
          await loadDocuments();
        }, { label: '正在导入 Markdown', successMessage: '文档已导入' });
      } catch (e) {
        const err = e as { message?: string };
        setUploadMsg(`上传失败：${err.message ?? '未知错误'}`);
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [loadDocuments, uploadProgress.run]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setDeletingId(id);
      setUploadMsg('');
      try {
        const r = await api.deleteKnowledgeDoc(id);
        setUploadMsg(r.message);
        setDeleteConfirm(null);
        await loadDocuments();
      } catch (e) {
        const err = e as { message?: string };
        setUploadMsg(`删除失败：${err.message ?? '未知错误'}`);
      } finally {
        setDeletingId(null);
      }
    },
    [loadDocuments]
  );

  // 文档筛选
  const filteredDocs = useMemo(() => {
    let list = documents;
    if (docSearch.trim()) {
      const kw = docSearch.trim().toLowerCase();
      list = list.filter((d) => d.name.toLowerCase().includes(kw));
    }
    if (docFilter !== 'all') {
      const threshold = 10 * 1024;
      list = list.filter((d) => (docFilter === 'small' ? d.characters < threshold : d.characters >= threshold));
    }
    return list;
  }, [documents, docSearch, docFilter]);

  // 计数汇总
  const totalDocs = documents.length;
  const totalChars = documents.reduce((n, d) => n + d.characters, 0);
  const totalChunks = documents.reduce((n, d) => n + d.chunks, 0);

  return (
    <div className="ui-page">
      <div className="ui-page-head">
        <div>
          <div className="ui-page-kicker">K-05 · KNOWLEDGE</div>
          <h1>知识大脑</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className={`nb-badge ${conn === 'online' ? 'nb-badge--olive' : conn === 'offline' ? 'nb-badge--red' : 'nb-badge--denim'}`}>
            {conn === 'online' ? '在线' : conn === 'offline' ? '离线' : '检测中…'}
          </span>
          {status && (
            <button className="nb-btn nb-btn--ghost" style={{ fontSize: 13, padding: '6px 14px' }} onClick={checkConnection}>
              刷新状态
            </button>
          )}
        </div>
      </div>

      {/* 离线提示 */}
      {conn === 'offline' && (
        <div className="ui-alert ui-alert--error">
          <h3 style={{ fontSize: 16, marginBottom: 8 }}>知识库服务未连接</h3>
          <p style={{ fontSize: 14, lineHeight: 1.8 }}>
            知识大脑依赖独立的「L叔线下课知识库项目」（本地服务，端口 8765）。
            <br />
          </p>
          <div className="mt-2" style={{ fontSize: 14, lineHeight: 1.8 }}>
            <div><strong>启用方法：</strong>重新运行 <code>./start.sh</code>，脚本会自动启动知识库服务；或手动执行：</div>
            <div style={{ marginTop: 6 }}>
              <code>cd "$KNOWLEDGE_BASE_ROOT"</code>
            </div>
            <div style={{ marginTop: 6 }}>
              <code>python3 app.py</code>
            </div>
          </div>
          {statusMsg && (
            <div className="nb-muted" style={{ fontSize: 13, marginTop: 10, wordBreak: 'break-all' }}>
              当前错误：{statusMsg}
            </div>
          )}
          <button className="nb-btn nb-btn--denim" style={{ marginTop: 14 }} onClick={checkConnection}>
            重试连接
          </button>
        </div>
      )}

      {/* 页签 */}
      <div className="nb-tabs">
        <button className={`nb-tab ${activeTab === 'chat' ? 'nb-tab--active' : ''}`} onClick={() => setActiveTab('chat')}>
          问知识库
        </button>
        <button className={`nb-tab ${activeTab === 'library' ? 'nb-tab--active' : ''}`} onClick={() => setActiveTab('library')}>
          资料库
        </button>
      </div>

      {/* ===== 问知识库 ===== */}
      {activeTab === 'chat' && (
        <>
          {/* 在线状态摘要 */}
          {status && conn === 'online' && (
            <div className="ui-receipt">
              <div className="flex gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <span className={`nb-badge ${status.modelsConfigured ? 'nb-badge--olive' : 'nb-badge--red'}`}>
                  {status.modelsConfigured ? '模型已配置' : '仅可浏览，模型未配置'}
                </span>
                <span className="nb-muted" style={{ fontSize: 13 }}>
                  文档 {status.documents} · 片段 {status.chunks} · 上下文 {formatChars(status.retrieval_context_chars)} 字
                </span>
                <span className="nb-muted" style={{ fontSize: 13 }}>
                  · LLM {status.llm_model}
                </span>
              </div>
            </div>
          )}

          {/* 推荐问题 */}
          {messages.length === 0 && (
            <div className="nb-card mb-4">
              <h2 className="nb-section-title" style={{ fontSize: 18 }}>你可以这样问</h2>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                {RECOMMENDED_QUESTIONS.map((q) => (
                  <button key={q} className="nb-chip" onClick={() => ask(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 对话区 */}
          <div className="nb-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="kb-chat-head flex items-center justify-between" style={{ padding: '12px 18px', borderBottom: 'var(--border)' }}>
              <span style={{ fontWeight: 800, fontSize: 15 }}>与知识库对话</span>
              {messages.length > 0 && (
                <button className="nb-btn nb-btn--ghost" style={{ fontSize: 12, padding: '5px 12px' }} onClick={clearChat}>
                  清空会话
                </button>
              )}
            </div>
            <div className="kb-chat-body" ref={chatBoxRef}>
              {messages.length === 0 && !asking ? (
                <div className="empty-state" style={{ padding: '48px 20px' }}>
                  <div className="empty-face">?</div>
                  <p>输入下方问题，或点击上方推荐问题，答案将基于本地知识库生成。</p>
                </div>
              ) : (
                messages.map((m, i) => (
                  <div key={i} className={`kb-msg kb-msg--${m.role} ${m.loading ? 'kb-msg--loading' : ''}`}>
                    <div className="kb-msg-label">{m.role === 'user' ? '你' : '知识库'}</div>
                    <div className="kb-msg-bubble">{m.content}</div>
                    {m.sources && m.sources.length > 0 && (
                      <div className="kb-sources">
                        <div className="kb-sources-title">参考来源（{m.sources.length}）</div>
                        <div className="kb-sources-list">
                          {m.sources.map((s, j) => (
                            <div key={j} className="kb-source">
                              <span className="nb-badge nb-badge--denim" style={{ fontSize: 11 }}>
                                {(s.score * 100).toFixed(0)}
                              </span>
                              <div style={{ minWidth: 0 }}>
                                <div className="kb-source-name">{s.document_name}</div>
                                <div className="kb-source-heading">{s.heading}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
              {asking && (
                <div className="kb-msg kb-msg--assistant kb-msg--loading">
                  <div className="kb-msg-label">知识库</div>
                  <div className="kb-msg-bubble">正在检索知识库并生成回答…（可能需要数十秒）</div>
                </div>
              )}
            </div>
            <div style={{ padding: '0 18px' }}>
              <ActionProgress progress={askProgress.progress} />
            </div>
            <div className="kb-input-bar flex gap-2" style={{ padding: '12px 18px', borderTop: 'var(--border)' }}>
              <input
                className="nb-input"
                placeholder="输入你的问题…"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    ask();
                  }
                }}
                disabled={asking || conn !== 'online'}
              />
              <button className="nb-btn nb-btn--primary" style={{ flexShrink: 0 }} onClick={() => ask()} disabled={asking || conn !== 'online' || !question.trim()}>
                {asking ? '生成中…' : '提问'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ===== 资料库 ===== */}
      {activeTab === 'library' && (
        <>
          {/* 统计 */}
          <div className="grid-auto mb-4">
            {[
              { label: '文档', value: totalDocs },
              { label: '知识片段', value: totalChunks },
              { label: '总字符', value: formatChars(totalChars) },
            ].map((m) => (
              <div key={m.label} className="ui-metric">
                <div className="ui-metric-label">{m.label}</div>
                <div className="ui-data">{m.value}</div>
              </div>
            ))}
          </div>

          {/* 上传区 */}
          <div className="nb-card mb-4">
            <div className="flex items-center justify-between mb-2" style={{ flexWrap: 'wrap', gap: 12 }}>
              <h2 className="nb-section-title" style={{ fontSize: 18 }}>上传新文档</h2>
              <span className="nb-muted" style={{ fontSize: 13 }}>.md · 最大 10 MB</span>
            </div>
            <div className="flex gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(f);
                }}
              />
              <button className="nb-btn nb-btn--denim" onClick={() => fileInputRef.current?.click()} disabled={uploading || conn !== 'online'}>
                {uploading ? '上传中…' : '选择 .md 文件'}
              </button>
              <span className="nb-muted" style={{ fontSize: 13 }}>
                上传后自动切分知识片段并建立检索向量（可能耗时较长）。
              </span>
            </div>
            <ActionProgress progress={uploadProgress.progress} />
            {uploadMsg && (
              <div className="nb-muted" style={{ fontSize: 13, marginTop: 10 }}>
                {uploadMsg}
              </div>
            )}
          </div>

          {/* 搜索筛选） */}
          <div className="nb-card mb-4">
            <div className="flex gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                className="nb-input"
                style={{ maxWidth: 260 }}
                placeholder="搜索文件名…"
                value={docSearch}
                onChange={(e) => setDocSearch(e.target.value)}
              />
              <select className="nb-input" style={{ maxWidth: 150 }} value={docFilter} onChange={(e) => setDocFilter(e.target.value as 'all' | 'small' | 'large')}>
                <option value="all">全部大小</option>
                <option value="small">小文件（&lt;10KB）</option>
                <option value="large">大文件（≥10KB）</option>
              </select>
            </div>
          </div>

          {/* 文档列表 */}
          <div className="nb-card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="nb-section-title" style={{ fontSize: 22 }}>文档列表（{filteredDocs.length}）</h2>
            </div>
            {docLoading ? (
              <div className="empty-state"><p>加载文档中…</p></div>
            ) : filteredDocs.length === 0 ? (
              <div className="empty-state">
                <p>{docSearch || docFilter !== 'all' ? '没有匹配的文档。' : '暂无文档。点击上方「选择 .md 文件」上传第一个文档。'}</p>
              </div>
            ) : (
              <div className="note-table">
                {filteredDocs.map((d) => (
                  <div key={d.id} className="note-row" style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, alignItems: 'center', padding: '10px 12px' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
                      <div className="nb-muted" style={{ fontSize: 12, marginTop: 2 }}>
                        上传于 {formatTime(d.uploaded_at)} · {d.chunks} 片段 · {formatSize(d.characters)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <span className="nb-badge nb-badge--denim">片段 {d.chunks}</span>
                    </div>
                    <div>
                      {deleteConfirm === d.id ? (
                        <div className="flex gap-2">
                          <button className="nb-btn nb-btn--primary" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => handleDelete(d.id)} disabled={deletingId === d.id}>
                            {deletingId === d.id ? '删除中…' : '确认删除'}
                          </button>
                          <button className="nb-btn nb-btn--ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setDeleteConfirm(null)}>
                            取消
                          </button>
                        </div>
                      ) : (
                        <button className="nb-btn nb-btn--ghost" style={{ fontSize: 12, padding: '5px 10px', color: 'var(--red)' }} onClick={() => setDeleteConfirm(d.id)} disabled={conn !== 'online'}>
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="nb-muted" style={{ fontSize: 12, marginTop: 12 }}>
              说明：删除文档会同时移除其知识片段，且不可恢复，请谨慎操作。上传/删除后文档与状态缓存会即时刷新。
            </p>
          </div>
        </>
      )}
    </div>
  );
}
