import { redactText } from './redact';
import { safeDocumentLabel } from './desktopDlp';

export function publicTodoDto(row: Record<string, unknown>) {
  const r = row as Record<string, unknown>;
  return {
    id: Number(r.id),
    title: String(r.title || ''),
    cluster: String(r.cluster || ''),
    priority: String(r.priority || 'medium'),
    reason: redactText(String(r.reason || ''), 160),
    status: String(r.status || ''),
    createdAt: String(r.created_at || r.createdAt || ''),
    updatedAt: String(r.updated_at || r.updatedAt || ''),
    sourceType: String(r.source_type || r.sourceType || 'desktop'),
    lifecycleStatus: String(r.lifecycle_status || r.lifecycleStatus || 'candidate'),
    dueAt: (r.due_at ?? r.dueAt ?? null) as string | null,
    estimatedMinutes: (r.estimated_minutes ?? r.estimatedMinutes ?? null) as number | null,
    plannedStartAt: (r.planned_start_at ?? r.plannedStartAt ?? null) as string | null,
    plannedEndAt: (r.planned_end_at ?? r.plannedEndAt ?? null) as string | null,
    calendarSyncStatus: (r.calendar_sync_status ?? r.calendarSyncStatus ?? null) as string | null,
    completionConfidence: (r.completion_confidence ?? r.completionConfidence ?? null) as number | null,
    completedAt: (r.completed_at ?? r.completedAt ?? null) as string | null,
    lastSeenAt: (r.last_seen_at ?? r.lastSeenAt ?? null) as string | null,
    originMode: String(r.origin_mode || r.originMode || 'legacy'),
    sourceStatus: String(r.source_status || r.sourceStatus || 'open'),
    sourceFreshness: String(r.source_freshness || r.sourceFreshness || 'unknown'),
    sourceReadonly: r.source_readonly === 1 || r.sourceReadonly === true,
    visibility: String(r.visibility || 'visible'),
    sourceScope: (r.source_scope ?? r.sourceScope ?? null) as string | null,
    inferenceReasonCode: (r.inference_reason_code ?? r.inferenceReasonCode ?? null) as string | null,
  };
}

export function publicEvidenceDto(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    sourceType: String(row.source_type || 'unknown'),
    evidenceType: String(row.evidence_type || 'unknown'),
    summary: redactText(String(row.summary || ''), 80),
    occurredAt: String(row.occurred_at || row.created_at || ''),
  };
}

export function publicScanFiles(files: Array<{ path?: string; name?: string; type?: string; size?: number; modifiedAt?: string }>) {
  return files.map((f, i) => ({
    label: safeDocumentLabel(String(f.name || 'file'), String(f.path || i)),
    type: String(f.type || ''),
    size: Number(f.size || 0),
    modifiedAt: String(f.modifiedAt || ''),
  }));
}

export function assertPublicDtoSafe(payload: unknown): void {
  const text = JSON.stringify(payload);
  if (/\/Users\//.test(text) || /sourcePath|sourceExternalId|sourceFingerprint|actionIdentity|payload_json/.test(text)) {
    throw new Error('public DTO leaked internal fields');
  }
}
