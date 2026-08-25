import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, extname, basename, dirname, resolve } from 'node:path';
import type { ClusterSummary, ScanFile, TodoItem } from './types';
import { getSettings } from './db';
import { sha256 } from './services/hash';
import { truncateSummary } from './services/redact';
import { classifyDesktopPath, detectContentSecrets } from './services/desktopDlp';
import { childEnv } from './config/childEnv';

// ===== 文本提取（安全降级） =====
function safeExtractText(filePath: string, type: string): string {
  try {
    if (type === 'md' || type === 'txt') {
      return readFileSync(filePath, 'utf-8').slice(0, 4000);
    }
    // pdf/docx/xmind 本地解析，失败则安全降级为空字符串
    if (type === 'pdf') return extractPdf(filePath);
    if (type === 'docx') return extractDocx(filePath);
    if (type === 'xmind' || type === 'mindnode') return extractXmind(filePath);
    return '';
  } catch {
    return ''; // 安全降级
  }
}

function extractPdf(filePath: string): string {
  try {
    const out = execFileSync('pdftotext', [filePath, '-'], {
      maxBuffer: 5 * 1024 * 1024,
      env: childEnv(),
      timeout: 12_000,
    });
    return out.toString().slice(0, 4000);
  } catch {
    return '';
  }
}

function extractDocx(filePath: string): string {
  try {
    const out = execFileSync('unzip', ['-p', filePath, 'word/document.xml'], {
      maxBuffer: 5 * 1024 * 1024,
      env: childEnv(),
      timeout: 12_000,
    });
    return out.toString().replace(/<[^>]*>/g, ' ').slice(0, 4000);
  } catch {
    return '';
  }
}

function extractXmind(filePath: string): string {
  try {
    const out = execFileSync('unzip', ['-p', filePath, 'content.json'], {
      maxBuffer: 200_000,
      env: childEnv(),
      timeout: 12_000,
    });
    return out.toString().slice(0, 4000);
  } catch {
    return '';
  }
}

// ===== 跳过规则 =====
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.DS_Store',
  '.localized',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  'out',
  'Library',
  'tmp',
  'temp',
  'cache',
  '.idea',
  '.vscode',
]);

const SKIP_EXT = new Set([
  '.ds_store',
  '.localized',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.mp3',
  '.wav',
  '.ogg',
  '.zip',
  '.rar',
  '.dmg',
  '.pxd',
  '.fbx',
  '.glb',
  '.key',
  '.db',
  '.db-shm',
  '.db-wal',
  '.sqlite',
  '.sqlite3',
  '.sh',
  '.pyc',
  '.log',
]);

export const EXTRACT_EXT = new Set(['.md', '.txt', '.pdf', '.docx', '.xmind', '.mindnode']);

export function isSkipDir(name: string, extraSkipDirs: string[] = []): boolean {
  if (name.startsWith('.')) return true;
  if (name === 'data' || name === 'dist' || name === 'build' || name === 'output') return true;
  if (SKIP_DIRS.has(name)) return true;
  return extraSkipDirs.some((d) => d === name || d.toLowerCase() === name.toLowerCase());
}

function isSkipFile(name: string): boolean {
  if (name.startsWith('.')) return true;
  const ext = extname(name).toLowerCase();
  if (SKIP_EXT.has(ext)) return true;
  // 排除 SQLite 临时文件
  if (name.endsWith('-shm') || name.endsWith('-wal')) return true;
  return false;
}

// ===== 扫描 =====
export interface RawEntry {
  path: string;
  name: string;
  type: string;
  size: number;
  modifiedAt: string;
  text: string;
  blockedReason?: string;
}

function walkDir(dir: string, maxDepth = 2, depth = 0, extraSkipDirs: string[] = []): RawEntry[] {
  if (depth > maxDepth) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const result: RawEntry[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (isSkipDir(name, extraSkipDirs)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      result.push(...walkDir(full, maxDepth, depth + 1, extraSkipDirs));
    } else if (st.isFile()) {
      if (isSkipFile(name)) continue;
      const verdict = classifyDesktopPath(full);
      if (verdict.blocked) {
        result.push({
          path: '',
          name: '',
          type: 'blocked',
          size: 0,
          modifiedAt: new Date(st.mtimeMs).toISOString(),
          text: '',
          blockedReason: verdict.reasonCode,
        });
        continue;
      }
      const ext = extname(name).toLowerCase().replace('.', '');
      const text = safeExtractText(full, ext);
      if (detectContentSecrets(text)) {
        result.push({
          path: '',
          name: '',
          type: 'blocked',
          size: 0,
          modifiedAt: new Date(st.mtimeMs).toISOString(),
          text: '',
          blockedReason: 'content_secret',
        });
        continue;
      }
      result.push({
        path: full,
        name,
        type: ext,
        size: st.size,
        modifiedAt: new Date(st.mtimeMs).toISOString(),
        text,
      });
    }
  }
  return result;
}

// ===== 项目簇识别 =====
interface ClusterRule {
  name: string;
  keywords: string[];
}

export const CLUSTER_RULES: ClusterRule[] = [
  { name: '内容与课程', keywords: ['内容', '课程', '训练营', '学员', '选题', '脚本'] },
  { name: '品牌与运营', keywords: ['品牌', '运营', '增长', '社群', '活动', '复盘'] },
  { name: '视频与设计生产', keywords: ['ppt', '视频', '成品', '素材', 'motion', '设计', '序列帧'] },
  { name: '产品与开发', keywords: ['产品', '交互', '原型', '需求', '开发', '测试'] },
];

export function detectClusters(entries: RawEntry[]): ClusterSummary[] {
  const matches = new Map<string, { count: number; reason: string }>();
  for (const rule of CLUSTER_RULES) {
    let count = 0;
    for (const e of entries) {
      const hay = (e.path + ' ' + e.name + ' ' + e.text).toLowerCase();
      if (rule.keywords.some((k) => hay.includes(k.toLowerCase()))) count++;
    }
    if (count > 0) {
      matches.set(rule.name, { count, reason: `匹配关键词：${rule.keywords.join(' / ')}` });
    }
  }
  return Array.from(matches.entries()).map(([name, v]) => ({
    name,
    fileCount: v.count,
    reason: v.reason,
  }));
}

// ===== 待办生成 =====
export function generateTodos(entries: RawEntry[], clusters: ClusterSummary[]): Omit<TodoItem, 'id'>[] {
  const now = new Date().toISOString();
  const todos: Omit<TodoItem, 'id'>[] = [];

  for (const c of clusters) {
    const clusterEntries = entries.filter((e) => {
      const hay = (e.path + ' ' + e.name + ' ' + e.text).toLowerCase();
      const rule = CLUSTER_RULES.find((r) => r.name === c.name)!;
      return rule.keywords.some((k) => hay.includes(k.toLowerCase()));
    });
    if (clusterEntries.length === 0) continue;

    const mostRecent = clusterEntries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0];
    const dayDiff = Math.floor(
      (Date.now() - new Date(mostRecent.modifiedAt).getTime()) / (1000 * 60 * 60 * 24)
    );

    const priority = dayDiff <= 2 ? 'high' : dayDiff <= 7 ? 'medium' : 'low';
    todos.push({
      title: `推进「${c.name}」项目簇（${clusterEntries.length} 个相关文件）`,
      sourcePath: mostRecent.path,
      cluster: c.name,
      priority,
      reason: `最近更新：${dayDiff <= 0 ? '今天' : dayDiff + ' 天前'}（${basename(mostRecent.path)}）。${c.reason}`,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  }

  // 检测近期独立更新的可执行文件（md/txt/pdf/docx/xmind）→ 建议整理
  const recentFiles = entries
    .filter((e) => EXTRACT_EXT.has('.' + e.type))
    .filter((e) => Date.now() - new Date(e.modifiedAt).getTime() < 3 * 24 * 60 * 60 * 1000)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  const seenDirs = new Set<string>();
  for (const f of recentFiles) {
    const parent = dirname(f.path);
    if (seenDirs.has(parent)) continue;
    seenDirs.add(parent);
    if (todos.length >= 12) break;
    todos.push({
      title: `整理近期文档：${f.name}`,
      sourcePath: f.path,
      cluster: '待归类',
      priority: 'medium',
      reason: `近 3 天有更新，属于 ${f.type.toUpperCase()} 文档，可考虑归类到对应项目。`,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  }

  // 按优先级排序：high → medium → low
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  todos.sort((a, b) => order[a.priority] - order[b.priority]);

  return todos;
}

// ===== 主入口 =====
export interface ScanResult {
  scannedAt: string;
  rootDir: string;
  fileCount: number;
  skippedCount: number;
  blockedCount: number;
  blockedReasonCounts: Record<string, number>;
  clusters: ClusterSummary[];
  files: ScanFile[];
  todos: Omit<TodoItem, 'id'>[];
  entries: DesktopCollectedEntry[];
}

export interface DesktopCollectedEntry {
  path: string;
  name: string;
  type: string;
  size: number;
  modifiedAt: string;
  text: string;
  fingerprint: string;
}

export function collectDesktopEntries(
  rootDir: string,
  options: { maxDepth?: number; extraSkipDirs?: string[] } = {}
): DesktopCollectedEntry[] {
  const extra = options.extraSkipDirs ?? [];
  const entries = walkDir(resolve(rootDir), options.maxDepth ?? 2, 0, extra);
  return entries
    .filter((e) => !e.blockedReason)
    .map((e) => ({
      path: e.path,
      name: e.name,
      type: e.type,
      size: e.size,
      modifiedAt: e.modifiedAt,
      text: e.text,
      fingerprint: sha256(e.path, e.modifiedAt, e.size, truncateSummary(e.text || '', 200)),
    }));
}

export function scanDesktop(): ScanResult {
  const settings = getSettings();
  const rootDir = String(settings.scanRoot || process.env.WORKBENCH_SCAN_ROOT || `${homedir()}/Desktop`);
  if (!existsSync(rootDir)) {
    throw new Error(`扫描目录不存在：${rootDir}`);
  }

  const extraSkipDirs = Array.isArray(settings.excludedDirs) ? (settings.excludedDirs as string[]) : [];
  const walked = walkDir(resolve(rootDir), 2, 0, extraSkipDirs);
  const blocked = walked.filter((e) => e.blockedReason);
  const entries = walked.filter((e) => !e.blockedReason);
  const blockedReasonCounts: Record<string, number> = {};
  for (const b of blocked) {
    const code = b.blockedReason || 'secret_filename';
    blockedReasonCounts[code] = (blockedReasonCounts[code] || 0) + 1;
  }
  const clusters = detectClusters(entries);
  const todos = generateTodos(entries, clusters);

  const files: ScanFile[] = entries.map((e) => ({
    path: e.path,
    name: e.name,
    type: e.type,
    size: e.size,
    modifiedAt: e.modifiedAt,
  }));

  return {
    scannedAt: new Date().toISOString(),
    rootDir,
    fileCount: files.length,
    skippedCount: blocked.length,
    blockedCount: blocked.length,
    blockedReasonCounts,
    clusters,
    files,
    todos,
    entries: collectDesktopEntriesFromWalked(entries),
  };
}

function collectDesktopEntriesFromWalked(entries: RawEntry[]): DesktopCollectedEntry[] {
  return entries.map((e) => ({
    path: e.path,
    name: e.name,
    type: e.type,
    size: e.size,
    modifiedAt: e.modifiedAt,
    text: e.text,
    fingerprint: sha256(e.path, e.modifiedAt, e.size, truncateSummary(e.text || '', 200)),
  }));
}
