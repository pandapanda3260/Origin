import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 把视频提示词解析成 { segments: [{time, text}], motionTags, sensitiveHits }
 *
 * 支持两种格式：
 *   1. 中文结构化段落（运镜系统/角色/场景/0-3s/3-5s/基调/约束/音障）— 现行格式
 *   2. 旧的 [CAMERA]/[STYLE]/... 英文段落 — 兼容
 *   3. 都没有就整段一段
 *
 * 此处用纯启发式（正则 + 关键词），无需 LLM。
 */

// 中文段落标题（必须独立成行）
const CN_SECTION_LABELS = [
  '运镜系统', '角色', '场景', '基调', '约束', '音障', '音效',
];
// 时间段标签（0-3s / 3-5s / 5-10s 等）
const TIME_SECTION_RE = /^\s*(\d+)\s*[-–~]\s*(\d+)\s*s\s*$/;

// 老的英文段标签
const EN_SECTION_RE = /^\s*\[(CAMERA|STYLE|CONSTRAINTS|AUDIO|SCENE)\]/i;

const MOTION_KEYWORDS = [
  // 中文
  '推近', '推进', '缓慢推进', '轻微推近', '快速推进',
  '拉远', '缓慢拉远', '快速拉远',
  '左移', '右移', '上移', '下移',
  '跟随', '环绕', '摇镜头', '手持轻晃', '升降', '甩镜头', '固定镜头',
  // 英文
  'push-in', 'pull-back', 'pan', 'tilt', 'tracking', 'dolly', 'zoom-in', 'zoom-out',
  'orbit', 'aerial', 'handheld', 'slow-motion', 'pov', 'static', 'crane',
];

const SENSITIVE_KEYWORDS = [
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

/**
 * 把整段 prompt 按"标题行"切成 segments：
 *   - 中文小节标题（运镜系统/角色/场景/基调/约束/音障）
 *   - 时间段标签（0-3s / 3-5s / 5-10s）
 *   - 老的英文 [CAMERA]/[STYLE]/... 段
 */
function splitIntoSegments(text: string) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  type Section = { time: string; lines: string[] };
  const sections: Section[] = [];
  let cur: Section | null = null;

  const flush = () => {
    if (cur && (cur.time || cur.lines.length)) sections.push(cur);
    cur = null;
  };

  const pushHeader = (title: string) => {
    flush();
    cur = { time: title, lines: [] };
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      // 空行不切段，但要保留到当前段落（保持视觉换行）
      if (cur) cur.lines.push('');
      continue;
    }

    // 中文段落标题（整行就是一个标题词）
    if (CN_SECTION_LABELS.includes(trimmed)) {
      pushHeader(trimmed);
      continue;
    }

    // 时间段标签 0-3s / 3-5s
    const tm = trimmed.match(TIME_SECTION_RE);
    if (tm) {
      pushHeader(`${tm[1]}-${tm[2]}s`);
      continue;
    }

    // 老的英文 [CAMERA] / [STYLE] / [CONSTRAINTS] / [AUDIO] 段
    const en = trimmed.match(EN_SECTION_RE);
    if (en) {
      pushHeader(en[1].toUpperCase());
      // 有些情况 [CAMERA] 和后续描述同一行，要把后半段也存
      const rest = trimmed.replace(EN_SECTION_RE, '').trim();
      if (rest && cur) cur.lines.push(rest);
      continue;
    }

    if (!cur) cur = { time: '', lines: [] };
    cur.lines.push(trimmed);
  }
  flush();

  // 如果一个 section 都没切出来（纯整段文本），就一段
  if (!sections.length) {
    return [{ time: '', text: text.trim() }];
  }

  return sections.map((s) => ({
    time: s.time,
    text: s.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  })).filter((s) => s.text || s.time);
}

function collectMotionTags(text: string) {
  const hits = new Set<string>();
  const lower = text.toLowerCase();
  for (const k of MOTION_KEYWORDS) {
    const target = k.toLowerCase();
    if (lower.includes(target) || text.includes(k)) hits.add(k);
  }
  return Array.from(hits);
}

function collectSensitive(text: string) {
  const lower = text.toLowerCase();
  const hits: { word: string; index: number }[] = [];
  for (const k of SENSITIVE_KEYWORDS) {
    const i = lower.indexOf(k.toLowerCase());
    if (i >= 0) hits.push({ word: k, index: i });
  }
  return hits;
}
