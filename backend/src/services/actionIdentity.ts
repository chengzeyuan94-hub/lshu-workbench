import { sha256, normalizeTitle } from './hash';

export const ACTION_IDENTITY_VERSION = 'v4-semantic-1';

const ACTION_VERBS: Array<[RegExp, string]> = [
  [/^(提供|发送|发给|发)/, 'provide'],
  [/^(回复|答复)/, 'reply'],
  [/^(安排|规划)/, 'arrange'],
  [/^(确认|核实)/, 'confirm'],
  [/^(准备|整理)/, 'prepare'],
  [/^(制作|产出)/, 'make'],
  [/^(发布|发表)/, 'publish'],
  [/^(推进|跟进)/, 'advance'],
  [/^(同步|更新)/, 'sync'],
  [/^(登录)/, 'login'],
  [/^(联系|沟通)/, 'contact'],
  [/^(提交|交付)/, 'submit'],
  [/^(完成|处理)/, 'complete'],
];

const OBJECT_SUFFIXES = [
  '选题链接', '微信二维码', '二维码', '朋友圈', '课程讲义', '项目摘要',
  '物品运回', '运回', '链接', '账号', '初稿', '材料',
];

/**
 * Deterministic, deliberately small normalizer for an action's object wording.
 * It removes presentation-only differences while retaining people, dates and
 * project names. Owner and due-time are separate identity dimensions below.
 */
export function normalizeActionObject(hint: string): string {
  return normalizeTitle(String(hint || ''))
    .replace(/^(请你?|麻烦你?|帮我|帮忙|需要|务必|记得|尽快)+/u, '')
    .replace(/微信(?=二维码)/gu, '')
    .replace(/(频道|领域)(?=.{0,8}选题)/gu, '赛道')
    .replace(/(?:两|二|2)(?:到|至|-)(?:三|3)条/gu, '')
    .replace(/[一二三四五六七八九十\d]+条(?=选题|链接)/gu, '')
    .replace(/的/gu, '')
    .slice(0, 80);
}

function actionVerb(value: string): string {
  const pair = ACTION_VERBS.find(([pattern]) => pattern.test(value));
  return pair?.[1] || value.slice(0, 2);
}

function objectSuffix(value: string): string {
  return OBJECT_SUFFIXES.find((suffix) => value.endsWith(normalizeActionObject(suffix))) || value.slice(-2);
}

function charSet(value: string): Set<string> {
  return new Set(Array.from(value));
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const token of a) if (b.has(token)) n += 1;
  return n;
}

/**
 * Conservative local similarity check used only after source/day/owner/due
 * have matched. It handles minor model paraphrases without relying on another
 * model call. Different leading actions or object suffixes never merge.
 */
export function areSemanticallyEquivalentActions(left: string, right: string): boolean {
  const a = normalizeActionObject(left);
  const b = normalizeActionObject(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (actionVerb(a) !== actionVerb(b) || objectSuffix(a) !== objectSuffix(b)) return false;

  const latinA = a.match(/[a-z]+|\d+(?:\.\d+)?/gu) || [];
  const latinB = b.match(/[a-z]+|\d+(?:\.\d+)?/gu) || [];
  if (latinA.length && latinB.length && latinA.join('|') !== latinB.join('|')) return false;

  const setA = charSet(a);
  const setB = charSet(b);
  const common = intersectionSize(setA, setB);
  const union = setA.size + setB.size - common;
  const jaccard = union ? common / union : 0;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  const contained = a.includes(b) || b.includes(a);
  return (contained && shorter >= 6 && shorter / longer >= 0.55) || (common >= 6 && jaccard >= 0.62);
}

export function normalizeActionDue(dueAt: string | null | undefined): string {
  const value = String(dueAt || '').trim();
  if (!value) return 'no_due';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

/** Stable subject identity: no full title, due, or create/update/complete intent. */
export function actionSubjectKey(hint: string): string {
  return normalizeActionObject(hint);
}

export function buildActionIdentity(input: {
  sourceNamespace: 'feishu_message' | 'desktop';
  objectHint: string;
  sourceLocalDate: string;
  owner: string;
  dueAt?: string | null;
  project?: string | null;
}): string {
  return sha256(
    ACTION_IDENTITY_VERSION,
    input.sourceNamespace,
    input.sourceLocalDate,
    input.owner,
    normalizeActionDue(input.dueAt),
    normalizeTitle(String(input.project || '')),
    actionSubjectKey(input.objectHint)
  );
}
