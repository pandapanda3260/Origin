import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 把 [CAMERA] / [STYLE] / [CONSTRAINTS] / [AUDIO] 段提示词解析成
 *   { segments: [{time, text, motionTags}], motionTags, sensitiveHits }
 *
 * 此处用纯启发式（正则 + 关键词），无需 LLM。
 */
const MOTION_KEYWORDS = [
  'push-in', 'pull-back', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'crane-up', 'crane-down',
  'tracking', 'dolly', 'zoom-in', 'zoom-out', 'orbit', 'aerial', 'handheld',
  'slow-motion', 'fast-motion', 'static', 'pov',
  '推', '拉', '摇', '跟', '航拍', '手持', '轨道', '固定机位',
];

const SENSITIVE_KEYWORDS = [
  // 这里放一份保守的占位列表；上线前根据合规要求扩展
  'nude', 'naked', 'sex', 'gore', 'blood',
  '裸', '色情', '血腥',
];

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const text: string = (body.text || body.prompt || '').toString();
  if (!text) return jsonOk({ segments: [], motionTags: [], sensitiveHits: [] });

  const segments = splitIntoSegments(text);
  const motionTags = collectMotionTags(text);
  const sensitiveHits = collectSensitive(text);

  return jsonOk({ segments, motionTags, sensitiveHits });
}

function splitIntoSegments(text: string) {
  // 按 "shot N:" 或 "镜头 N" 分段；若都没有则整段一段
  const re = /(^|\n)\s*(?:shot\s*(\d+)|镜头\s*(\d+))[\s:：-]+/gim;
  const indices: { idx: number; pos: number; n: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[2] || m[3]);
    if (!isNaN(n)) indices.push({ idx: indices.length, pos: m.index, n });
  }
  if (!indices.length) return [{ time: '', text: text.trim() }];
  const segs: { time: string; text: string }[] = [];
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].pos;
    const end = i + 1 < indices.length ? indices[i + 1].pos : text.length;
    segs.push({ time: `shot ${indices[i].n}`, text: text.slice(start, end).trim() });
  }
  return segs;
}

function collectMotionTags(text: string) {
  const lower = text.toLowerCase();
  const hits = new Set<string>();
  for (const k of MOTION_KEYWORDS) {
    if (lower.includes(k.toLowerCase())) hits.add(k);
  }
  return Array.from(hits);
}

function collectSensitive(text: string) {
  const lower = text.toLowerCase();
  const hits: { term: string; index: number }[] = [];
  for (const k of SENSITIVE_KEYWORDS) {
    const i = lower.indexOf(k.toLowerCase());
    if (i >= 0) hits.push({ term: k, index: i });
  }
  return hits;
}
