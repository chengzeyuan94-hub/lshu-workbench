import { detectClusters, generateTodos, type RawEntry } from '../scanner';
import type { StandardizedItem, TodoCandidate } from '../connectors/types';
import { fingerprintSource } from './hash';

function estimateMinutes(item: StandardizedItem): number {
  if (item.sourceType === 'things' && item.payload.list === 'today') return 45;
  if (item.sourceType === 'things' && item.dueAt) return 60;
  if (item.sourceType === 'desktop') return 60;
  if (item.sourceType === 'feishu_calendar') return 45;
  if (item.sourceType === 'feishu_message') return 30;
  return 45;
}

function priorityFor(item: StandardizedItem): TodoCandidate['suggestedPriority'] {
  if (item.payload.list === 'today') return 'high';
  if (item.dueAt) {
    const days = (new Date(item.dueAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    if (!Number.isNaN(days) && days <= 2) return 'high';
    if (!Number.isNaN(days) && days <= 7) return 'medium';
  }
  if (item.sourceType === 'desktop' && item.status === 'changed') return 'medium';
  return 'medium';
}

export function inferCandidates(items: StandardizedItem[]): TodoCandidate[] {
  const candidates: TodoCandidate[] = [];
  const desktopEntries: RawEntry[] = [];

  for (const item of items) {
    if (item.sourceType === 'desktop') {
      desktopEntries.push({
        path: item.sourceExternalId,
        name: item.title,
        type: String(item.payload.type || ''),
        size: Number(item.payload.size || 0),
        modifiedAt: item.modifiedAt || new Date().toISOString(),
        text: item.summary || '',
      });
      continue;
    }
    if (item.status === 'disappeared' || item.status === 'canceled') continue;
    if (item.status === 'completed') continue;
    if (item.sourceType === 'feishu_calendar') continue;

    candidates.push({
      title: item.title,
      sourceType: item.sourceType,
      sourceExternalId: item.sourceExternalId,
      sourceFingerprint: item.sourceFingerprint,
      reason: item.summary || `来自 ${item.sourceType}`,
      evidenceSummaries: [item.summary || item.title],
      suggestedPriority: priorityFor(item),
      suggestedDueAt: item.dueAt ?? null,
      estimatedMinutes: estimateMinutes(item),
      confidence: item.sourceType === 'things' ? 0.86 : 0.62,
      project: item.project,
      cluster: item.project,
      sourcePath: item.sourceExternalId,
    });
  }

  if (desktopEntries.length) {
    const clusters = detectClusters(desktopEntries);
    const generated = generateTodos(desktopEntries, clusters);
    for (const todo of generated) {
      const isCluster = todo.cluster !== '待归类';
      const externalId = isCluster ? `cluster:${todo.cluster}` : todo.sourcePath;
      candidates.push({
        title: todo.title,
        sourceType: 'desktop',
        sourceExternalId: externalId,
        sourceFingerprint: fingerprintSource('desktop', externalId, todo.title),
        reason: todo.reason,
        evidenceSummaries: [todo.reason],
        suggestedPriority: todo.priority,
        estimatedMinutes: isCluster ? 90 : 30,
        confidence: 0.58,
        project: todo.cluster,
        cluster: todo.cluster,
        sourcePath: todo.sourcePath,
      });
    }
  }

  return dedupeCandidates(candidates);
}

export function dedupeCandidates(candidates: TodoCandidate[]): TodoCandidate[] {
  const byKey = new Map<string, TodoCandidate>();
  for (const c of candidates) {
    const key = `${c.sourceType}:${c.sourceExternalId}`;
    const prev = byKey.get(key) || byKey.get(c.sourceFingerprint);
    if (!prev) {
      byKey.set(key, c);
      byKey.set(c.sourceFingerprint, c);
      continue;
    }
    prev.evidenceSummaries = Array.from(new Set([...prev.evidenceSummaries, ...c.evidenceSummaries]));
    prev.confidence = Math.max(prev.confidence, c.confidence);
  }
  const unique = Array.from(new Set(byKey.values()));
  return unique;
}
