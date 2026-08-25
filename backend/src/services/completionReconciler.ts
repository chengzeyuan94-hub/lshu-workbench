export interface CompletionEvidence {
  type: string;
  strength: 'strong' | 'weak';
  summary: string;
  sourceType?: string;
  fingerprint?: string;
}

export interface CompletionDecision {
  decision: 'completed' | 'suspected_done' | 'progress_only' | 'unchanged';
  confidence: number;
  evidence: CompletionEvidence[];
  reason: string;
}

const STRONG_TYPES = new Set(['things_completed', 'feishu_task_done', 'user_complete', 'bound_delivery_plus_confirm']);
const WEAK_TYPES = new Set(['file_changed', 'chat_done_ambiguous', 'calendar_block_ended', 'meeting_ended']);

export function scoreCompletion(evidence: CompletionEvidence[]): CompletionDecision {
  const strong = evidence.filter((e) => e.strength === 'strong' || STRONG_TYPES.has(e.type));
  const weak = evidence.filter((e) => e.strength === 'weak' || WEAK_TYPES.has(e.type));
  let confidence = 0;
  if (strong.some((e) => e.type === 'user_complete' || e.type === 'things_completed')) confidence = 0.95;
  else if (strong.length >= 1 && weak.length >= 1) confidence = 0.91;
  else if (strong.length >= 1) confidence = 0.9;
  else if (weak.length >= 3) confidence = 0.72;
  else if (weak.length === 2) confidence = 0.68;
  else if (weak.length === 1) confidence = 0.4;
  if (weak.some((e) => e.type === 'calendar_block_ended' || e.type === 'meeting_ended') && strong.length === 0) {
    confidence = Math.min(confidence, 0.45);
  }
  if (confidence >= 0.9) {
    return { decision: 'completed', confidence, evidence, reason: '存在强完成证据' };
  }
  if (confidence >= 0.65) {
    return { decision: 'suspected_done', confidence, evidence, reason: '疑似完成，请确认' };
  }
  if (confidence > 0) {
    return { decision: 'progress_only', confidence, evidence, reason: '仅追加进展证据，不能完成' };
  }
  return { decision: 'unchanged', confidence: 0, evidence, reason: '没有新的完成信号' };
}

export function shouldAutoComplete(decision: CompletionDecision, autoCompleteEnabled: boolean, suppressedFingerprints: string[] = []): boolean {
  if (!autoCompleteEnabled) return false;
  if (decision.decision !== 'completed' || decision.confidence < 0.9) return false;
  const fps = decision.evidence.map((e) => e.fingerprint).filter(Boolean) as string[];
  if (fps.some((fp) => suppressedFingerprints.includes(fp))) return false;
  return true;
}
