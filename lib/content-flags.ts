import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { scanSensitiveText } from './sensitive-keywords';
export { scanSensitiveText, type SensitiveHit } from './sensitive-keywords';

export type ContentFlagSourceType = 'text' | 'image' | 'video';
export type ContentFlagSeverity = 'low' | 'medium' | 'high';

const HIDDEN_CACHE_TTL_MS = 30_000;

let hiddenCache:
  | {
      expiresAt: number;
      sources: Set<string>;
    }
  | null = null;

export function recordContentFlag(opts: {
  ownerId: number;
  projectId?: string | null;
  sourceType: ContentFlagSourceType;
  sourceId: string;
  rawExcerpt: string;
  scanReason: string;
  severity?: ContentFlagSeverity;
}) {
  if (!opts.ownerId || !opts.sourceId) return null;
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO content_flags
        (id, owner_id, project_id, source_type, source_id, raw_excerpt, scan_reason, severity, status)
       VALUES
        (@id, @ownerId, @projectId, @sourceType, @sourceId, @rawExcerpt, @scanReason, @severity, 'pending')`,
    )
    .run({
      id,
      ownerId: opts.ownerId,
      projectId: opts.projectId || null,
      sourceType: opts.sourceType,
      sourceId: opts.sourceId,
      rawExcerpt: String(opts.rawExcerpt || '').slice(0, 1000),
      scanReason: String(opts.scanReason || '').slice(0, 500),
      severity: opts.severity || 'medium',
    });
  return id;
}

export function recordTextFlagIfSensitive(opts: {
  ownerId: number;
  projectId?: string | null;
  sourceId: string;
  text: string;
  reasonPrefix?: string;
}) {
  const hits = scanSensitiveText(opts.text);
  if (!hits.length) return null;
  return recordContentFlag({
    ownerId: opts.ownerId,
    projectId: opts.projectId,
    sourceType: 'text',
    sourceId: opts.sourceId,
    rawExcerpt: opts.text,
    scanReason: `${opts.reasonPrefix || 'sensitive_keyword'}:${hits.map((hit) => hit.term).join(',')}`,
    severity: hits.length > 2 ? 'high' : 'medium',
  });
}

export function invalidateContentFlagVisibilityCache() {
  hiddenCache = null;
}

export function isContentSourceHidden(sourceType: ContentFlagSourceType | string, sourceId: string) {
  if (!sourceType || !sourceId) return false;
  return hiddenSourceSet().has(sourceKey(sourceType, sourceId));
}

export function projectHiddenContentReferences(project: unknown) {
  const hidden = hiddenSourceSet();
  if (!hidden.size) return [];

  const stringValues = new Set<string>();
  const visit = (value: unknown) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      stringValues.add(value);
      const imageMatch = /\/api\/images\/file\/([a-zA-Z0-9-]+)/.exec(value);
      if (imageMatch) stringValues.add(`image:${imageMatch[1]}`);
      const videoMatch = /\/api\/videos\/file\/([a-zA-Z0-9-]+)/.exec(value);
      if (videoMatch) stringValues.add(`video:${videoMatch[1]}`);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };
  visit(project);

  const hits: Array<{ sourceType: string; sourceId: string }> = [];
  for (const entry of hidden) {
    const [sourceType, sourceId] = entry.split(':', 2);
    if (stringValues.has(entry) || stringValues.has(sourceId)) {
      hits.push({ sourceType, sourceId });
    }
  }
  return hits;
}

function hiddenSourceSet() {
  const now = Date.now();
  if (hiddenCache && hiddenCache.expiresAt > now) return hiddenCache.sources;
  const rows = getDb()
    .prepare<[], { source_type: string; source_id: string }>(
      `SELECT source_type, source_id
         FROM content_flags
        WHERE status = 'hidden'
          AND source_id IS NOT NULL
          AND source_id <> ''`,
    )
    .all();
  const sources = new Set(rows.map((row) => sourceKey(row.source_type, row.source_id)));
  hiddenCache = { sources, expiresAt: now + HIDDEN_CACHE_TTL_MS };
  return sources;
}

function sourceKey(sourceType: string, sourceId: string) {
  return `${String(sourceType || '').trim()}:${String(sourceId || '').trim()}`;
}
