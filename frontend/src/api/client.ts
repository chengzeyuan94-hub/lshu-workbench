import type {
  AppSettings,
  CreatorNoteDetail,
  CreatorProfile,
  CreatorMetric,
  NotePerformance,
  ScanReport,
  TodoItem,
  TodayTodosResponse,
  XhsPeriod,
  XhsPeriodView,
  XhsSnapshot,
  XhsAccountInfo,
  XhsAccountVerify,
  HotspotSource,
  HotspotArticleListItem,
  HotspotArticleDetail,
  HotspotListResult,
  HotspotStatus,
  HotspotFetchRun,
  KnowledgeStatus,
  KnowledgeDocument,
  KnowledgeChatResult,
  KnowledgeHotspotList,
  KnowledgeHotspotStatus,
  KnowledgeGenerateResult,
  KnowledgeMomentDraftList,
  KnowledgeMomentGenerationMode,
  KnowledgeUploadResult,
  TodayWeatherResponse,
  AiStatusResponse,
  ProductivitySyncRun,
  AgendaResponse,
  FinanceOverview,
  FinanceStatusResponse,
  FinanceSyncResponse,
} from '../types';
import { parseApiError, parseNetworkError } from './parseApiError';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const method = String(options?.method || 'GET').toUpperCase();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw parseNetworkError(method, path);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw parseApiError(res.status, body, method, path);
  }
  const text = await res.text().catch(() => '');
  if (!text.trim()) {
    if (res.status === 204) return undefined as T;
    throw parseApiError(res.status, '', method, path);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw parseApiError(res.status, text, method, path);
  }
}

export const api = {
  // 健康检查
  health: () => request<{ ok: boolean; time: string; buildId?: string; promptVersion?: string; schemaVersion?: string }>('/health'),

  // 小红书账号
  getAccount: () => request<XhsAccountInfo>('/xhs/account'),
  verifyAndSync: () => request<XhsAccountVerify>('/xhs/account/verify-sync', { method: 'POST' }),

  // 小红书同步
  syncXhs: () => request<XhsSnapshot>('/xhs/sync', { method: 'POST' }),
  getXhsSnapshot: (period?: XhsPeriod) =>
    request<XhsSnapshot | XhsPeriodView | null>(
      `/xhs/snapshot${period ? `?period=${period}` : ''}`
    ),
  // 单篇笔记详情
  getNoteDetail: (noteId: string) => request<CreatorNoteDetail>(`/xhs/notes/${noteId}/detail`),
  refreshNoteDetail: (noteId: string) =>
    request<CreatorNoteDetail>(`/xhs/notes/${noteId}/detail/refresh`, { method: 'POST' }),

  // 桌面扫描
  scanDesktop: () => request<ScanReport>('/scan/run', { method: 'POST' }),
  getScanReports: () => request<ScanReport[]>('/scan/reports'),

  // 待办
  getTodos: () => request<TodoItem[]>('/todos'),
  getTodayTodos: (limit?: number, signal?: AbortSignal) => {
    const q = limit != null && limit > 0 ? `?limit=${Math.floor(limit)}` : '';
    return request<TodayTodosResponse>(`/todos/today${q}`, { signal });
  },
  confirmTodo: (id: number) => request<TodoItem>(`/todos/${id}/confirm`, { method: 'POST' }),
  ignoreTodo: (id: number) => request<TodoItem>(`/todos/${id}/ignore`, { method: 'POST' }),
  editTodo: (id: number, patch: Partial<TodoItem>) =>
    request<TodoItem>(`/todos/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  getConnectorStatus: () => request<{ connectors: import('../types').ConnectorStatus[]; settings: import('../types').AppSettings }>('/productivity/connectors/status'),
  previewProductivitySync: () => request<{ itemsSeen: number; candidateCount: number; pendingAnalysis?: number; receipt?: string; connectorErrors: Array<{ connector: string; code?: string; message?: string }> }>('/productivity/sync/preview', { method: 'POST' }),
  commitProductivitySync: () => request<ProductivitySyncRun>('/productivity/sync/commit', { method: 'POST' }),
  getProductivitySyncRun: (id: number) => request<ProductivitySyncRun>(`/productivity/sync/runs/${id}`),
  getTodoEvidence: (id: number) => request<{ todo: TodoItem; evidence: import('../types').TodoEvidence[]; actions: Record<string, boolean> }>(`/todos/${id}/evidence`),
  previewTodoPlan: (id: number) => request<{ plan: import('../types').PlanResult; write: boolean; busyStatus?: string }>(`/todos/${id}/plan/preview`, { method: 'POST', body: '{}' }),
  previewDayPlan: () => request<{ plan: import('../types').PlanResult; write: boolean; busyStatus?: string }>('/todos/plan-day/preview', { method: 'POST', body: '{}' }),
  completeTodo: (id: number) => request<TodoItem>(`/todos/${id}/complete`, { method: 'POST' }),
  reopenTodo: (id: number) => request<TodoItem>(`/todos/${id}/reopen`, { method: 'POST' }),
  getAgenda: () => request<AgendaResponse>('/productivity/agenda'),
  getAiStatus: () => request<AiStatusResponse>('/productivity/ai/status'),
  getAiSuggestions: () => request<{ suggestions: Array<{ id: number; title: string; confidence: number; reasonCode: string; reason_code?: string; owner: string; intent: string }>; count?: number }>('/productivity/ai/suggestions'),
  getTodayOverview: (date?: string, timezone?: string) => {
    const q = new URLSearchParams();
    if (date) q.set('date', date);
    if (timezone) q.set('timezone', timezone);
    const suffix = q.toString() ? `?${q.toString()}` : '';
    return request<import('../types').TodayOverviewResponse>(`/productivity/today-overview${suffix}`);
  },
  getTodayDayPlan: (date?: string, timezone?: string) => {
    const q = new URLSearchParams();
    if (date) q.set('date', date);
    if (timezone) q.set('timezone', timezone);
    const suffix = q.toString() ? `?${q.toString()}` : '';
    return request<{ plan: import('../types').DayPlan | null; write: false }>(`/productivity/day-plans/today${suffix}`);
  },
  createTodayDayPlan: (body?: { date?: string; timezone?: string; syncIfStale?: boolean }) =>
    request<{ plan: import('../types').DayPlan; write: false; commitPreview: { blockCount: number; date: string; range: { startAt: string | null; endAt: string | null }; targetCalendar: string; write: false; willNotModify: string[] } }>(
      '/productivity/day-plans',
      { method: 'POST', body: JSON.stringify(body || {}) }
    ),
  commitTodayDayPlan: () =>
    request<unknown>('/productivity/day-plans/today/commit', { method: 'POST', body: '{}' }),
  clearAiCache: () => request<{ ok: boolean }>('/productivity/ai/cache/clear', { method: 'POST' }),
  connectAppleCalendar: () => request<{ permission: string; events: number; ok: boolean; busyStatus?: string; errorCode?: string | null; errorMessage?: string | null; helperVersion?: string; helperBuildId?: string | null; connectCopy?: string | null }>('/productivity/calendar/connect', { method: 'POST' }),
  previewLegacyCleanup: () => request<{ archiveCount: number; keepCount: number; write: false }>('/productivity/legacy-ai-cleanup/preview', { method: 'POST' }),

  // 设置
  getSettings: () => request<AppSettings>('/settings'),
  postTodayWeather: (body: { latitude: number; longitude: number; timezone: string }) =>
    request<TodayWeatherResponse>('/weather/today', { method: 'POST', body: JSON.stringify(body) }),
  updateSettings: (patch: Partial<AppSettings> & { confirmAiUpload?: boolean; confirmAiPlanningUpload?: boolean }) =>
    request<AppSettings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  // 财务分析（MoneyCats 本地只读备份）
  getFinanceOverview: () => request<FinanceOverview>('/finance/overview'),
  getFinanceStatus: () => request<FinanceStatusResponse>('/finance/status'),
  syncFinance: () => request<FinanceSyncResponse>('/finance/sync', { method: 'POST', body: '{}' }),

  // 热点雷达（V1.3 次幂数据）
  getHotspotStatus: () => request<HotspotStatus>('/hotspots/status'),
  getHotspotSources: () => request<HotspotSource[]>('/hotspots/sources'),
  syncHotspot: () => request<{ ok: boolean; total: number; sources: Array<{ source: string; status: string; article_found: number; inserted: number; duplicate: number; body_fetched: number; error_message?: string }> }>(
    '/hotspots/sync',
    { method: 'POST', body: JSON.stringify({ triggeredBy: 'manual' }) }
  ),
  getHotspots: (params?: { page?: number; pageSize?: number; sourceKey?: string; dateFrom?: string; dateTo?: string; keyword?: string; readStatus?: string }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.pageSize) q.set('pageSize', String(params.pageSize));
    if (params?.sourceKey) q.set('sourceKey', params.sourceKey);
    if (params?.dateFrom) q.set('dateFrom', params.dateFrom);
    if (params?.dateTo) q.set('dateTo', params.dateTo);
    if (params?.keyword) q.set('keyword', params.keyword);
    if (params?.readStatus) q.set('readStatus', params.readStatus);
    const qs = q.toString();
    return request<HotspotListResult>(`/hotspots${qs ? `?${qs}` : ''}`);
  },
  getHotspotArticle: (id: number) => request<HotspotArticleDetail>(`/hotspots/${id}`),
  updateHotspotArticle: (id: number, patch: { read_status?: string; todo_status?: string }) =>
    request<HotspotArticleListItem>(`/hotspots/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  addHotspotToTodo: (id: number) =>
    request<{ ok: boolean }>(`/hotspots/${id}/add-to-todo`, { method: 'POST' }),
  getHotspotRuns: () => request<HotspotFetchRun[]>('/hotspots/runs'),

  // 知识大脑（V1.4：本地知识库服务）
  getKnowledgeStatus: () => request<KnowledgeStatus>('/knowledge/status'),
  getKnowledgeDocuments: () => request<{ documents: KnowledgeDocument[] }>('/knowledge/documents'),
  chatKnowledge: (question: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    request<KnowledgeChatResult>('/knowledge/chat', { method: 'POST', body: JSON.stringify({ question, history }) }),
  uploadKnowledge: async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    // FormData 需由浏览器自动生成 Content-Type（含 boundary），不能手动设 application/json
    return request<KnowledgeUploadResult>('/knowledge/upload', { method: 'POST', body: form, headers: {} });
  },
  deleteKnowledgeDoc: (id: string) =>
    request<{ message: string }>(`/knowledge/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getKnowledgeHotspotStatus: () => request<KnowledgeHotspotStatus>('/knowledge/hotspots/status'),
  getKnowledgeHotspots: () => request<KnowledgeHotspotList>('/knowledge/hotspots/articles'),
  refreshKnowledgeHotspots: () =>
    request<KnowledgeHotspotList & { message: string }>('/knowledge/hotspots/refresh', { method: 'POST' }),
  generateKnowledgeHotspot: (
    articleId: string,
    options?: { generationMode?: KnowledgeMomentGenerationMode; requestId?: string },
  ) =>
    request<KnowledgeGenerateResult>('/knowledge/hotspots/generate', {
      method: 'POST',
      body: JSON.stringify({
        article_id: articleId,
        generation_mode: options?.generationMode,
        request_id: options?.requestId,
      }),
    }),
  getKnowledgeHotspotDrafts: (params?: { page?: number; pageSize?: number; keyword?: string }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.pageSize) q.set('pageSize', String(params.pageSize));
    if (params?.keyword) q.set('keyword', params.keyword);
    const suffix = q.toString() ? `?${q.toString()}` : '';
    return request<KnowledgeMomentDraftList>(`/knowledge/hotspots/drafts${suffix}`);
  },
};

export type { CreatorNoteDetail, CreatorProfile, CreatorMetric, NotePerformance, XhsSnapshot, XhsPeriodView, XhsAccountInfo, XhsAccountVerify };
