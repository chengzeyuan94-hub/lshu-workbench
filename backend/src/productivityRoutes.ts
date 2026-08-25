import type { Express, Request, Response } from 'express';
import { mapProductivityError, ProductivityError, PRODUCTIVITY_ERROR_CODES } from './connectors/errors';
import { getTodo, getTodos, productivity, updateTodo, publicSettings, getSettings, DB_PATH } from './db';
import { getConnectorStatuses, getSyncRunPublic, mapTodoRow, previewSync, startCommitSync } from './services/productivitySync';
import { canScheduleTodo, dispatchTodoAction, rowToTransitionState, type TodoUserAction } from './services/todoTransitions';
import { DEFAULT_PLANNING_RULES, planTodos } from './services/planning';
import { scoreCompletion, shouldAutoComplete, type CompletionEvidence } from './services/completionReconciler';
import { todoActionFlags } from './services/todoActions';
import { inspectCalendarReadable, recordCalendarConnectorRound, calendarConnectSuccessCopy } from './services/calendarStatus';
import { calendarHelperBuildId } from './connectors/eventKit';
import { defaultAgendaRange, loadAgendaViews, maxSpanOk, resolveTimeZone, serverBusyIntervals, syncAppleAgenda } from './services/agendaService';
import { commitLegacyAiCleanup, previewLegacyAiCleanup } from './services/legacyCleanup';
import { publicEvidenceDto } from './services/publicDto';
import { getDeepseekRuntimeConfig } from './config/runtimeConfig';
import { isAiRunInFlight } from './services/actionIntentAnalyzer';
import { buildAiStatusDto } from './services/aiStatusDto';
import { redactText } from './services/redact';
import { queryTodayOverview } from './services/todayOverview';
import { createTodayDayPlan, dayPlanCommitPreview, getTodayDayPlan, refuseExternalCommit } from './services/dayPlanService';
import path from 'node:path';

function sendError(res: Response, err: unknown): void {
  const mapped = mapProductivityError(err);
  const message = mapped.message.replace(/\/Users\/[^\s]+/g, '[redacted]').replace(/\/home\/[^\s]+/g, '[redacted]');
  res.status(mapped.status).json({ code: mapped.code, message, details: mapped.details });
}

function applyUserTodoAction(id: number, action: TodoUserAction, extra: Record<string, unknown> = {}) {
  const todo = getTodo(id);
  if (!todo) return { status: 404 as const, body: { code: 'NOT_FOUND', message: '待办不存在' } };
  const next = dispatchTodoAction(rowToTransitionState(todo as unknown as Record<string, unknown>), action, extra);
  const updated = updateTodo(id, next);
  return { status: 200 as const, body: mapTodoRow(updated || todo) };
}

export function registerProductivityRoutes(app: Express): void {
  app.get('/api/productivity/connectors/status', async (_req, res) => {
    try {
      res.json({ connectors: await getConnectorStatuses(), settings: publicSettings() });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/productivity/sync/preview', async (_req, res) => {
    try {
      res.json(await previewSync());
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/productivity/sync/commit', async (_req, res) => {
    try {
      const started = startCommitSync();
      res.status(202).json(started);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/productivity/sync/runs/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: '无效的同步记录' });
    }
    const dto = getSyncRunPublic(id);
    if (!dto) return res.status(404).json({ code: 'NOT_FOUND', message: '同步记录不存在' });
    if (dto.status === 'running') {
      return res.json({
        runId: dto.runId,
        status: dto.status,
        startedAt: dto.startedAt,
        finishedAt: null,
      });
    }
    res.json({
      runId: dto.runId,
      status: dto.status,
      startedAt: dto.startedAt,
      finishedAt: dto.finishedAt,
      created: dto.created,
      updated: dto.updated,
      itemsSeen: dto.itemsSeen,
      candidateCount: dto.candidateCount,
      connectorErrors: dto.connectorErrors,
      ai: dto.ai,
      appleCount: dto.appleCount,
      receipt: dto.receipt,
      errorCode: dto.errorCode,
      errorMessage: dto.errorMessage,
      write: true,
    });
  });

  app.get('/api/productivity/ai/status', (_req, res) => {
    const cfg = getDeepseekRuntimeConfig();
    const run = productivity.latestAiRun();
    res.json(buildAiStatusDto({
      configured: cfg.configured,
      enabled: getSettings().aiAnalysisEnabled === true,
      running: isAiRunInFlight(),
      model: cfg.model,
      lastRun: run || null,
    }));
  });

  app.post('/api/productivity/ai/cache/clear', (_req, res) => {
    productivity.clearAiDerivatives();
    res.json({ ok: true, cleared: ['ai_analysis_cache', 'ai_action_suggestions'] });
  });

  app.get('/api/productivity/ai/suggestions', (_req, res) => {
    res.json({
      suggestions: productivity.listSuggestions().map((row) => ({
        id: Number(row.id),
        title: String(row.title || ''),
        owner: String(row.owner || ''),
        intent: String(row.intent || ''),
        confidence: Number(row.confidence || 0),
        reasonCode: String(row.reason_code || ''),
        reason_code: String(row.reason_code || ''),
        sourceType: String(row.source_type || ''),
      })),
      count: productivity.listSuggestions().length,
    });
  });

  app.post('/api/productivity/ai/suggestions/:id/accept', (req, res) => {
    try {
      const row = productivity.getSuggestion(Number(req.params.id));
      if (!row) return res.status(404).json({ code: 'NOT_FOUND', message: '建议不存在' });
      if (String(row.status) === 'accepted') {
        return res.json({ ok: true, idempotent: true, todoId: row.todo_id || null });
      }
      const actionIdentity = String(row.action_identity || '');
      const existing = actionIdentity ? productivity.findByActionIdentity(actionIdentity) : [];
      let todoId: number;
      if (existing.length === 1 && typeof existing[0].id === 'number') {
        todoId = existing[0].id as number;
      } else {
        todoId = productivity.insertAiTodo({
          title: String(row.title || '待办'),
          reason: String(row.reason_code || 'ai_suggestion'),
          priority: String(row.priority || 'medium'),
          estimatedMinutes: 60,
          confidence: Number(row.confidence || 0),
          reasonCode: String(row.reason_code || 'ai_suggestion'),
          actionIdentity,
          actionOwner: String(row.owner || 'unclear'),
          sourceType: String(row.source_type || 'feishu_message'),
          sourceOccurredAt: row.source_occurred_at ? String(row.source_occurred_at) : null,
        });
      }
      productivity.setSuggestionStatus(Number(row.id), 'accepted');
      res.json({ ok: true, todoId });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/productivity/ai/suggestions/:id/reject', (req, res) => {
    const row = productivity.getSuggestion(Number(req.params.id));
    if (!row) return res.status(404).json({ code: 'NOT_FOUND', message: '建议不存在' });
    productivity.setSuggestionStatus(Number(row.id), 'rejected');
    res.json({ ok: true });
  });

  app.get('/api/productivity/agenda', async (req, res) => {
    try {
      const timezone = resolveTimeZone(String(req.query.timezone || ''));
      const range = defaultAgendaRange(new Date(), timezone);
      const from = req.query.from ? new Date(String(req.query.from)) : range.from;
      const to = req.query.to ? new Date(String(req.query.to)) : range.to;
      if (!maxSpanOk(from, to)) {
        throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AGENDA_COVERAGE, '查询区间超出允许的最大窗口');
      }
      const events = loadAgendaViews(from.toISOString(), to.toISOString());
      const { busyStatus, coverageError } = serverBusyIntervals(from.toISOString(), to.toISOString(), timezone);
      const calendar = inspectCalendarReadable(timezone);
      res.json({
        timezone,
        from: from.toISOString(),
        to: to.toISOString(),
        events,
        write: false,
        busyStatus,
        coverageError: coverageError || null,
        calendar: {
          available: calendar.available,
          permission: calendar.permission,
          windowStatus: calendar.windowStatus,
          errorCode: calendar.errorCode,
          busyStatus: calendar.busyStatus,
          helperVersion: calendar.helperVersion,
          helperBuildId: calendar.helperBuildId,
          needsReconnect: calendar.needsReconnect,
          itemsRead: calendar.itemsRead,
          statusLabel: calendar.statusLabel,
          hint: calendar.hint,
        },
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/productivity/dashboard', async (req, res) => {
    try {
      const timezone = resolveTimeZone(String(req.query.timezone || ''));
      const range = defaultAgendaRange(new Date(), timezone);
      const from = range.from.toISOString();
      const to = range.to.toISOString();
      const events = loadAgendaViews(from, to);
      const { busy, busyStatus, coverageError } = serverBusyIntervals(from, to, timezone);
      const cfg = getDeepseekRuntimeConfig();
      res.json({
        timezone,
        from,
        to,
        events,
        busyStatus,
        coverageError: coverageError || null,
        busyCount: busy.length,
        tasks: getTodos().map(mapTodoRow),
        connectors: await getConnectorStatuses(),
        ai: { configured: cfg.configured, enabled: getSettings().aiAnalysisEnabled === true, model: cfg.model, lastRun: productivity.latestAiRun() || null },
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/productivity/today-overview', (req, res) => {
    try {
      const timezone = resolveTimeZone(String(req.query.timezone || ''));
      const date = req.query.date ? String(req.query.date) : undefined;
      res.json(queryTodayOverview({ date, timezone }));
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/productivity/day-plans/today', (req, res) => {
    try {
      const timezone = resolveTimeZone(String(req.query.timezone || ''));
      const date = req.query.date ? String(req.query.date) : undefined;
      const plan = getTodayDayPlan({ date, timezone });
      res.json({ plan, write: false });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/productivity/day-plans', async (req, res) => {
    try {
      const timezone = resolveTimeZone(String(req.body?.timezone || ''));
      const date = req.body?.date ? String(req.body.date) : undefined;
      const plan = await createTodayDayPlan({
        date,
        timezone,
        syncIfStale: req.body?.syncIfStale !== false,
        mode: 'ai',
      });
      res.json({
        plan,
        write: false,
        commitPreview: dayPlanCommitPreview(plan),
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/productivity/day-plans/today/commit', (req, res) => {
    void req;
    try {
      refuseExternalCommit();
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/productivity/calendar/connect', async (_req, res) => {
    try {
      const result = await syncAppleAgenda({ requestAccess: true, persist: true });
      recordCalendarConnectorRound({
        ok: result.ok,
        events: result.ok ? result.events.length : 0,
        busyStatus: result.busyStatus,
        permission: result.permission,
        helperVersion: result.helperVersion,
        errorCode: result.ok ? null : result.errorCode,
      });
      res.json({
        ok: result.ok,
        permission: result.permission,
        events: result.events.length,
        busyStatus: result.busyStatus,
        errorCode: result.errorCode,
        errorMessage: result.ok ? null : (result.errorMessage || 'Apple Calendar 未同步：需要完整访问权限'),
        helperVersion: result.helperVersion,
        helperBuildId: calendarHelperBuildId(),
        connectCopy: result.ok ? calendarConnectSuccessCopy(result.permission, result.events.length) : null,
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/productivity/legacy-ai-cleanup/preview', (_req, res) => {
    res.json(previewLegacyAiCleanup());
  });

  app.post('/api/productivity/legacy-ai-cleanup/commit', (req, res) => {
    try {
      const backupPath = path.join(path.dirname(DB_PATH), `workbench.legacy-cleanup.${Date.now()}.bak`);
      res.json(commitLegacyAiCleanup({
        confirmToken: String(req.body?.confirmToken || ''),
        confirmed: req.body?.confirmed === true,
        backupPath,
      }));
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/todos/:id/evidence', (req, res) => {
    const todo = getTodo(Number(req.params.id));
    if (!todo) return res.status(404).json({ code: 'NOT_FOUND', message: '待办不存在' });
    res.json({
      todo: mapTodoRow(todo),
      evidence: productivity.getEvidence(todo.id).map((row) => publicEvidenceDto(row as unknown as Record<string, unknown>)),
      actions: todoActionFlags({
        status: todo.status,
        lifecycleStatus: todo.lifecycle_status,
        autoScheduleEnabled: getSettings().autoScheduleEnabled === true,
        sourceReadonly: todo.source_readonly === 1,
        visibility: todo.visibility,
        sourceStatus: todo.source_status,
      }),
    });
  });

  app.post('/api/todos/:id/plan/preview', (req, res) => {
    try {
      const todo = getTodo(Number(req.params.id));
      if (!todo) return res.status(404).json({ code: 'NOT_FOUND', message: '待办不存在' });
      if (!canScheduleTodo(todo)) {
        throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.TODO_NOT_SCHEDULABLE, '当前状态不可排程');
      }
      const timezone = resolveTimeZone(String(req.body?.timezone || ''));
      const range = defaultAgendaRange(new Date(), timezone);
      const { busy, busyStatus, coverageError } = serverBusyIntervals(range.from.toISOString(), range.to.toISOString(), timezone);
      if (coverageError) {
        throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AGENDA_COVERAGE, '忙闲覆盖不完整，拒绝排程');
      }
      const plan = planTodos(
        [{ id: todo.id, title: todo.title, estimatedMinutes: todo.estimated_minutes || 60, priority: todo.priority, dueAt: todo.due_at }],
        busy,
        { ...DEFAULT_PLANNING_RULES, timezone }
      );
      res.json({ todo: mapTodoRow(todo), plan, write: false, busyStatus, timezone });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/todos/:id/plan/commit', (req, res) => {
    try {
      const day = req.body?.day ? new Date(req.body.day) : new Date();
      const from = new Date(day.getTime() - 12 * 3600 * 1000).toISOString();
      const to = new Date(day.getTime() + 36 * 3600 * 1000).toISOString();
      const { busyStatus } = serverBusyIntervals(from, to);
      if (busyStatus !== 'fresh') {
        throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.CALENDAR_BUSY_UNKNOWN, '忙闲未知，拒绝真实排程写入');
      }
      throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.EXTERNAL_WRITE_DISABLED, '本轮生产环境不执行日历写入');
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/todos/plan-day/preview', (req, res) => {
    try {
      const timezone = resolveTimeZone(String(req.body?.timezone || ''));
      const range = defaultAgendaRange(new Date(), timezone);
      const { busy, busyStatus, coverageError } = serverBusyIntervals(range.from.toISOString(), range.to.toISOString(), timezone);
      if (coverageError) {
        throw new ProductivityError(PRODUCTIVITY_ERROR_CODES.AGENDA_COVERAGE, '忙闲覆盖不完整，拒绝排程');
      }
      const rows = getTodos().filter((t) => canScheduleTodo(t));
      const plan = planTodos(
        rows.map((t) => ({
          id: t.id,
          title: t.title,
          estimatedMinutes: t.estimated_minutes || 60,
          priority: t.priority,
          dueAt: t.due_at,
        })),
        busy,
        { ...DEFAULT_PLANNING_RULES, timezone }
      );
      res.json({ plan, write: false, busyStatus, timezone });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/todos/plan-day/commit', (req, res) => {
    const settings = getSettings();
    if (settings.autoScheduleEnabled !== true && req.body?.confirmed !== true) {
      return sendError(res, new ProductivityError(PRODUCTIVITY_ERROR_CODES.EXTERNAL_WRITE_DISABLED, '未开启自动排程，且用户未确认写入日历'));
    }
    return sendError(res, new ProductivityError(PRODUCTIVITY_ERROR_CODES.EXTERNAL_WRITE_DISABLED, '批量日历写入需用户确认后仅允许写入「L叔工作台」'));
  });

  app.post('/api/todos/reconcile-completion', (req, res) => {
    if (req.body?.evidenceByTodoId || req.body?.evidence || req.body?.strength) {
      return sendError(res, new ProductivityError(PRODUCTIVITY_ERROR_CODES.CLIENT_EVIDENCE_REJECTED, '拒绝客户端提交的完成证据'));
    }
    const settings = getSettings();
    const results = getTodos().map((todo) => {
      if (todo.source_readonly === 1 || todo.origin_mode === 'structured') {
        return { todoId: todo.id, decision: 'unchanged' as const, confidence: 0, reason: 'readonly', evidence: [] };
      }
      const evidence = productivity.getEvidence(todo.id).map((row) => {
        const type = String(row.evidence_type || '');
        const strength: 'strong' | 'weak' = ['things_completed', 'feishu_task_done', 'user_complete', 'bound_delivery_plus_confirm'].includes(type)
          ? 'strong'
          : 'weak';
        return {
          type,
          strength,
          summary: String(row.summary || ''),
          sourceType: String(row.source_type || ''),
          fingerprint: String(row.fingerprint || ''),
        };
      }) as CompletionEvidence[];
      const source = todo.completion_source || '';
      const suppressed = source.startsWith('suppressed:') ? [source.replace('suppressed:', '')] : [];
      const decision = scoreCompletion(evidence);
      if (decision.decision === 'suspected_done') {
        updateTodo(todo.id, { lifecycle_status: 'suspected_done', completion_confidence: decision.confidence });
      } else if (shouldAutoComplete(decision, settings.autoCompleteEnabled === true, suppressed)) {
        updateTodo(todo.id, {
          lifecycle_status: 'completed',
          status: 'confirmed',
          completion_confidence: decision.confidence,
          completed_at: new Date().toISOString(),
          completion_source: decision.evidence[0]?.type || 'auto',
        });
      } else if (decision.decision === 'progress_only' && evidence.length) {
        productivity.addEvidence({
          todoId: todo.id,
          sourceType: evidence[0].sourceType || 'desktop',
          evidenceType: evidence[0].type,
          summary: evidence[0].summary,
        });
      }
      return { todoId: todo.id, ...decision };
    });
    res.json({ results, autoCompleteEnabled: settings.autoCompleteEnabled === true });
  });

  app.post('/api/todos/:id/complete', (req, res) => {
    try {
      const result = applyUserTodoAction(Number(req.params.id), 'complete');
      if (result.status !== 200) return res.status(result.status).json(result.body);
      const todo = getTodo(Number(req.params.id));
      if (todo) {
        productivity.addEvidence({
          todoId: todo.id,
          sourceType: 'manual',
          evidenceType: 'user_complete',
          summary: '用户在工作台手动完成',
        });
      }
      res.json(result.body);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/todos/:id/reopen', (req: Request, res) => {
    try {
      const todo = getTodo(Number(req.params.id));
      if (!todo) return res.status(404).json({ code: 'NOT_FOUND', message: '待办不存在' });
      const suppress = todo.source_fingerprint ? `suppressed:${todo.source_fingerprint}` : 'suppressed:user';
      const result = applyUserTodoAction(todo.id, 'reopen', { completion_source: suppress });
      if (result.status !== 200) return res.status(result.status).json(result.body);
      productivity.addEvidence({
        todoId: todo.id,
        sourceType: 'manual',
        evidenceType: 'user_reopen',
        summary: '用户撤销完成，同一证据不得立刻再次自动完成',
        payload: { suppressFingerprint: todo.source_fingerprint || '' },
      });
      res.json(result.body);
    } catch (e) {
      sendError(res, e);
    }
  });
}

export { redactText };
