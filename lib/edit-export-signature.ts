import { createHash } from 'node:crypto';

export type EditExportSignatureItem = {
  clipId: string;
  inSec: number;
  outSec: number;
  groupIdx: number | null;
  transitionInType: string;
};

export type EditExportSignatureFormat = {
  ratio?: string;
  size?: string;
  width?: number;
  height?: number;
};

function stableStringify(value: any): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function roundSec(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const rounded = Math.round(Math.max(0, n) * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function cleanTransitionType(value: unknown): string {
  return String(value || 'cut').trim().toLowerCase() || 'cut';
}

function cleanGroupIdx(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

export function buildEditExportSignaturePayload(args: {
  items: EditExportSignatureItem[];
  bgmId?: string | null;
  bgmEnabled?: boolean;
  bgmOffsetTime?: number;
  exportFormat?: EditExportSignatureFormat | null;
}) {
  const bgmEnabled = args.bgmEnabled === true;
  const bgmId = bgmEnabled ? String(args.bgmId || '').trim() : '';
  const format = args.exportFormat || {};

  return {
    version: 1,
    exportFormat: {
      ratio: String(format.ratio || ''),
      size: String(format.size || ''),
      width: Number(format.width) || 0,
      height: Number(format.height) || 0,
    },
    items: (Array.isArray(args.items) ? args.items : []).map((item) => ({
      clipId: String(item?.clipId || '').trim(),
      groupIdx: cleanGroupIdx(item?.groupIdx),
      inSec: roundSec(item?.inSec),
      outSec: roundSec(item?.outSec),
      transitionInType: cleanTransitionType(item?.transitionInType),
    })),
    bgm: {
      enabled: bgmEnabled && !!bgmId,
      trackId: bgmId,
      offsetTime: bgmId ? roundSec(args.bgmOffsetTime) : 0,
    },
  };
}

export function computeEditExportSignatureFromParts(args: {
  items: EditExportSignatureItem[];
  bgmId?: string | null;
  bgmEnabled?: boolean;
  bgmOffsetTime?: number;
  exportFormat?: EditExportSignatureFormat | null;
}) {
  const payload = buildEditExportSignaturePayload(args);
  const digest = createHash('sha256').update(stableStringify(payload)).digest('hex');
  return `edit-export-v1:${digest}`;
}
