// 前端共享类型定义（与后端返回结构对应）

export interface CreatorProfile {
  name: string;
  followers: number;
  following: number;
  likesCollects: number;
  creatorLevel: number;
  levelProgress: string;
  bio: string;
  raw?: Record<string, unknown>;
}

export interface CreatorMetric {
  key: string;
  label: string;
  total: number;
  trend: number[]; // 每日趋势
  unit?: string;
  /** OpenCLI 原始字段名（保留用于排查字段变更） */
  rawName?: string;
  /** 原始 total 值（未格式化） */
  rawTotal?: number;
}

export interface NotePerformance {
  id: string;
  rank: number;
  title: string;
  date: string;
  views: number;
  likes: number;
  collects: number;
  comments: number;
  url?: string;
  collectRate?: number; // 收藏率
  lowPerformance?: boolean; // 是否低表现
}

export type XhsPeriod = 'seven' | 'thirty';

export interface PeriodMetrics {
  period: XhsPeriod;
  metrics: CreatorMetric[];
}

export interface XhsSnapshot {
  id: number;
  syncedAt: string;
  profile: CreatorProfile | null;
  notes: NotePerformance[];
  periods: Record<XhsPeriod, PeriodMetrics>;
  source: 'live' | 'demo' | 'stale' | 'error';
  message?: string;
  /** 兼容旧快照：仅当旧数据存在单组 metrics 时提供（视为 seven） */
  metrics?: CreatorMetric[];
}

/** 按周期查询返回的轻量快照（API period 返回） */
export interface XhsPeriodView {
  syncedAt: string;
  source: 'live' | 'demo' | 'stale' | 'error';
  period: XhsPeriod;
  profile: CreatorProfile | null;
  notes: NotePerformance[];
  metrics: CreatorMetric[];
  message?: string;
}

export type TodoStatus = 'pending' | 'confirmed' | 'ignored';
export type TodoPriority = 'high' | 'medium' | 'low';
export type TodoLifecycle =
  | 'candidate'
  | 'confirmed'
  | 'planned'
  | 'in_progress'
  | 'suspected_done'
  | 'completed'
  | 'canceled'
  | 'ignored';
export type TodoSourceType = 'desktop' | 'things' | 'feishu_message' | 'feishu_calendar' | 'manual' | 'hotspot';

export interface TodayTodosResponse {
  items: TodoItem[];
  total: number;
  asOf: string;
  revision: string;
  timeZone?: string;
}

export interface TodoItem {
  id: number;
  title: string;
  sourcePath: string;
  cluster: string;
  priority: TodoPriority;
  reason: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
  sourceType?: TodoSourceType;
  sourceExternalId?: string;
  sourceFingerprint?: string;
  lifecycleStatus?: TodoLifecycle;
  dueAt?: string | null;
  estimatedMinutes?: number | null;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  calendarEventId?: string | null;
  calendarSyncStatus?: string | null;
  completionConfidence?: number | null;
  completedAt?: string | null;
  completionSource?: string | null;
  lastSeenAt?: string | null;
  evidenceCount?: number;
  originMode?: 'structured' | 'ai' | 'manual' | 'legacy' | string;
  sourceReadonly?: boolean;
  inferenceConfidence?: number | null;
  visibility?: 'visible' | 'archived' | 'hidden_local' | string;
  sourceStatus?: string;
}

export interface ConnectorStatus {
  id: 'desktop' | 'things' | 'feishu' | 'calendar';
  label: string;
  enabled: boolean;
  available: boolean;
  identity?: string;
  scope?: string;
  lastSyncAt?: string | null;
  lastError?: string | null;
  itemsRead?: number;
  roundCount?: number;
  lastSuccessCount?: number;
  lastRoundOk?: boolean;
  usingStaleSnapshot?: boolean;
  hasCurrentUserId?: boolean;
  lastSuccessAt?: string | null;
  hint?: string;
  permission?: string;
  errorCode?: string | null;
  busyStatus?: string | null;
  helperVersion?: string | null;
  helperBuildId?: string | null;
  needsReconnect?: boolean;
  statusLabel?: string;
  windowStatus?: string | null;
}

export interface ProductivitySyncRun {
  runId: number;
  status: string;
  startedAt?: string;
  finishedAt?: string | null;
  created?: number;
  updated?: number;
  itemsSeen?: number;
  candidateCount?: number;
  connectorErrors?: Array<{ connector: string; code?: string; message?: string }>;
  ai?: Record<string, unknown>;
  appleCount?: number;
  receipt?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  write?: boolean;
}

export interface AgendaCalendarState {
  available: boolean;
  permission?: string;
  windowStatus?: string | null;
  errorCode?: string | null;
  busyStatus?: string | null;
  helperVersion?: string | null;
  helperBuildId?: string | null;
  needsReconnect?: boolean;
  itemsRead?: number;
  statusLabel?: string;
  hint?: string;
}

export interface AgendaResponse {
  events: Array<{ title: string; startAt: string; endAt: string; readonly: boolean; ownedByWorkbench: boolean; tentative?: boolean; provider: string }>;
  timezone: string;
  from?: string;
  to?: string;
  busyStatus?: string;
  coverageError?: string | null;
  calendar?: AgendaCalendarState;
}

export interface TodoEvidence {
  id: number;
  todo_id: number;
  source_type: string;
  evidence_type: string;
  summary: string;
  occurred_at: string;
}

export interface PlanBlock {
  todoId?: number;
  title: string;
  startAt: string;
  endAt: string;
  part?: string;
  minutes: number;
}

export interface PlanResult {
  blocks: PlanBlock[];
  unscheduled: Array<{ title: string; reason: string; suggestion: string }>;
}

export type TodayOverviewKind = 'task' | 'fixed_event' | 'needs_review' | 'activity_summary' | 'completed';
export type TodayOverviewSource = 'things' | 'feishu' | 'apple_calendar' | 'desktop' | 'workbench';

export interface TodayOverviewItem {
  stableKey: string;
  sourceType: TodayOverviewSource;
  kind: TodayOverviewKind;
  title: string;
  startAt?: string;
  endAt?: string;
  dueAt?: string;
  estimatedMinutes?: number;
  readonly: boolean;
  fixed: boolean;
  schedulable: boolean;
  confidence?: number;
  evidenceCount: number;
  state: string;
  todoId?: number;
  occurredAt?: string;
}

export interface TodayOverviewResponse {
  date: string;
  timezone: string;
  from: string;
  to: string;
  revision: string;
  items: TodayOverviewItem[];
  counts: {
    tasks: number;
    fixedEvents: number;
    needsReview: number;
    summaries: number;
    completed: number;
  };
}

export interface DayPlanBlock {
  stableKey: string;
  todoId?: number | null;
  title: string;
  startAt?: string | null;
  endAt?: string | null;
  sourceType: string;
  kind: string;
  fixed: boolean;
  schedulable: boolean;
  minutes: number;
  unscheduled: boolean;
  reason?: string | null;
}

export interface AiDayPlanSelection {
  stableKey: string;
  rank: number;
  estimatedMinutes: number;
  preferredWindow: 'morning' | 'afternoon' | 'any';
  reason: string;
}

export interface AiDayPlannerResult {
  schemaVersion: string;
  promptVersion: string;
  maxFocusTasks: number;
  candidateCount: number;
  selectedCount: number;
  deferredCount: number;
  profileSummary: string;
  planSummary: string;
  dailyMessage: string;
  dailyMessageEn: string;
  selections: AiDayPlanSelection[];
  usage: { attempts: number; promptTokens: number; completionTokens: number };
}

export interface DayPlan {
  id: number;
  date: string;
  timezone: string;
  status: string;
  overviewRevision: string;
  busyRevision: string;
  warning: string | null;
  unverified: boolean;
  strategy: 'ai' | 'manual';
  planner: AiDayPlannerResult | null;
  write: false;
  targetCalendar: string;
  blocks: DayPlanBlock[];
  unscheduled: Array<{ title: string; reason: string; suggestion: string; stableKey?: string }>;
  copy: { draft: string; commitPreview: string };
}

export interface ScanFile {
  path: string;
  name: string;
  type: string;
  size: number;
  modifiedAt: string;
}

export interface ScanReport {
  id: number;
  scannedAt: string;
  rootDir: string;
  fileCount: number;
  skippedCount: number;
  clusters: ClusterSummary[];
  files: ScanFile[];
}

export interface ClusterSummary {
  name: string;
  fileCount: number;
  reason: string;
}

export interface AppSettings {
  scanRoot: string;
  excludedDirs: string[];
  refreshMinutes: number;
  privacyNotice: string;
  hotspotScheduleTimes: string[];
  hotspotAutoEnabled: boolean;
  autoScheduleEnabled?: boolean;
  autoCompleteEnabled?: boolean;
  thingsEnabled?: boolean;
  feishuEnabled?: boolean;
  desktopEnabled?: boolean;
  calendarEnabled?: boolean;
  feishuChatAllowlist?: string[];
  feishuP2pEnabled?: boolean;
  feishuAllowAll?: boolean;
  aiAnalysisEnabled?: boolean;
  aiPlanningConsent?: boolean;
  aiAutoSyncEnabled?: boolean;
  timezone?: string;
}

export type WeatherStatus = 'live' | 'cache' | 'stale' | 'unavailable';
export type WeatherUiPhase =
  | 'need_permission'
  | 'locating'
  | 'fetching'
  | 'live'
  | 'cache'
  | 'stale'
  | 'geo_denied'
  | 'geo_timeout'
  | 'unsupported'
  | 'unavailable';

export interface TodayWeatherResponse {
  status: WeatherStatus;
  locationLabel: string;
  timezone: string;
  localDate: string;
  fetchedAt: string | null;
  current: {
    temperatureC: number;
    apparentTemperatureC: number | null;
    conditionCode: string;
    conditionLabel: string;
    windKph: number | null;
  } | null;
  today: {
    minC: number;
    maxC: number;
    precipitationProbabilityPct: number | null;
  } | null;
  errorCode?:
    | 'WEATHER_DISABLED'
    | 'WEATHER_TIMEOUT'
    | 'WEATHER_UPSTREAM_UNAVAILABLE'
    | 'WEATHER_RESPONSE_INVALID';
}

export interface FinancePeriodSummary {
  from: string;
  to: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  refundIncomeMinor: number;
  netSpendingMinor: number;
  incomeCount: number;
  expenseCount: number;
  transactionCount: number;
}

export interface FinanceDailyPoint {
  date: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

export interface FinanceExpenseCategory {
  category: string;
  expenseMinor: number;
  transactionCount: number;
}

export interface FinanceRuntimeStatus {
  status: string;
  lastRunAt: string | null;
  nextScheduledAt: string | null;
  isStale: boolean;
  errorCode?: string | null;
}

export interface FinanceOverview {
  schemaVersion: string;
  generatedAt: string;
  asOf: string;
  timezone: string;
  currency: 'CNY' | string;
  source: {
    label: string;
    fileName?: string;
    sizeBytes?: number;
    modifiedAt?: string;
    firstTransactionDate?: string | null;
    latestTransactionDate?: string | null;
    latestTransactionAt?: string | null;
    totalRows: number;
    includedRows: number;
  };
  periods: {
    week: FinancePeriodSummary;
    month: FinancePeriodSummary;
    year: FinancePeriodSummary;
  };
  currentMonthDaily: FinanceDailyPoint[];
  currentMonthExpenseTop: FinanceExpenseCategory[];
  quality?: Record<string, unknown>;
  runtimeStatus: FinanceRuntimeStatus;
}

export interface FinanceStatusResponse {
  status: string;
  syncing: boolean;
  lastRunAt: string | null;
  nextScheduledAt: string | null;
  isStale: boolean;
  errorCode?: string | null;
  lastRun?: Record<string, unknown> | null;
  currentData?: Record<string, unknown> | null;
}

export interface FinanceSyncResponse {
  run: Record<string, unknown>;
  overview: FinanceOverview;
}

export interface AiRunStatus {
  calls: number;
  retries: number;
  inputUnits: number;
  actionable: number;
  review: number;
  rejected: number;
  deferred: number;
  cacheHits: number;
  invalidCacheEntries?: number;
  promptTokens: number;
  completionTokens: number;
  errorCode: string | null;
  startedAt: string | null;
  status: string | null;
  httpAttempts?: number;
  apiSuccess?: number;
  jsonParseSuccess?: number;
  schemaSuccess?: number;
  schemaFailedBatches?: number;
  repairAttempts?: number;
  deferredByOverflow?: number;
  deferredBySchema?: number;
  schemaErrorCategories?: string[];
  promptVersion?: string | null;
  schemaVersion?: string | null;
  feishuInputCount?: number;
  desktopInputCount?: number;
  deferredReasons?: { overflow: number; schema: number };
}

export interface AiStatusResponse extends AiRunStatus {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  model: string;
  lastRun: AiRunStatus | null;
  runtimeBuildId: string;
  runtimePromptVersion: string;
  runtimeSchemaVersion: string;
  runtimeHubVersion: string;
  lastRunMatchesRuntime: boolean | null;
}

export type SyncState = 'idle' | 'loading' | 'success' | 'error';

// ===== 单篇笔记详情 =====
export interface NoteDetailBasic {
  impressions?: number;
  views?: number;
  coverClickRate?: number; // 百分比数值
  avgViewTimeSeconds?: number;
  newFollowers?: number;
}

export interface NoteDetailEngagement {
  likes?: number;
  collects?: number;
  comments?: number;
  shares?: number;
}

export interface NoteDetailRow {
  section: string;
  metric: string;
  value: string;
  extra: string;
}

export interface NoteTrafficSource {
  name: string;
  percent: number;
  impressions?: number;
  views?: number;
  engagements?: number;
}

export interface NoteAudienceSlice {
  name: string;
  percent: number;
}

export interface NoteAudience {
  gender: NoteAudienceSlice[];
  ages: NoteAudienceSlice[];
  cities: NoteAudienceSlice[];
  interests: NoteAudienceSlice[];
}

export interface CreatorNoteDetail {
  noteId: string;
  fetchedAt: string;
  source: 'live' | 'stale' | 'error';
  message?: string;
  cache?: 'hit' | 'stale';
  rawRows: NoteDetailRow[];
  basic: NoteDetailBasic;
  engagement: NoteDetailEngagement;
  dailyTrends: Record<string, Array<{ date: string; value: number }>>;
  hourlyTrends: Record<string, Array<{ dateTime: string; value: number }>>;
  trafficSources: NoteTrafficSource[];
  audience: NoteAudience;
  title?: string;
  publishedAt?: string;
}

// ===== 账号信息（V1.2 账号切换与隔离）=====
export type XhsVerificationStatus = 'verified' | 'mismatch' | 'unconnected' | 'unknown';

/** 当前绑定账号信息（由 /xhs/account 返回） */
export interface XhsAccountInfo {
  accountKey: string;
  displayName: string;
  publicProfileUrl: string;
  creatorCenterUrl: string;
  /** 预期账号（配置在环境变量/常量） */
  expected: {
    displayName: string;
    publicUserId: string;
    publicProfileUrl: string;
    creatorCenterUrl: string;
  };
  /** OpenCLI 当前登录态：'verified' | 'mismatch' | 'unconnected' | 'unknown' */
  verificationStatus: XhsVerificationStatus;
  verifiedAt?: string | null;
  lastSyncAt?: string | null;
  /** 当前实时检测到的登录账号名（可能与预期不符） */
  loginDisplayName?: string | null;
  followers?: number | null;
  notesCount?: number;
  message?: string;
}

export interface XhsAccountVerify {
  ok: boolean;
  verificationStatus: XhsVerificationStatus;
  accountKey: string;
  displayName: string;
  followers?: number | null;
  notesCount?: number;
  verifiedAt: string;
  message?: string;
}

// ===== V1.3 热点雷达（次幂数据）=====
export interface HotspotSource {
  id: number;
  sourceKey: string;
  displayName: string;
  nickname: string;
  accountBiz: string;
  accountWxid: string;
  avatarUrl: string | null;
  signature: string | null;
  fans: number | null;
  enabled: number;
  lastFetchAt: string | null;
  lastArticleCount: number;
  cimiSynced: boolean;
}

export interface HotspotArticleListItem {
  id: number;
  sourceId: number;
  sourceKey: string;
  sourceName: string;
  title: string;
  url: string;
  digest: string | null;
  author: string | null;
  publishTime: string | null;
  fetchedAt: string;
  bodyReady: boolean;
  bodyTooShort: boolean;
  bodyPending: boolean;
  bodyError?: string | null;
  readStatus: string;
  todoStatus: string;
}

export interface HotspotArticleDetail extends HotspotArticleListItem {
  bodyText: string | null;
  bodyHash: string | null;
  createdAt: string;
}

export interface HotspotListResult {
  items: HotspotArticleListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface HotspotStatus {
  todayCount: number;
  totalCount: number;
  unreadCount: number;
  pendingBodyCount: number;
  estimatedCost: number;
  lastFetchAt: string | null;
  sources: HotspotSource[];
  callStats: { token: number; account_info: number; current: number; body: number; long2short: number; estimatedCost: number };
  cimi: { hasCredentials: boolean; appIdMasked: string; baseUrl: string };
  syncing: boolean;
  runtime: { backendRuntime: boolean };
}

export interface HotspotFetchRun {
  id: number;
  source_id: number | null;
  triggered_by: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  article_found: number;
  inserted: number;
  updated: number;
  duplicate: number;
  body_fetched: number;
  error_message: string | null;
}

// ===== 知识大脑（V1.4：本地知识库服务）=====

/** 知识库在线状态（后端 /api/knowledge/status 返回） */
export interface KnowledgeStatus {
  documents: number;
  chunks: number;
  configured: boolean;
  llm_model: string;
  embedding_model: string;
  reranker_model: string;
  retrieval_context_chars: number;
  /** 后端附加：服务地址 */
  baseUrl?: string;
  /** 后端附加：最近检测时间 */
  checkedAt?: string;
  /** V1.5：服务地址是否已配置（工作台侧） */
  serviceConfigured?: boolean;
  /** V1.5：上游模型密钥是否配置 */
  modelsConfigured?: boolean;
  /** V1.5：本次健康检查是否在线 */
  online?: boolean;
  /** V1.5：是否来自缓存 */
  cached?: boolean;
}

/** 知识库文档（后端已裁剪内部路径 source_path） */
export interface KnowledgeDocument {
  id: string;
  name: string;
  uploaded_at: string;
  characters: number;
  chunks: number;
}

/** 知识库问答来源片段 */
export interface KnowledgeChatSource {
  document_name: string;
  heading: string;
  score: number;
  excerpt: string;
}

/** 知识库问答结果 */
export interface KnowledgeChatResult {
  answer: string;
  sources: KnowledgeChatSource[];
  retrieved_characters: number;
}

/** 知识库热点文章（public_hotspot，已剔除 content 只留 content_length） */
export interface KnowledgeHotspotArticle {
  article_id: string;
  title: string;
  url: string;
  published_at_ms: number | null;
  author: string;
  summary: string;
  content_length: number;
  fact: string;
  angle: string;
  audience: string;
  format: string;
  action: string;
  evidence_gap: string;
  risk: string;
  scores: Record<string, number>;
  risk_deduction: number;
  score: number;
  decision: string;
}

/** 知识库热点文章列表 */
export interface KnowledgeHotspotList {
  fetched_at: string | null;
  articles: KnowledgeHotspotArticle[];
}

/** 知识库热点状态 */
export interface KnowledgeHotspotStatus {
  fetched_at: string | null;
  articles: number;
  top_five: KnowledgeHotspotArticle[];
}

/** 知识库生成朋友圈草稿结果 */
export interface KnowledgeGenerateResult {
  draft: string;
}

export type KnowledgeMomentGenerationMode = 'single' | 'batch' | 'retry';

/** 已生成并持久化的朋友圈正文；只包含公开草稿，不包含模型推理。 */
export interface KnowledgeMomentDraft {
  id: number;
  article_id: string;
  source_title: string;
  source_url: string;
  source_author: string;
  source_published_at_ms: number | null;
  draft: string;
  generation_mode: KnowledgeMomentGenerationMode;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeMomentDraftList {
  items: KnowledgeMomentDraft[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 知识库上传结果 */
export interface KnowledgeUploadResult {
  document: KnowledgeDocument;
  message: string;
}
