export const SENSITIVE_KEYWORDS = [
  'nude', 'naked', 'sex', 'gore', 'blood', 'kill', 'murder', 'suicide',
  '裸', '色情', '血腥', '杀', '自杀',
];

export type SensitiveHit = { term: string; index: number };

export function scanSensitiveText(text: string): SensitiveHit[] {
  const source = String(text || '');
  const lower = source.toLowerCase();
  const hits: SensitiveHit[] = [];
  for (const term of SENSITIVE_KEYWORDS) {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0) hits.push({ term, index });
  }
  return hits;
}
