/**
 * 共用的 prompt 构造 helper, 供 batch-executors 和 frame-image-plan 使用。
 * 所有函数从 batch-executors 的原私有实现直接迁移, 保持语义零变化。
 */

import {
  ensureProjectConsistency,
  renderCharacterLockRosterLine,
  type CharacterLock,
} from './character-consistency';
import { sanitizeFillLightPositiveMentions } from './content-sanitize';

export function truncate(value: any, n: number): string {
  const s = String(value || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function clean(value: any): string {
  return String(value || '').trim();
}

export function stringifyPromptValue(value: any): string {
  if (value == null || value === false) return '';
  if (Array.isArray(value)) {
    return value.map(stringifyPromptValue).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const preferred = [
      value.hex,
      value.name,
      value.label,
      value.value,
      value.description,
      value.detail,
    ]
      .filter(Boolean)
      .map((v) => String(v).trim())
      .filter(Boolean)
      .join(' ');
    if (preferred) return preferred;
    return Object.entries(value)
      .filter(([, v]) => v != null && typeof v !== 'object')
      .map(([k, v]) => `${k}: ${String(v).trim()}`)
      .filter(Boolean)
      .join(', ');
  }
  return String(value).trim();
}

export function joinPromptValues(values: any[]): string {
  return sanitizeFillLightPositiveMentions(
    values.map(stringifyPromptValue).filter(Boolean).join('; '),
  );
}

export function dedupeAssetsByIdentity<T extends Record<string, any>>(items: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items || []) {
    if (!item) continue;
    const key = String(item.characterId || item.id || item.name || item.role || '')
      .trim()
      .toLowerCase();
    if (!key) {
      out.push(item);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function buildCharacterLockRoster(
  project: any,
  charNames: Set<string>,
  language: 'en' | 'zh' = 'zh',
  contextText = '',
): string {
  const withConsistency = ensureProjectConsistency(project || {}, { source: 'migration' });
  const locks: CharacterLock[] = Array.isArray(withConsistency.consistency?.characters)
    ? withConsistency.consistency.characters
    : [];
  const lines: string[] = [];
  for (const lock of locks) {
    const names = [lock.canonicalName, ...lock.aliases].filter(Boolean);
    const mentioned = names.some((name) => charNames.has(name) || contextText.includes(name));
    if (!mentioned) continue;
    lines.push(renderCharacterLockRosterLine(lock, language));
  }
  return lines.join('\n');
}

export function buildObservedDriftGuardrails(contextText: string): string {
  const text = String(contextText || '');
  const lines: string[] = [];
  if (text.includes('唐僧')) {
    lines.push(
      '- 唐僧 must remain a clean young monk in plain white robe plus reddish kasaya; NO large dharma crown, NO golden crown, NO ornate headpiece, NO royal headdress.',
    );
  }
  if (text.includes('猪八戒')) {
    lines.push(
      '- 猪八戒 must wear blue-gray coarse monk clothing with the robe closed over the torso; keep the costume complete and modest, never drifting into an open-front outfit.',
    );
  }
  if (text.includes('孙悟空')) {
    lines.push(
      '- 孙悟空 keeps a simple forehead golden band/hoop only; NO ornate crown, NO upgraded royal headpiece, NO large decorative crest.',
    );
  }
  if (/冷雾山林石径|山林|石径|取经路/.test(text)) {
    lines.push(
      '- 山林石径 stays outdoors in a misty forest stone path; NO indoor room, NO wooden window frame, NO hut interior, NO shed framing, NO cabin wall.',
    );
  }
  if (!lines.length) return '';
  return ['\nOBSERVED DRIFT GUARDRAILS:', ...lines].join('\n');
}
