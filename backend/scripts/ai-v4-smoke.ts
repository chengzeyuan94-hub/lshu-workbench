import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StandardizedItem } from '../src/connectors/types';

if (process.env.AI_V4_SMOKE_CONFIRM !== 'synthetic-only') {
  console.error('拒绝执行：请显式设置 AI_V4_SMOKE_CONFIRM=synthetic-only');
  process.exit(2);
}

await import('../src/bootstrapEnv');

const smokeDir = mkdtempSync(join(tmpdir(), 'lshu-ai-v4-smoke-'));
process.env.WORKBENCH_DATA_DIR = smokeDir;
process.env.DEEPSEEK_MAX_ITEMS_PER_RUN = '1';
process.env.DEEPSEEK_BATCH_SIZE = '1';
process.env.DEEPSEEK_MAX_RETRIES = '0';
process.env.DEEPSEEK_MAX_INPUT_CHARS = '3000';
process.env.DEEPSEEK_MAX_OUTPUT_TOKENS = '1200';

let db: { close: () => void } | null = null;
try {
  const [{ getDeepseekRuntimeConfig }, dbModule, analyzer, schema, runtime] = await Promise.all([
    import('../src/config/runtimeConfig'),
    import('../src/db'),
    import('../src/services/actionIntentAnalyzer'),
    import('../src/services/aiAnalysisSchema'),
    import('../src/services/runtimeStamp'),
  ]);
  db = dbModule.default;
  const config = getDeepseekRuntimeConfig();
  if (!config.configured) {
    console.error(JSON.stringify({ ok: false, code: 'AI_NOT_CONFIGURED' }));
    process.exitCode = 2;
  } else {
    dbModule.updateSettings({ aiAnalysisEnabled: true, timezone: 'Asia/Shanghai' });
    const now = new Date();
    const item: StandardizedItem = {
      sourceType: 'feishu_message',
      sourceExternalId: `synthetic-v4-smoke-${now.toISOString()}`,
      sourceFingerprint: 'synthetic-v4-smoke',
      title: '合成验收消息',
      summary: '请你在今天下班前整理一页项目进度摘要。',
      status: 'open',
      createdAt: now.toISOString(),
      payload: {
        chat_hash: 'synthetic-v4-smoke-chat',
        senderRole: 'other',
        atSelf: true,
        replyToSelf: false,
        chatType: 'p2p',
      },
    };
    const stats = await analyzer.analyzeUnstructuredSources([item], { aiEnabled: true, now });
    const latest = dbModule.productivity.latestAiRun();
    const latestStats = latest?.stats_json ? JSON.parse(String(latest.stats_json)) as Record<string, unknown> : {};
    const persisted = dbModule.default.prepare(
      `SELECT COUNT(*) AS todos,
              SUM(CASE WHEN inference_reason_code IS NOT NULL AND inference_reason_code != '' THEN 1 ELSE 0 END) AS reason_codes
       FROM todos WHERE origin_mode='ai'`
    ).get() as { todos: number; reason_codes: number };
    const review = dbModule.default.prepare(
      `SELECT COUNT(*) AS n FROM ai_action_suggestions WHERE status='open' AND reason_code IS NOT NULL AND reason_code != ''`
    ).get() as { n: number };
    const stamp = runtime.workbenchRuntimeStamp();
    const ok = stats.inputUnits === 1
      && stats.cacheHits === 0
      && stats.httpAttempts >= 1
      && stats.schemaSuccess >= 1
      && latestStats.promptVersion === schema.AI_PROMPT_VERSION
      && latestStats.schemaVersion === schema.AI_SCHEMA_VERSION
      && persisted.reason_codes + review.n >= 1;
    console.log(JSON.stringify({
      ok,
      runtime: stamp,
      model: config.model,
      inputUnits: stats.inputUnits,
      cacheHits: stats.cacheHits,
      invalidCacheEntries: stats.invalidCacheEntries,
      httpAttempts: stats.httpAttempts,
      schemaSuccess: stats.schemaSuccess,
      schemaFailedBatches: stats.schemaFailedBatches,
      actionable: stats.actionable,
      needsReview: stats.review,
      rejected: stats.rejected,
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      persistedReasonCodes: persisted.reason_codes,
      persistedNeedsReview: review.n,
    }));
    if (!ok) process.exitCode = 1;
  }
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || 'AI_SMOKE_FAILED') : 'AI_SMOKE_FAILED';
  console.error(JSON.stringify({ ok: false, code }));
  process.exitCode = 1;
} finally {
  db?.close();
  rmSync(smokeDir, { recursive: true, force: true });
}
