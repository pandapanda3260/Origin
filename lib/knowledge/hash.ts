import { createHash } from 'node:crypto';

type Jsonish =
  | null
  | string
  | number
  | boolean
  | Jsonish[]
  | { [key: string]: Jsonish };

export function stableKnowledgeValue(value: unknown): Jsonish {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => stableKnowledgeValue(item));
  if (typeof value === 'object') {
    const out: Record<string, Jsonish> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (typeof item === 'undefined') continue;
      out[key] = stableKnowledgeValue(item);
    }
    return out;
  }
  return String(value);
}

export function stableKnowledgeStringify(value: unknown): string {
  return JSON.stringify(stableKnowledgeValue(value));
}

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(stableKnowledgeStringify(value)).digest('hex');
}

export function shortKnowledgeHash(value: unknown, length = 16): string {
  return sha256Hex(value).slice(0, length);
}
