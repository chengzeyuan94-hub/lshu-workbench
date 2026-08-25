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
  trend: number[];
  unit?: string;
  /** OpenCLI 原始字段名（保留用于排查字段变更） */
  rawName?: string;
  /** 原始 total 值（未格式化） */
  rawTotal?: number;
}

export type XhsPeriod = 'seven' | 'thirty';

export interface PeriodMetrics {
  period: XhsPeriod;
  metrics: CreatorMetric[];
}

/** 完整快照（含双周期） */
export interface XhsSnapshotData {
  syncedAt: string;
  source: 'live' | 'demo' | 'stale' | 'error';
  profile: CreatorProfile | null;
  notes: NotePerformance[];
  periods: Record<XhsPeriod, PeriodMetrics>;
  message?: string;
}

// ===== 单篇笔记详情 =====
export interface DetailRow {
  section: string;
  metric: string;
  value: string;
  extra: string;
}

export interface CreatorNoteDetail {
  noteId: string;
  fetchedAt: string;
  source: 'live' | 'stale' | 'error';
  rawRows: DetailRow[];
  basic: {
    impressions?: number;
    views?: number;
    coverClickRate?: number; // 百分比数值
    avgViewTimeSeconds?: number;
    newFollowers?: number;
  };
  engagement: {
    likes?: number;
    collects?: number;
    comments?: number;
    shares?: number;
  };
  dailyTrends: Record<string, Array<{ date: string; value: number }>>;
  hourlyTrends: Record<string, Array<{ dateTime: string; value: number }>>;
  trafficSources: Array<{
    name: string;
    percent: number;
    impressions?: number;
    views?: number;
    engagements?: number;
  }>;
  audience: {
    gender: Array<{ name: string; percent: number }>;
    ages: Array<{ name: string; percent: number }>;
    cities: Array<{ name: string; percent: number }>;
    interests: Array<{ name: string; percent: number }>;
  };
  title?: string;
  publishedAt?: string;
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
  collectRate?: number;
  lowPerformance?: boolean;
}

export interface ScanFile {
  path: string;
  name: string;
  type: string;
  size: number;
  modifiedAt: string;
}

export interface ClusterSummary {
  name: string;
  fileCount: number;
  reason: string;
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

export interface TodoItem {
  id: number;
  title: string;
  sourcePath: string;
  cluster: string;
  priority: 'high' | 'medium' | 'low';
  reason: string;
  status: 'pending' | 'confirmed' | 'ignored';
  createdAt: string;
  updatedAt: string;
}
