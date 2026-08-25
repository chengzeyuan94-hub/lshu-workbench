export type SourceType =
  | 'desktop'
  | 'things'
  | 'feishu_message'
  | 'feishu_calendar'
  | 'manual'
  | 'hotspot';

export type StandardizedStatus = 'open' | 'completed' | 'canceled' | 'changed' | 'disappeared';

export interface StandardizedItem {
  sourceType: SourceType;
  sourceExternalId: string;
  sourceFingerprint: string;
  title: string;
  notes?: string;
  project?: string;
  tags?: string[];
  status: StandardizedStatus;
  dueAt?: string | null;
  createdAt?: string | null;
  modifiedAt?: string | null;
  completedAt?: string | null;
  summary?: string;
  payload: Record<string, unknown>;
}

export interface ConnectorRunResult {
  connector: 'things' | 'feishu' | 'desktop' | 'calendar';
  ok: boolean;
  items: StandardizedItem[];
  itemsSeen: number;
  errorCode?: string;
  errorMessage?: string;
  identity?: string;
  extra?: Record<string, unknown>;
}

export type TodoPriority = 'high' | 'medium' | 'low';

export interface TodoCandidate {
  title: string;
  sourceType: SourceType;
  sourceExternalId: string;
  sourceFingerprint: string;
  reason: string;
  evidenceSummaries: string[];
  suggestedPriority: TodoPriority;
  suggestedDueAt?: string | null;
  estimatedMinutes: number;
  confidence: number;
  project?: string;
  cluster?: string;
  sourcePath?: string;
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
  lastRoundPartial?: boolean;
  usingStaleSnapshot?: boolean;
  hasCurrentUserId?: boolean;
  chatsRead?: number;
  chatsFailed?: number;
  truncatedChats?: number;
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

export const WORKBENCH_CALENDAR_NAME = 'L叔工作台';
export const PROTECTED_CALENDAR_NAMES = new Set(['个人', '工作', '家庭', '飞行计划', '计划的提醒事项', '生日', '中国大陆节假日', 'Siri建议']);
