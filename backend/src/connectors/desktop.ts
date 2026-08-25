import { basename, dirname, extname, resolve } from 'node:path';
import { collectDesktopEntries, type DesktopCollectedEntry } from '../scanner';
import { fingerprintSource, sha256 } from '../services/hash';
import { truncateSummary } from '../services/redact';
import type { ConnectorRunResult, StandardizedItem } from './types';

export interface DesktopSnapshotFile {
  path: string;
  fingerprint: string;
  firstSeenAt: string;
  lastModifiedAt: string;
  disappearedAt?: string | null;
  size: number;
}

export interface DesktopCheckpoint {
  files: Record<string, DesktopSnapshotFile>;
}

export function desktopFileFingerprint(entry: Pick<DesktopCollectedEntry, 'path' | 'size' | 'modifiedAt' | 'text'>): string {
  return sha256(entry.path, entry.modifiedAt, entry.size, truncateSummary(entry.text || '', 200));
}

export function diffDesktopEntries(
  current: DesktopCollectedEntry[],
  previous: DesktopCheckpoint | undefined,
  now = new Date().toISOString()
): { items: StandardizedItem[]; next: DesktopCheckpoint } {
  const prevFiles = previous?.files ?? {};
  const next: DesktopCheckpoint = { files: { ...prevFiles } };
  const items: StandardizedItem[] = [];
  const seen = new Set<string>();

  for (const entry of current) {
    seen.add(entry.path);
    const fp = entry.fingerprint || desktopFileFingerprint(entry);
    const old = prevFiles[entry.path];
    const firstSeenAt = old?.firstSeenAt || now;
    const changed = Boolean(old && old.fingerprint !== fp);
    next.files[entry.path] = {
      path: entry.path,
      fingerprint: fp,
      firstSeenAt,
      lastModifiedAt: entry.modifiedAt,
      disappearedAt: null,
      size: entry.size,
    };
    items.push({
      sourceType: 'desktop',
      sourceExternalId: entry.path,
      sourceFingerprint: fingerprintSource('desktop', entry.path),
      title: entry.name,
      project: basename(dirname(entry.path)),
      status: !old ? 'open' : changed ? 'changed' : 'open',
      modifiedAt: entry.modifiedAt,
      createdAt: firstSeenAt,
      summary: truncateSummary(entry.text || '', 160),
      payload: {
        size: entry.size,
        type: entry.type,
        firstSeenAt,
        lastModifiedAt: entry.modifiedAt,
        contentFingerprint: fp,
        changed,
      },
    });
  }

  for (const [path, old] of Object.entries(prevFiles)) {
    if (seen.has(path)) continue;
    const disappearedAt = old.disappearedAt || now;
    next.files[path] = { ...old, disappearedAt };
    items.push({
      sourceType: 'desktop',
      sourceExternalId: path,
      sourceFingerprint: fingerprintSource('desktop', path),
      title: basename(path),
      status: 'disappeared',
      modifiedAt: disappearedAt,
      summary: '文件最近从扫描范围消失',
      payload: {
        disappearedAt,
        lastModifiedAt: old.lastModifiedAt,
        type: extname(path).replace('.', ''),
      },
    });
  }

  return { items, next };
}

export function readDesktop(options: {
  rootDir: string;
  extraSkipDirs?: string[];
  previous?: DesktopCheckpoint;
  collect?: typeof collectDesktopEntries;
}): ConnectorRunResult {
  const collect = options.collect ?? collectDesktopEntries;
  try {
    const entries = collect(resolve(options.rootDir), {
      maxDepth: 2,
      extraSkipDirs: options.extraSkipDirs,
    });
    const { items, next } = diffDesktopEntries(entries, options.previous);
    return {
      connector: 'desktop',
      ok: true,
      items,
      itemsSeen: items.length,
      extra: { checkpoint: next, fileCount: entries.length },
    };
  } catch (e) {
    return {
      connector: 'desktop',
      ok: false,
      items: [],
      itemsSeen: 0,
      errorCode: 'DESKTOP_UNAVAILABLE',
      errorMessage: e instanceof Error ? e.message : '桌面扫描失败',
    };
  }
}
