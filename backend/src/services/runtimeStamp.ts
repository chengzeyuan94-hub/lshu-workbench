import { AI_PROMPT_VERSION, AI_SCHEMA_VERSION } from './aiAnalysisSchema';

export const TODO_HUB_VERSION = 'todo-hub-v4';
export const APP_VERSION = '0.1.0';

function sourceFingerprint(): string {
  const raw = String(process.env.WORKBENCH_SOURCE_FINGERPRINT || '').trim();
  return raw || 'dev-untracked';
}

export function workbenchRuntimeStamp(): {
  appVersion: string;
  buildId: string;
  promptVersion: string;
  schemaVersion: string;
  hubVersion: string;
  sourceFingerprint: string;
} {
  const fingerprint = sourceFingerprint();
  return {
    appVersion: APP_VERSION,
    buildId: `${TODO_HUB_VERSION}:${AI_SCHEMA_VERSION}:${AI_PROMPT_VERSION}:${fingerprint}`,
    promptVersion: AI_PROMPT_VERSION,
    schemaVersion: AI_SCHEMA_VERSION,
    hubVersion: TODO_HUB_VERSION,
    sourceFingerprint: fingerprint,
  };
}
