import { createHash } from 'node:crypto';
import {
  isEmptyScriptConsultState,
  normalizeScriptConsultState,
} from './script-consult-state';

export type ConsultContaminationInput = {
  id: string;
  title?: string;
  ownerId?: number;
  createdAt?: string;
  updatedAt?: string;
  data: any;
};

export type ConsultContaminationFinding = {
  projectId: string;
  title: string;
  ownerId: number | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  firstMessageLength: number;
  firstMessageHash: string;
  firstMessagePrefix: string;
  reasons: string[];
};

export type ConsultContaminationOptions = {
  accidentStartAt?: string;
  accidentEndAt?: string;
  duplicateHashes?: Set<string>;
  quickWindowMs?: number;
  largeTextChars?: number;
};

function normalizeTextForHash(value: any): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function scriptConsultMessageHash(value: any): string {
  return createHash('sha256').update(normalizeTextForHash(value)).digest('hex');
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

function parseTime(value: any): number | null {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function isBusinessEmpty(data: any): boolean {
  const script = String(data?.script || data?.scriptDraft || '').trim();
  const assets = data?.assets;
  const assetsEmpty = Array.isArray(assets)
    ? assets.length === 0
    : assets == null || (
      asArray(assets.characters).length === 0 &&
      asArray(assets.scenes).length === 0 &&
      asArray(assets.props).length === 0
    );
  return !script
    && assetsEmpty
    && asArray(data?.shots).length === 0
    && asArray(data?.storyboards).length === 0
    && asArray(data?.videoTasks).length === 0;
}

function isInAccidentWindow(createdAt: string, opts: ConsultContaminationOptions): boolean {
  const created = parseTime(createdAt);
  if (created == null) return false;
  const start = opts.accidentStartAt ? parseTime(opts.accidentStartAt) : null;
  const end = opts.accidentEndAt ? parseTime(opts.accidentEndAt) : null;
  if (start != null && created < start) return false;
  if (end != null && created > end) return false;
  return start != null || end != null;
}

export function inspectScriptConsultContamination(
  input: ConsultContaminationInput,
  opts: ConsultContaminationOptions = {},
): ConsultContaminationFinding | null {
  const data = input.data || {};
  const consult = normalizeScriptConsultState(data.scriptConsult);
  if (isEmptyScriptConsultState(consult)) return null;
  if (!isBusinessEmpty(data)) return null;
  if (!consult.messages.length) return null;

  const firstContent = String(consult.messages[0]?.content || '');
  const firstMessageHash = scriptConsultMessageHash(firstContent);
  const createdAt = String(input.createdAt || data.createdAt || '');
  const updatedAt = String(input.updatedAt || data.updatedAt || '');
  const createdMs = parseTime(createdAt);
  const startedMs = parseTime(consult.startedAt);
  const updatedMs = parseTime(updatedAt);
  const quickWindowMs = opts.quickWindowMs ?? 60_000;
  const largeTextChars = opts.largeTextChars ?? 200;
  const reasons: string[] = [];

  if (opts.duplicateHashes?.has(firstMessageHash)) reasons.push('duplicate_first_message_hash');
  if (startedMs != null && createdMs != null && startedMs < createdMs) reasons.push('started_before_created');
  const observedMs = startedMs ?? updatedMs;
  if (
    observedMs != null &&
    createdMs != null &&
    observedMs >= createdMs &&
    observedMs - createdMs <= quickWindowMs &&
    normalizeTextForHash(firstContent).length > largeTextChars
  ) {
    reasons.push('quick_large_consult_after_create');
  }

  const inWindow = isInAccidentWindow(createdAt, opts);
  if (!reasons.length) return null;
  if ((opts.accidentStartAt || opts.accidentEndAt) && !inWindow) return null;

  return {
    projectId: input.id,
    title: String(input.title || data.title || ''),
    ownerId: Number.isInteger(input.ownerId) ? Number(input.ownerId) : null,
    createdAt,
    updatedAt,
    messageCount: consult.messages.length,
    firstMessageLength: normalizeTextForHash(firstContent).length,
    firstMessageHash,
    firstMessagePrefix: normalizeTextForHash(firstContent).slice(0, 80),
    reasons,
  };
}
