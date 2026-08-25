import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { fingerprintSource } from './services/hash';
import type { SourceType, TodoCandidate } from './connectors/types';
import { evidenceKey } from './productivitySchemaV3';

const TODO_V2_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: 'source_type', ddl: "source_type TEXT NOT NULL DEFAULT 'desktop'" },
  { name: 'source_external_id', ddl: 'source_external_id TEXT' },
  { name: 'source_fingerprint', ddl: 'source_fingerprint TEXT' },
  { name: 'lifecycle_status', ddl: "lifecycle_status TEXT NOT NULL DEFAULT 'candidate'" },
  { name: 'due_at', ddl: 'due_at TEXT' },
  { name: 'estimated_minutes', ddl: 'estimated_minutes INTEGER' },
  { name: 'planned_start_at', ddl: 'planned_start_at TEXT' },
  { name: 'planned_end_at', ddl: 'planned_end_at TEXT' },
  { name: 'calendar_event_id', ddl: 'calendar_event_id TEXT' },
  { name: 'calendar_sync_status', ddl: 'calendar_sync_status TEXT' },
  { name: 'completion_confidence', ddl: 'completion_confidence REAL' },
  { name: 'completed_at', ddl: 'completed_at TEXT' },
  { name: 'completion_source', ddl: 'completion_source TEXT' },
  { name: 'last_seen_at', ddl: 'last_seen_at TEXT' },
];

export function migrateProductivityV2(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(todos)').all() as { name: string }[];
  for (const col of TODO_V2_COLUMNS) {
    if (!cols.some((c) => c.name === col.name)) {
      db.exec(`ALTER TABLE todos ADD COLUMN ${col.ddl}`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_source_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      external_id TEXT,
      fingerprint TEXT,
      evidence_type TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES todos (id)
    );
    CREATE TABLE IF NOT EXISTS productivity_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      items_seen INTEGER NOT NULL DEFAULT 0,
      items_created INTEGER NOT NULL DEFAULT 0,
      items_updated INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT
    );
    CREATE TABLE IF NOT EXISTS calendar_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL,
      calendar_name TEXT NOT NULL,
      event_id TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      FOREIGN KEY (todo_id) REFERENCES todos (id)
    );
    CREATE TABLE IF NOT EXISTS connector_checkpoints (
      connector TEXT PRIMARY KEY,
      cursor TEXT,
      last_success_at TEXT,
      config_json TEXT NOT NULL DEFAULT '{}'
    );
  `);

  const runCols = db.prepare('PRAGMA table_info(productivity_sync_runs)').all() as { name: string }[];
  if (!runCols.some((c) => c.name === 'result_json')) {
    db.exec(`ALTER TABLE productivity_sync_runs ADD COLUMN result_json TEXT`);
  }

  const todoIdx = db.prepare('PRAGMA index_list(todos)').all() as { name: string }[];
  if (!todoIdx.some((i) => i.name === 'idx_todos_source_fingerprint')) {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_source_fingerprint ON todos (source_fingerprint) WHERE source_fingerprint IS NOT NULL AND source_fingerprint != ''`
    );
  }
  if (!todoIdx.some((i) => i.name === 'idx_todos_source_ext')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_source_ext ON todos (source_type, source_external_id)`);
  }
  if (!todoIdx.some((i) => i.name === 'idx_todos_lifecycle')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_lifecycle ON todos (lifecycle_status)`);
  }

  backfillLegacyTodos(db);
}

function backfillLegacyTodos(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, title, source_path, status, source_type, source_fingerprint, lifecycle_status, updated_at
       FROM todos WHERE source_fingerprint IS NULL OR source_fingerprint = '' OR last_seen_at IS NULL`
    )
    .all() as Array<{
    id: number;
    title: string;
    source_path: string;
    status: string;
    source_type: string;
    source_fingerprint: string | null;
    lifecycle_status: string;
    updated_at: string;
  }>;
  const update = db.prepare(
    `UPDATE todos SET
       source_type = @source_type,
       source_external_id = @source_external_id,
       source_fingerprint = @source_fingerprint,
       lifecycle_status = @lifecycle_status,
       last_seen_at = COALESCE(last_seen_at, @last_seen_at)
     WHERE id = @id`
  );
  const existing = new Set(
    (db.prepare(`SELECT source_fingerprint FROM todos WHERE source_fingerprint IS NOT NULL AND source_fingerprint != ''`).all() as Array<{ source_fingerprint: string }>).map(
      (r) => r.source_fingerprint
    )
  );
  const tx = db.transaction(() => {
    for (const row of rows) {
      const sourceType = row.source_path.startsWith('http') ? 'hotspot' : row.source_type || 'desktop';
      const lifecycle =
        row.status === 'confirmed' ? 'confirmed' : row.status === 'ignored' ? 'ignored' : row.lifecycle_status || 'candidate';
      let fingerprint = row.source_fingerprint || fingerprintSource(sourceType, row.source_path, row.title);
      if (existing.has(fingerprint) && row.source_fingerprint !== fingerprint) {
        fingerprint = `${fingerprint}:${row.id}`;
      }
      existing.add(fingerprint);
      update.run({
        id: row.id,
        source_type: sourceType,
        source_external_id: row.source_path,
        source_fingerprint: fingerprint,
        lifecycle_status: lifecycle,
        last_seen_at: row.updated_at,
      });
    }
  });
  tx();
}

export interface EvidenceRow {
  id: number;
  todo_id: number;
  source_type: string;
  external_id: string | null;
  fingerprint: string | null;
  evidence_type: string;
  summary: string;
  occurred_at: string;
  payload_json: string;
  created_at: string;
}

export interface SyncRunRow {
  id: number;
  connector: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  items_seen: number;
  items_created: number;
  items_updated: number;
  error_code: string | null;
  error_message: string | null;
  result_json?: string | null;
}

export function createProductivityRepos(db: Database.Database) {
  const aiRunCols = (db.prepare(`PRAGMA table_info(ai_analysis_runs)`).all() as { name: string }[]).map((c) => c.name);
  if (aiRunCols.includes('id') && !aiRunCols.includes('stats_json')) {
    db.exec(`ALTER TABLE ai_analysis_runs ADD COLUMN stats_json TEXT`);
  }

  const insertEvidence = db.prepare(
    `INSERT OR IGNORE INTO todo_source_evidence (todo_id, source_type, external_id, fingerprint, evidence_type, summary, occurred_at, payload_json, created_at, evidence_key)
     VALUES (@todo_id, @source_type, @external_id, @fingerprint, @evidence_type, @summary, @occurred_at, @payload_json, @created_at, @evidence_key)`
  );
  const findByFingerprint = db.prepare(`SELECT * FROM todos WHERE source_fingerprint = ?`);
  const findByExternal = db.prepare(`SELECT * FROM todos WHERE source_type = ? AND source_external_id = ? LIMIT 1`);
  const findOpenish = db.prepare(
    `SELECT * FROM todos WHERE lifecycle_status NOT IN ('ignored','completed') AND status != 'ignored'`
  );

  function upsertCandidate(
    candidate: TodoCandidate,
    now = new Date().toISOString()
  ): { action: 'created' | 'updated' | 'merged'; todoId: number } {
    const byFp = findByFingerprint.get(candidate.sourceFingerprint) as { id: number; status: string; lifecycle_status: string } | undefined;
    const byExt = findByExternal.get(candidate.sourceType, candidate.sourceExternalId) as { id: number; status: string; lifecycle_status: string } | undefined;
    const existing = byFp || byExt;
    if (existing) {
      db.prepare(
        `UPDATE todos SET
           last_seen_at = @now,
           updated_at = @now,
           due_at = COALESCE(@due_at, due_at),
           estimated_minutes = COALESCE(@estimated_minutes, estimated_minutes),
           reason = CASE WHEN reason = '' THEN @reason ELSE reason END
         WHERE id = @id`
      ).run({
        id: existing.id,
        now,
        due_at: candidate.suggestedDueAt ?? null,
        estimated_minutes: candidate.estimatedMinutes,
        reason: candidate.reason,
      });
      return { action: 'updated', todoId: existing.id };
    }

    const mergeTarget = findMergeTarget(candidate);
    if (mergeTarget) {
      addEvidence({
        todoId: mergeTarget.id,
        sourceType: candidate.sourceType,
        externalId: candidate.sourceExternalId,
        fingerprint: candidate.sourceFingerprint,
        evidenceType: 'merged_source',
        summary: candidate.reason,
        occurredAt: now,
        payload: { title: candidate.title, project: candidate.project || '' },
      });
      db.prepare(`UPDATE todos SET last_seen_at = @now, updated_at = @now WHERE id = @id`).run({ id: mergeTarget.id, now });
      return { action: 'merged', todoId: mergeTarget.id };
    }

    const info = db
      .prepare(
        `INSERT INTO todos (
           title, source_path, cluster, priority, reason, status, created_at, updated_at,
           source_type, source_external_id, source_fingerprint, lifecycle_status,
           due_at, estimated_minutes, last_seen_at,
           origin_mode, source_status, source_freshness, inference_confidence, action_identity, source_readonly, visibility
         ) VALUES (
           @title, @source_path, @cluster, @priority, @reason, 'pending', @now, @now,
           @source_type, @source_external_id, @source_fingerprint, 'candidate',
           @due_at, @estimated_minutes, @now,
           'legacy', 'open', 'unknown', @inference_confidence, NULL, 0, 'visible'
         )`
      )
      .run({
        title: candidate.title,
        source_path: candidate.sourcePath || candidate.sourceExternalId,
        cluster: candidate.cluster || candidate.project || '',
        priority: candidate.suggestedPriority,
        reason: candidate.reason,
        now,
        source_type: candidate.sourceType,
        source_external_id: candidate.sourceExternalId,
        source_fingerprint: candidate.sourceFingerprint,
        due_at: candidate.suggestedDueAt ?? null,
        estimated_minutes: candidate.estimatedMinutes,
        inference_confidence: candidate.confidence,
      });
    const todoId = Number(info.lastInsertRowid);
    for (const summary of candidate.evidenceSummaries) {
      addEvidence({
        todoId,
        sourceType: candidate.sourceType,
        externalId: candidate.sourceExternalId,
        fingerprint: candidate.sourceFingerprint,
        evidenceType: 'inferred',
        summary,
        occurredAt: now,
      });
    }
    return { action: 'created', todoId };
  }

  function findMergeTarget(candidate: TodoCandidate): { id: number } | undefined {
    if (candidate.sourceType === 'things') return undefined;
    const needle = normalizeLoose(candidate.title);
    const rows = findOpenish.all() as Array<{
      id: number;
      title: string;
      cluster: string;
      due_at: string | null;
      source_type?: string;
      origin_mode?: string;
    }>;
    for (const row of rows) {
      if (row.source_type === 'things' || row.origin_mode === 'structured') continue;
      if (!candidate.suggestedDueAt || !row.due_at) continue;
      if (candidate.cluster && row.cluster && candidate.cluster === row.cluster && sameWindow(candidate.suggestedDueAt, row.due_at)) {
        const hay = normalizeLoose(`${row.title}${row.cluster}`);
        if (needle.length >= 8 && (hay.includes(needle) || needle.includes(hay))) {
          return { id: row.id };
        }
      }
    }
    return undefined;
  }

  function addEvidence(input: {
    todoId: number;
    sourceType: SourceType | string;
    externalId?: string;
    fingerprint?: string;
    evidenceType: string;
    summary: string;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): void {
    const now = input.occurredAt || new Date().toISOString();
    const key = evidenceKey({
      todoId: input.todoId,
      sourceType: String(input.sourceType),
      externalId: input.externalId,
      fingerprint: input.fingerprint,
      evidenceType: input.evidenceType,
      discriminator: JSON.stringify(input.payload ?? {}),
    });
    insertEvidence.run({
      todo_id: input.todoId,
      source_type: input.sourceType,
      external_id: input.externalId ?? null,
      fingerprint: input.fingerprint ?? null,
      evidence_type: input.evidenceType,
      summary: input.summary,
      occurred_at: now,
      payload_json: JSON.stringify(input.payload ?? {}),
      created_at: now,
      evidence_key: key,
    });
  }

  function getEvidence(todoId: number): EvidenceRow[] {
    return db
      .prepare(`SELECT * FROM todo_source_evidence WHERE todo_id = ? ORDER BY occurred_at DESC, id DESC`)
      .all(todoId) as EvidenceRow[];
  }

  function getEvidenceCounts(ids: number[]): Map<number, number> {
    const counts = new Map<number, number>();
    if (ids.length === 0) return counts;
    const chunkSize = 400;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT todo_id AS todoId, COUNT(*) AS n FROM todo_source_evidence WHERE todo_id IN (${placeholders}) GROUP BY todo_id`
      ).all(...chunk) as Array<{ todoId: number; n: number }>;
      for (const row of rows) counts.set(Number(row.todoId), Number(row.n));
    }
    return counts;
  }

  function startSyncRun(connector: string): number {
    const info = db
      .prepare(
        `INSERT INTO productivity_sync_runs (connector, started_at, status) VALUES (?, ?, 'running')`
      )
      .run(connector, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  function finishSyncRun(
    id: number,
    patch: Partial<Pick<SyncRunRow, 'status' | 'items_seen' | 'items_created' | 'items_updated' | 'error_code' | 'error_message' | 'result_json'>>
  ): void {
    db.prepare(
      `UPDATE productivity_sync_runs SET
         finished_at = @finished_at,
         status = @status,
         items_seen = @items_seen,
         items_created = @items_created,
         items_updated = @items_updated,
         error_code = @error_code,
         error_message = @error_message,
         result_json = @result_json
       WHERE id = @id`
    ).run({
      id,
      finished_at: new Date().toISOString(),
      status: patch.status ?? 'ok',
      items_seen: patch.items_seen ?? 0,
      items_created: patch.items_created ?? 0,
      items_updated: patch.items_updated ?? 0,
      error_code: patch.error_code ?? null,
      error_message: patch.error_message ?? null,
      result_json: patch.result_json ?? null,
    });
  }

  function getSyncRun(id: number): SyncRunRow | undefined {
    return db.prepare(`SELECT * FROM productivity_sync_runs WHERE id = ?`).get(id) as SyncRunRow | undefined;
  }

  function interruptOrphanRunningRuns(): number {
    const now = new Date().toISOString();
    const info = db.prepare(
      `UPDATE productivity_sync_runs
       SET status = 'interrupted',
           error_code = 'PROCESS_RESTARTED',
           error_message = '后端进程重启，同步未完成',
           finished_at = ?
       WHERE status = 'running' AND finished_at IS NULL`
    ).run(now);
    return Number(info.changes || 0);
  }

  function getSyncRuns(limit = 20): SyncRunRow[] {
    return db.prepare(`SELECT * FROM productivity_sync_runs ORDER BY id DESC LIMIT ?`).all(limit) as SyncRunRow[];
  }

  function getCheckpoint(connector: string): { connector: string; cursor: string | null; last_success_at: string | null; config_json: string } | undefined {
    return db.prepare(`SELECT * FROM connector_checkpoints WHERE connector = ?`).get(connector) as
      | { connector: string; cursor: string | null; last_success_at: string | null; config_json: string }
      | undefined;
  }

  function saveCheckpoint(connector: string, config: unknown, cursor?: string): void {
    const prev = getCheckpoint(connector);
    let prevCfg: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(prev?.config_json || '{}');
      if (parsed && typeof parsed === 'object') prevCfg = parsed as Record<string, unknown>;
    } catch {
      prevCfg = {};
    }
    const incoming = config && typeof config === 'object' ? config as Record<string, unknown> : {};
    db.prepare(
      `INSERT INTO connector_checkpoints (connector, cursor, last_success_at, config_json)
       VALUES (@connector, @cursor, @last_success_at, @config_json)
       ON CONFLICT(connector) DO UPDATE SET
         cursor = excluded.cursor,
         last_success_at = excluded.last_success_at,
         config_json = excluded.config_json`
    ).run({
      connector,
      cursor: cursor ?? prev?.cursor ?? null,
      last_success_at: new Date().toISOString(),
      config_json: JSON.stringify({ ...prevCfg, ...incoming }),
    });
  }

  function recordConnectorRound(connector: string, round: {
    ok: boolean;
    roundCount: number;
    errorCode?: string | null;
    extra?: Record<string, unknown>;
  }): void {
    const prev = getCheckpoint(connector);
    let cfg: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(prev?.config_json || '{}');
      if (parsed && typeof parsed === 'object') cfg = parsed as Record<string, unknown>;
    } catch {
      cfg = {};
    }
    const next = {
      ...cfg,
      ...(round.extra || {}),
      lastRoundOk: round.ok,
      lastRoundCount: round.roundCount,
      lastRoundError: round.ok ? null : (round.errorCode || cfg.lastRoundError || null),
      lastRoundAt: new Date().toISOString(),
      usingStaleSnapshot: !round.ok && Boolean(prev?.last_success_at),
    };
    if (round.ok) {
      (next as Record<string, unknown>).lastSuccessCount = round.roundCount;
      saveCheckpoint(connector, next);
      return;
    }
    if (!prev) {
      db.prepare(
        `INSERT INTO connector_checkpoints (connector, cursor, last_success_at, config_json)
         VALUES (?, NULL, NULL, ?)`
      ).run(connector, JSON.stringify(next));
      return;
    }
    db.prepare(`UPDATE connector_checkpoints SET config_json=? WHERE connector=?`).run(JSON.stringify(next), connector);
  }

  function patchCheckpointConfig(connector: string, patch: Record<string, unknown>): void {
    const prev = getCheckpoint(connector);
    if (!prev) return;
    let cfg: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(prev.config_json || '{}');
      if (parsed && typeof parsed === 'object') cfg = parsed as Record<string, unknown>;
    } catch {
      cfg = {};
    }
    db.prepare(`UPDATE connector_checkpoints SET config_json=? WHERE connector=?`).run(
      JSON.stringify({ ...cfg, ...patch }),
      connector
    );
  }

  function getCalendarMapping(todoId: number): { id: number; todo_id: number; calendar_name: string; event_id: string; start_at: string; end_at: string; status: string } | undefined {
    return db
      .prepare(`SELECT * FROM calendar_mappings WHERE todo_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`)
      .get(todoId) as { id: number; todo_id: number; calendar_name: string; event_id: string; start_at: string; end_at: string; status: string } | undefined;
  }

  function upsertCalendarMapping(input: {
    todoId: number;
    calendarName: string;
    eventId: string;
    startAt: string;
    endAt: string;
  }): void {
    const existing = getCalendarMapping(input.todoId);
    const now = new Date().toISOString();
    if (existing) {
      db.prepare(
        `UPDATE calendar_mappings SET event_id=@event_id, start_at=@start_at, end_at=@end_at, last_synced_at=@now, status='active' WHERE id=@id`
      ).run({
        id: existing.id,
        event_id: input.eventId,
        start_at: input.startAt,
        end_at: input.endAt,
        now,
      });
      return;
    }
    db.prepare(
      `INSERT INTO calendar_mappings (todo_id, calendar_name, event_id, start_at, end_at, last_synced_at, status)
       VALUES (@todo_id, @calendar_name, @event_id, @start_at, @end_at, @now, 'active')`
    ).run({
      todo_id: input.todoId,
      calendar_name: input.calendarName,
      event_id: input.eventId,
      start_at: input.startAt,
      end_at: input.endAt,
      now,
    });
  }

  return {
    upsertCandidate,
    addEvidence,
    getEvidence,
    getEvidenceCounts,
    startSyncRun,
    finishSyncRun,
    getSyncRun,
    interruptOrphanRunningRuns,
    getSyncRuns,
    getCheckpoint,
    saveCheckpoint,
    patchCheckpointConfig,
    recordConnectorRound,
    getCalendarMapping,
    upsertCalendarMapping,
    countTable(table: string) {
      return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    },
    snapshotCounts() {
      return {
        todos: Number((db.prepare(`SELECT COUNT(*) AS n FROM todos`).get() as { n: number }).n),
        evidence: Number((db.prepare(`SELECT COUNT(*) AS n FROM todo_source_evidence`).get() as { n: number }).n),
        checkpoints: Number((db.prepare(`SELECT COUNT(*) AS n FROM connector_checkpoints`).get() as { n: number }).n),
        runs: Number((db.prepare(`SELECT COUNT(*) AS n FROM productivity_sync_runs`).get() as { n: number }).n),
        cache: Number((db.prepare(`SELECT COUNT(*) AS n FROM ai_analysis_cache`).get() as { n: number }).n),
        suggestions: Number((db.prepare(`SELECT COUNT(*) AS n FROM ai_action_suggestions`).get() as { n: number }).n),
      };
    },
    upsertThingsMirror(input: {
      title: string;
      sourceExternalId: string;
      sourceFingerprint: string;
      project?: string;
      dueAt?: string | null;
      reason: string;
      sourceStatus: 'open' | 'completed' | 'canceled';
      estimatedMinutes?: number;
      payload?: Record<string, unknown>;
      hiddenKeep?: boolean;
      now?: string;
    }): { action: 'created' | 'updated'; todoId: number } {
      const now = input.now || new Date().toISOString();
      const existing = findByExternal.get('things', input.sourceExternalId) as Record<string, unknown> | undefined;
      const hidden = existing && String(existing.visibility || '') === 'hidden_local';
      if (existing && typeof existing.id === 'number') {
        db.prepare(
          `UPDATE todos SET
             title=@title, cluster=@cluster, due_at=@due_at, reason=@reason,
             source_status=@source_status, source_freshness='fresh', origin_mode='structured',
             source_readonly=1, last_seen_at=@now, last_full_seen_at=@now,
             consecutive_missing_count=0, updated_at=@now,
             status=@status, lifecycle_status=@lifecycle,
             visibility=@visibility, archived_at=@archived_at, archive_reason=@archive_reason,
             estimated_minutes=COALESCE(@estimated_minutes, estimated_minutes),
             completed_at=@completed_at, source_scope='things_today'
           WHERE id=@id`
        ).run({
          id: existing.id,
          title: input.title,
          cluster: input.project || '',
          due_at: input.dueAt ?? null,
          reason: input.reason,
          source_status: input.sourceStatus,
          now,
          status: input.sourceStatus === 'canceled' ? 'ignored' : 'confirmed',
          lifecycle: input.sourceStatus === 'open' ? 'confirmed' : input.sourceStatus === 'completed' ? 'completed' : 'canceled',
          visibility: hidden ? 'hidden_local' : input.sourceStatus === 'canceled' ? 'archived' : 'visible',
          archived_at: input.sourceStatus === 'canceled' ? now : null,
          archive_reason: input.sourceStatus === 'canceled' ? 'things_canceled' : null,
          estimated_minutes: input.estimatedMinutes ?? null,
          completed_at: input.sourceStatus === 'completed' ? now : null,
        });
        db.prepare(
          `INSERT INTO todo_source_links (todo_id, action_identity, relation_type, source_type, source_external_id, source_fingerprint, first_seen_at, last_seen_at)
           VALUES (@todo_id, @aid, 'primary_mirror', 'things', @ext, @fp, @now, @now)
           ON CONFLICT(todo_id, action_identity, source_type, source_external_id, relation_type)
           DO UPDATE SET last_seen_at=excluded.last_seen_at, source_fingerprint=excluded.source_fingerprint`
        ).run({
          todo_id: existing.id,
          aid: `things:${input.sourceExternalId}`,
          ext: input.sourceExternalId,
          fp: input.sourceFingerprint,
          now,
        });
        return { action: 'updated', todoId: existing.id };
      }
      const info = db.prepare(
        `INSERT INTO todos (
           title, source_path, cluster, priority, reason, status, created_at, updated_at,
           source_type, source_external_id, source_fingerprint, lifecycle_status,
           due_at, estimated_minutes, last_seen_at, origin_mode, source_status, source_freshness,
           source_readonly, visibility, last_full_seen_at, consecutive_missing_count, completed_at, source_scope
         ) VALUES (
           @title, @source_path, @cluster, 'medium', @reason, @status, @now, @now,
           'things', @ext, @fp, @lifecycle,
           @due_at, @estimated_minutes, @now, 'structured', @source_status, 'fresh',
           1, @visibility, @now, 0, @completed_at, 'things_today'
         )`
      ).run({
        title: input.title,
        source_path: input.sourceExternalId,
        cluster: input.project || '',
        reason: input.reason,
        status: input.sourceStatus === 'canceled' ? 'ignored' : 'confirmed',
        now,
        ext: input.sourceExternalId,
        fp: input.sourceFingerprint,
        lifecycle: input.sourceStatus === 'open' ? 'confirmed' : input.sourceStatus === 'completed' ? 'completed' : 'canceled',
        due_at: input.dueAt ?? null,
        estimated_minutes: input.estimatedMinutes ?? 45,
        source_status: input.sourceStatus,
        visibility: input.sourceStatus === 'canceled' ? 'archived' : 'visible',
        completed_at: input.sourceStatus === 'completed' ? now : null,
      });
      const todoId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO todo_source_links (todo_id, action_identity, relation_type, source_type, source_external_id, source_fingerprint, first_seen_at, last_seen_at)
         VALUES (?, ?, 'primary_mirror', 'things', ?, ?, ?, ?)`
      ).run(todoId, `things:${input.sourceExternalId}`, input.sourceExternalId, input.sourceFingerprint, now, now);
      return { action: 'created', todoId };
    },
    listThingsMirrors() {
      return db.prepare(`SELECT * FROM todos WHERE source_type='things' AND origin_mode='structured'`).all() as Array<Record<string, unknown>>;
    },
    markThingsOutOfScope(ids: number[], now = new Date().toISOString()) {
      const stmt = db.prepare(
        `UPDATE todos SET source_status='out_of_scope', source_freshness='fresh', updated_at=@now, archive_reason='not_in_today'
         WHERE id=@id AND source_type='things' AND origin_mode='structured'`
      );
      for (const id of ids) stmt.run({ id, now });
    },
    markThingsMissing(ids: number[], now = new Date().toISOString()) {
      const stmt = db.prepare(
        `UPDATE todos SET consecutive_missing_count = consecutive_missing_count + 1, source_freshness='fresh', updated_at=@now
         WHERE id=@id AND source_type='things'`
      );
      const tomb = db.prepare(
        `UPDATE todos SET source_status='missing', visibility='archived', archived_at=@now, archive_reason='things_missing', updated_at=@now
         WHERE id=@id AND consecutive_missing_count >= 2 AND source_type='things'`
      );
      for (const id of ids) {
        stmt.run({ id, now });
        tomb.run({ id, now });
      }
    },
    markThingsStale() {
      db.prepare(`UPDATE todos SET source_freshness='stale' WHERE source_type='things' AND origin_mode='structured'`).run();
    },
    upsertSourceLink(input: {
      todoId: number;
      actionIdentity: string;
      relationType: string;
      sourceType: string;
      sourceExternalId: string;
      sourceFingerprint: string;
    }) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO todo_source_links (todo_id, action_identity, relation_type, source_type, source_external_id, source_fingerprint, first_seen_at, last_seen_at)
         VALUES (@todo_id, @action_identity, @relation_type, @source_type, @source_external_id, @source_fingerprint, @now, @now)
         ON CONFLICT(todo_id, action_identity, source_type, source_external_id, relation_type)
         DO UPDATE SET last_seen_at=excluded.last_seen_at, source_fingerprint=excluded.source_fingerprint`
      ).run({
        todo_id: input.todoId,
        action_identity: input.actionIdentity,
        relation_type: input.relationType,
        source_type: input.sourceType,
        source_external_id: input.sourceExternalId,
        source_fingerprint: input.sourceFingerprint,
        now,
      });
    },
    findByActionIdentity(actionIdentity: string) {
      return db.prepare(`SELECT * FROM todos WHERE action_identity = ?`).all(actionIdentity) as Array<Record<string, unknown>>;
    },
    listAiTodosForSource(sourceType: string) {
      return db.prepare(
        `SELECT * FROM todos
         WHERE origin_mode='ai' AND source_type=?
           AND COALESCE(visibility, 'visible') != 'hidden_local'
           AND COALESCE(lifecycle_status, 'candidate') NOT IN ('ignored','canceled','completed')
           AND COALESCE(source_status, 'open') NOT IN ('canceled','missing','out_of_scope')`
      ).all(sourceType) as Array<Record<string, unknown>>;
    },
    insertAiTodo(input: {
      title: string;
      reason: string;
      priority: string;
      dueAt?: string | null;
      estimatedMinutes: number;
      confidence: number;
      reasonCode: string;
      actionIdentity: string;
      actionOwner: string;
      sourceType: string;
      project?: string;
      analysisId?: number | null;
      sourceOccurredAt?: string | null;
    }): number {
      const now = new Date().toISOString();
      const info = db.prepare(
        `INSERT INTO todos (
           title, source_path, cluster, priority, reason, status, created_at, updated_at,
           source_type, source_external_id, source_fingerprint, lifecycle_status,
           due_at, estimated_minutes, last_seen_at, origin_mode, source_status, source_freshness,
           inference_confidence, inference_reason_code, action_identity, action_owner, source_readonly, visibility, ai_analysis_id,
           source_occurred_at
         ) VALUES (
           @title, @source_path, @cluster, @priority, @reason, 'pending', @now, @now,
           @source_type, @action_identity, @action_identity, 'candidate',
           @due_at, @estimated_minutes, @now, 'ai', 'open', 'fresh',
           @confidence, @reason_code, @action_identity, @action_owner, 0, 'visible', @analysis_id,
           @source_occurred_at
         )`
      ).run({
        title: input.title,
        source_path: input.actionIdentity,
        cluster: input.project || '',
        priority: input.priority,
        reason: input.reason,
        now,
        source_type: input.sourceType,
        due_at: input.dueAt ?? null,
        estimated_minutes: input.estimatedMinutes,
        confidence: input.confidence,
        reason_code: input.reasonCode,
        action_identity: input.actionIdentity,
        action_owner: input.actionOwner,
        analysis_id: input.analysisId ?? null,
        source_occurred_at: input.sourceOccurredAt ?? null,
      });
      return Number(info.lastInsertRowid);
    },
    updateAiTodoMutable(id: number, input: {
      title?: string;
      dueAt?: string | null;
      estimatedMinutes?: number;
      confidence?: number;
      reason?: string;
      reasonCode?: string;
      actionOwner?: string;
    }) {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE todos SET
           title=COALESCE(@title, title),
           due_at=@due_at,
           estimated_minutes=COALESCE(@estimated_minutes, estimated_minutes),
           inference_confidence=COALESCE(@confidence, inference_confidence),
           inference_reason_code=COALESCE(@reason_code, inference_reason_code),
           action_owner=COALESCE(action_owner, @action_owner),
           reason=COALESCE(@reason, reason),
           last_seen_at=@now, updated_at=@now
         WHERE id=@id AND origin_mode='ai'`
      ).run({
        id,
        title: input.title ?? null,
        due_at: Object.prototype.hasOwnProperty.call(input, 'dueAt') ? input.dueAt ?? null : undefined,
        estimated_minutes: input.estimatedMinutes ?? null,
        confidence: input.confidence ?? null,
        reason_code: input.reasonCode ?? null,
        action_owner: input.actionOwner ?? null,
        reason: input.reason ?? null,
        now,
      });
    },
    getAiCache(key: {
      model: string;
      promptVersion: string;
      schemaVersion: string;
      policyVersion: string;
      sourceType: string;
      opaqueHash: string;
      projectionHash: string;
    }) {
      return db.prepare(
        `SELECT * FROM ai_analysis_cache
         WHERE model=? AND prompt_version=? AND schema_version=? AND external_text_policy_version=?
           AND source_type=? AND opaque_stable_source_hash=? AND canonical_projection_hash=?
           AND status='ok' AND expires_at > ?`
      ).get(
        key.model,
        key.promptVersion,
        key.schemaVersion,
        key.policyVersion,
        key.sourceType,
        key.opaqueHash,
        key.projectionHash,
        new Date().toISOString()
      ) as Record<string, unknown> | undefined;
    },
    putAiCache(row: {
      opaqueHash: string;
      projectionHash: string;
      sourceType: string;
      model: string;
      promptVersion: string;
      schemaVersion: string;
      policyVersion: string;
      resultJson: string;
      promptTokens: number;
      completionTokens: number;
      expiresAt: string;
    }) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO ai_analysis_cache (
           opaque_stable_source_hash, canonical_projection_hash, source_type, model, prompt_version, schema_version,
           external_text_policy_version, result_json, status, prompt_tokens, completion_tokens, created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?)
         ON CONFLICT(model, prompt_version, schema_version, external_text_policy_version, source_type, opaque_stable_source_hash, canonical_projection_hash)
         DO UPDATE SET result_json=excluded.result_json, updated_at=excluded.updated_at, expires_at=excluded.expires_at,
           prompt_tokens=excluded.prompt_tokens, completion_tokens=excluded.completion_tokens, status='ok'`
      ).run(
        row.opaqueHash, row.projectionHash, row.sourceType, row.model, row.promptVersion, row.schemaVersion,
        row.policyVersion, row.resultJson, row.promptTokens, row.completionTokens, now, now, row.expiresAt
      );
    },
    insertAiRun(row: Record<string, unknown>): number {
      const info = db.prepare(
        `INSERT INTO ai_analysis_runs (started_at, finished_at, status, calls, retries, input_units, actionable, review, rejected, deferred, cache_hits, prompt_tokens, completion_tokens, elapsed_ms, error_code, stats_json)
         VALUES (@started_at, @finished_at, @status, @calls, @retries, @input_units, @actionable, @review, @rejected, @deferred, @cache_hits, @prompt_tokens, @completion_tokens, @elapsed_ms, @error_code, @stats_json)`
      ).run({
        started_at: row.started_at,
        finished_at: row.finished_at ?? null,
        status: row.status ?? 'ok',
        calls: row.calls ?? 0,
        retries: row.retries ?? 0,
        input_units: row.input_units ?? 0,
        actionable: row.actionable ?? 0,
        review: row.review ?? 0,
        rejected: row.rejected ?? 0,
        deferred: row.deferred ?? 0,
        cache_hits: row.cache_hits ?? 0,
        prompt_tokens: row.prompt_tokens ?? 0,
        completion_tokens: row.completion_tokens ?? 0,
        elapsed_ms: row.elapsed_ms ?? 0,
        error_code: row.error_code ?? null,
        stats_json: row.stats_json ?? null,
      });
      return Number(info.lastInsertRowid);
    },
    latestAiRun() {
      return db.prepare(`SELECT * FROM ai_analysis_runs ORDER BY id DESC LIMIT 1`).get() as Record<string, unknown> | undefined;
    },
    insertSuggestion(row: {
      actionIdentity?: string;
      sourceType: string;
      owner: string;
      intent: string;
      title: string;
      reasonCode: string;
      priority: string;
      confidence: number;
      evidenceRefs: string[];
      expiresAt: string;
      sourceOccurredAt?: string | null;
    }) {
      const now = new Date().toISOString();
      const existing = row.actionIdentity
        ? db.prepare(
          `SELECT id, evidence_refs_json FROM ai_action_suggestions
           WHERE action_identity=? AND source_type=? AND status='open' LIMIT 1`
        ).get(row.actionIdentity, row.sourceType) as { id: number; evidence_refs_json: string } | undefined
        : undefined;
      if (existing) {
        let prior: string[] = [];
        try {
          const parsed = JSON.parse(existing.evidence_refs_json || '[]');
          if (Array.isArray(parsed)) prior = parsed.map(String);
        } catch {
          prior = [];
        }
        const evidence = [...new Set(prior.concat(row.evidenceRefs.map(String)))];
        db.prepare(
          `UPDATE ai_action_suggestions SET
             title=?, reason_code=?, priority=?, confidence=MAX(confidence, ?),
             evidence_refs_json=?, expires_at=?,
             source_occurred_at=COALESCE(source_occurred_at, ?)
           WHERE id=?`
        ).run(
          row.title, row.reasonCode, row.priority, row.confidence,
          JSON.stringify(evidence), row.expiresAt, row.sourceOccurredAt ?? null, existing.id
        );
        return;
      }
      db.prepare(
        `INSERT OR IGNORE INTO ai_action_suggestions (action_identity, source_type, owner, intent, title, reason_code, priority, confidence, evidence_refs_json, status, created_at, expires_at, source_occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
      ).run(
        row.actionIdentity ?? null, row.sourceType, row.owner, row.intent, row.title, row.reasonCode, row.priority,
        row.confidence, JSON.stringify(row.evidenceRefs), now, row.expiresAt, row.sourceOccurredAt ?? null
      );
    },
    getSuggestion(id: number) {
      return db.prepare(`SELECT * FROM ai_action_suggestions WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    },
    setSuggestionStatus(id: number, status: 'open' | 'accepted' | 'rejected') {
      db.prepare(`UPDATE ai_action_suggestions SET status=? WHERE id=?`).run(status, id);
    },
    listActiveCalendarMappings() {
      return db.prepare(`SELECT * FROM calendar_mappings WHERE status='active'`).all() as Array<{
        id: number;
        todo_id: number;
        start_at: string;
        end_at: string;
        calendar_name: string;
        event_id: string;
      }>;
    },
    canonicalTableHash(table: string): string {
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      const normalized = rows
        .map((row) => JSON.stringify(row, Object.keys(row).sort()))
        .sort();
      return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    },
    snapshotRowHashes() {
      const tables = [
        'todos',
        'todo_source_links',
        'todo_source_evidence',
        'ai_action_suggestions',
        'ai_analysis_cache',
        'ai_budget_days',
        'ai_analysis_runs',
        'connector_checkpoints',
        'agenda_sync_windows',
      ];
      const out: Record<string, string> = {};
      for (const table of tables) {
        try {
          out[table] = this.canonicalTableHash(table);
        } catch {
          out[table] = 'missing';
        }
      }
      return out;
    },
    listSuggestions() {
      return db.prepare(`SELECT * FROM ai_action_suggestions WHERE status='open' AND expires_at > ? ORDER BY id DESC`).all(new Date().toISOString()) as Array<Record<string, unknown>>;
    },
    upsertUnitOutcome(row: {
      sourceType: string;
      opaqueHash: string;
      localDate: string;
      occurredAt?: string | null;
      decision: string;
      schemaVersion: string;
      promptVersion: string;
    }) {
      db.prepare(
        `INSERT INTO ai_unit_outcomes (source_type, opaque_hash, local_date, occurred_at, decision, schema_version, prompt_version, created_at)
         VALUES (@source_type, @opaque_hash, @local_date, @occurred_at, @decision, @schema_version, @prompt_version, @created_at)
         ON CONFLICT(opaque_hash, schema_version, prompt_version) DO UPDATE SET
           local_date=excluded.local_date,
           occurred_at=excluded.occurred_at,
           decision=excluded.decision`
      ).run({
        source_type: row.sourceType,
        opaque_hash: row.opaqueHash,
        local_date: row.localDate,
        occurred_at: row.occurredAt ?? null,
        decision: row.decision,
        schema_version: row.schemaVersion,
        prompt_version: row.promptVersion,
        created_at: new Date().toISOString(),
      });
    },
    listUnitOutcomesForDate(localDate: string) {
      return db.prepare(`SELECT * FROM ai_unit_outcomes WHERE local_date=?`).all(localDate) as Array<Record<string, unknown>>;
    },
    getDayPlan(localDate: string, timezone: string) {
      return db.prepare(`SELECT * FROM day_plans WHERE local_date=? AND timezone=?`).get(localDate, timezone) as Record<string, unknown> | undefined;
    },
    listDayPlanBlocks(planId: number) {
      return db.prepare(`SELECT * FROM day_plan_blocks WHERE plan_id=? ORDER BY unscheduled ASC, start_at ASC, id ASC`).all(planId) as Array<Record<string, unknown>>;
    },
    replaceDayPlan(input: {
      localDate: string;
      timezone: string;
      status: string;
      overviewRevision: string;
      busyRevision: string;
      warning?: string | null;
      unverified?: boolean;
      strategy?: string;
      plannerMeta?: unknown;
      unscheduled: unknown[];
      blocks: Array<{
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
      }>;
    }): number {
      const existing = this.getDayPlan(input.localDate, input.timezone);
      if (existing && typeof existing.id === 'number') {
        db.prepare(`DELETE FROM day_plan_blocks WHERE plan_id=?`).run(existing.id);
        db.prepare(`DELETE FROM day_plans WHERE id=?`).run(existing.id);
      }
      const now = new Date().toISOString();
      const info = db.prepare(
        `INSERT INTO day_plans (local_date, timezone, status, overview_revision, busy_revision, warning, unverified, strategy, planner_meta_json, unscheduled_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.localDate,
        input.timezone,
        input.status,
        input.overviewRevision,
        input.busyRevision,
        input.warning ?? null,
        input.unverified ? 1 : 0,
        input.strategy || 'manual',
        JSON.stringify(input.plannerMeta || {}),
        JSON.stringify(input.unscheduled),
        now,
        now
      );
      const planId = Number(info.lastInsertRowid);
      const insertBlock = db.prepare(
        `INSERT INTO day_plan_blocks (plan_id, stable_key, todo_id, title, start_at, end_at, source_type, kind, fixed, schedulable, minutes, unscheduled, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const block of input.blocks) {
        insertBlock.run(
          planId,
          block.stableKey,
          block.todoId ?? null,
          block.title,
          block.startAt || '',
          block.endAt || '',
          block.sourceType,
          block.kind,
          block.fixed ? 1 : 0,
          block.schedulable ? 1 : 0,
          block.minutes,
          block.unscheduled ? 1 : 0,
          block.reason ?? null
        );
      }
      return planId;
    },
    markDayPlanStale(planId: number) {
      db.prepare(`UPDATE day_plans SET status='stale', updated_at=? WHERE id=? AND status!='committed'`).run(new Date().toISOString(), planId);
    },
    expireAiDerivatives(now = new Date().toISOString()) {
      db.prepare(`DELETE FROM ai_analysis_cache WHERE expires_at <= ?`).run(now);
      db.prepare(`DELETE FROM ai_action_suggestions WHERE expires_at <= ?`).run(now);
    },
    clearAiDerivatives() {
      db.exec(`DELETE FROM ai_analysis_cache; DELETE FROM ai_action_suggestions;`);
    },
    getAnalysisCursor(cursorKey: string) {
      try {
        return db.prepare(`SELECT * FROM analysis_cursors WHERE cursor_key=?`).get(cursorKey) as
          | { cursor_key: string; high_water: string | null; consecutive_failures: number; partial: number }
          | undefined;
      } catch {
        return undefined;
      }
    },
    putAnalysisCursor(cursorKey: string, highWater: string, extra: { error?: string; partial?: boolean } = {}) {
      try {
        db.prepare(
          `INSERT INTO analysis_cursors (cursor_key, high_water, last_success_at, last_error, consecutive_failures, partial)
           VALUES (@cursor_key, @high_water, @ok, @err, @fail, @partial)
           ON CONFLICT(cursor_key) DO UPDATE SET
             high_water=excluded.high_water,
             last_success_at=CASE WHEN @err IS NULL THEN excluded.last_success_at ELSE analysis_cursors.last_success_at END,
             last_error=@err,
             consecutive_failures=CASE WHEN @err IS NULL THEN 0 ELSE analysis_cursors.consecutive_failures + 1 END,
             partial=excluded.partial`
        ).run({
          cursor_key: cursorKey,
          high_water: highWater,
          ok: extra.error ? null : new Date().toISOString(),
          err: extra.error ?? null,
          fail: extra.error ? 1 : 0,
          partial: extra.partial ? 1 : 0,
        });
      } catch {
        /* table may not exist in pre-v31 tests that skip migration */
      }
    },
    upsertAgendaEvent(row: Record<string, unknown>) {
      db.prepare(
        `INSERT INTO agenda_event_cache (
           provider, canonical_event_key, calendar_identifier, event_identifier, occurrence_start_at,
           calendar_name, title, start_at, end_at, original_timezone, all_day, all_day_local_start, all_day_local_end,
           availability, readonly, owned_by_workbench, calendar_type, last_seen_at, stale_at, deleted_at
         ) VALUES (
           @provider, @canonical_event_key, @calendar_identifier, @event_identifier, @occurrence_start_at,
           @calendar_name, @title, @start_at, @end_at, @original_timezone, @all_day, @all_day_local_start, @all_day_local_end,
           @availability, @readonly, @owned_by_workbench, @calendar_type, @last_seen_at, NULL, NULL
         )
         ON CONFLICT(canonical_event_key) DO UPDATE SET
           title=excluded.title, start_at=excluded.start_at, end_at=excluded.end_at, last_seen_at=excluded.last_seen_at,
           availability=excluded.availability, stale_at=NULL, deleted_at=NULL, calendar_name=excluded.calendar_name,
           original_timezone=excluded.original_timezone, all_day=excluded.all_day,
           all_day_local_start=excluded.all_day_local_start, all_day_local_end=excluded.all_day_local_end,
           calendar_type=excluded.calendar_type, owned_by_workbench=excluded.owned_by_workbench,
           readonly=excluded.readonly`
      ).run(row);
    },
    markAgendaStaleOutside(provider: string, fromAt: string, toAt: string, seenKeys: string[], now = new Date().toISOString()) {
      const rows = db.prepare(
        `SELECT canonical_event_key FROM agenda_event_cache
         WHERE provider=? AND deleted_at IS NULL AND start_at >= ? AND start_at <= ?`
      ).all(provider, fromAt, toAt) as Array<{ canonical_event_key: string }>;
      const seen = new Set(seenKeys);
      const upd = db.prepare(`UPDATE agenda_event_cache SET stale_at=@now, deleted_at=@now WHERE canonical_event_key=@k`);
      for (const row of rows) {
        if (!seen.has(row.canonical_event_key)) upd.run({ now, k: row.canonical_event_key });
      }
    },
    saveAgendaWindow(row: {
      provider: string;
      fromAt: string;
      toAt: string;
      timezone: string;
      complete: boolean;
      status: string;
      errorCode?: string | null;
    }) {
      db.prepare(
        `INSERT INTO agenda_sync_windows (provider, from_at, to_at, timezone, snapshot_complete, last_success_at, stale_after, status, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.provider, row.fromAt, row.toAt, row.timezone, row.complete ? 1 : 0,
        row.status === 'ok' ? new Date().toISOString() : null,
        new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        row.status, row.errorCode ?? null
      );
    },
    latestAgendaWindow(provider: string) {
      return db.prepare(`SELECT * FROM agenda_sync_windows WHERE provider=? ORDER BY id DESC LIMIT 1`).get(provider) as Record<string, unknown> | undefined;
    },
    listAgendaEvents(fromAt: string, toAt: string) {
      return db.prepare(
        `SELECT * FROM agenda_event_cache
         WHERE deleted_at IS NULL AND start_at < ? AND end_at > ?
         ORDER BY start_at ASC`
      ).all(toAt, fromAt) as Array<Record<string, unknown>>;
    },
    budgetDay(dayKey: string) {
      db.prepare(`INSERT OR IGNORE INTO ai_budget_days (day_key) VALUES (?)`).run(dayKey);
      return db.prepare(`SELECT * FROM ai_budget_days WHERE day_key=?`).get(dayKey) as {
        day_key: string;
        reserved_input: number;
        reserved_output: number;
        used_input: number;
        used_output: number;
        estimated_usd: number;
      };
    },
    reserveBudget(dayKey: string, input: number, output: number, usd: number) {
      db.prepare(`INSERT OR IGNORE INTO ai_budget_days (day_key) VALUES (?)`).run(dayKey);
      db.prepare(
        `UPDATE ai_budget_days SET reserved_input = reserved_input + ?, reserved_output = reserved_output + ?, estimated_usd = estimated_usd + ? WHERE day_key=?`
      ).run(input, output, usd, dayKey);
    },
    tryReserveBudget(dayKey: string, input: number, output: number, usd: number, limits: { maxInput: number; maxOutput: number; maxUsd: number }): boolean {
      const tx = db.transaction(() => {
        db.prepare(`INSERT OR IGNORE INTO ai_budget_days (day_key) VALUES (?)`).run(dayKey);
        const day = db.prepare(`SELECT * FROM ai_budget_days WHERE day_key=?`).get(dayKey) as {
          reserved_input: number;
          reserved_output: number;
          used_input: number;
          used_output: number;
          estimated_usd: number;
        };
        if (
          day.reserved_input + day.used_input + input > limits.maxInput ||
          day.reserved_output + day.used_output + output > limits.maxOutput ||
          day.estimated_usd + usd > limits.maxUsd
        ) {
          return false;
        }
        db.prepare(
          `UPDATE ai_budget_days SET reserved_input = reserved_input + ?, reserved_output = reserved_output + ?, estimated_usd = estimated_usd + ? WHERE day_key=?`
        ).run(input, output, usd, dayKey);
        return true;
      });
      return tx();
    },
    commitAgendaProvider(input: {
      provider: string;
      events: Array<Record<string, unknown>>;
      fromAt: string;
      toAt: string;
      timezone: string;
      complete: boolean;
      status: string;
      errorCode?: string | null;
    }) {
      const tx = db.transaction(() => {
        const seen: string[] = [];
        for (const ev of input.events) {
          this.upsertAgendaEvent(ev);
          seen.push(String(ev.canonical_event_key));
        }
        this.markAgendaStaleOutside(input.provider, input.fromAt, input.toAt, seen);
        this.saveAgendaWindow({
          provider: input.provider,
          fromAt: input.fromAt,
          toAt: input.toAt,
          timezone: input.timezone,
          complete: input.complete,
          status: input.status,
          errorCode: input.errorCode,
        });
      });
      tx();
    },
    settleBudget(dayKey: string, reservedIn: number, reservedOut: number, reservedUsd: number, usedIn: number, usedOut: number, usedUsd: number) {
      db.prepare(
        `UPDATE ai_budget_days SET
           reserved_input = MAX(0, reserved_input - ?),
           reserved_output = MAX(0, reserved_output - ?),
           used_input = used_input + ?,
           used_output = used_output + ?,
           estimated_usd = MAX(0, estimated_usd - ? + ?)
         WHERE day_key=?`
      ).run(reservedIn, reservedOut, usedIn, usedOut, reservedUsd, usedUsd, dayKey);
    },
    saveFeishuCursor(chatHash: string, watermark: string, status = 'ok') {
      db.prepare(
        `INSERT INTO feishu_chat_cursors (chat_hash, watermark, last_success_at, status) VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_hash) DO UPDATE SET watermark=excluded.watermark, last_success_at=excluded.last_success_at, status=excluded.status`
      ).run(chatHash, watermark, new Date().toISOString(), status);
    },
    getFeishuCursor(chatHash: string) {
      return db.prepare(`SELECT * FROM feishu_chat_cursors WHERE chat_hash=?`).get(chatHash) as { chat_hash: string; watermark: string | null; status: string } | undefined;
    },
    writeMigrationCleanupAudit(affected: number, status: string) {
      db.prepare(
        `INSERT INTO productivity_migration_audit (version, conflict_type, affected_count, started_at, finished_at, status)
         VALUES ('v3', 'legacy_ai_cleanup', ?, ?, ?, ?)`
      ).run(affected, new Date().toISOString(), new Date().toISOString(), status);
    },
    findByFingerprint: (fp: string) => findByFingerprint.get(fp) as Record<string, unknown> | undefined,
    findByExternal: (type: string, id: string) => findByExternal.get(type, id) as Record<string, unknown> | undefined,
  };
}

function normalizeLoose(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function sameWindow(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return true;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return true;
  return Math.abs(da - db) <= 3 * 24 * 60 * 60 * 1000;
}

export type ProductivityRepos = ReturnType<typeof createProductivityRepos>;
