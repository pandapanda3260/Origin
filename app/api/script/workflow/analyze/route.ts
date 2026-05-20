import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';
import { buildScriptAnalysisMessages } from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ScriptAnalysis = {
  schemaVersion: 'v1';
  sourceHash: string;
  generatedAt: string;
  status?: 'ready' | 'degraded';
  lastError?: string;
  stats: {
    chars: number;
    estimatedDurationSec: number;
    dialogueLines: number;
    segmentCount: number;
  };
  core: {
    logline: string;
    conflict: string;
    audiencePromise: string;
  };
  pacing: Array<{
    label: string;
    emotion: string;
    intensity: number;
    pacing: string;
    note: string;
  }>;
  characters: Array<{
    name: string;
    role: string;
    desire: string;
    pressure: string;
  }>;
  keyBeats: Array<{
    title: string;
    detail: string;
  }>;
  notes: string[];
};

function shortText(value: any, fallback: string, maxLen: number): string {
  const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function scriptSourceHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return `${text.length}:${hash >>> 0}`;
}

function scriptLines(text: string): string[] {
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function countDialogueLines(lines: string[]): number {
  return lines.filter((line) => /^[^：:]{1,14}[：:]/.test(line) || /[“"][^”"]+[”"]/.test(line)).length;
}

function stripSpeaker(line: string): string {
  return line.replace(/^[^：:]{1,14}[：:]/, '').trim();
}

function fallbackRawAnalysis(scriptText: string) {
  const lines = scriptLines(scriptText);
  const first = lines[0] || '';
  const conflict = lines.find((line) => /却|但是|突然|发现|必须|危机|冲突|反转|争|评|怼|抢/.test(line)) || lines[1] || first;
  const promise = lines.find((line) => /最后|终于|原来|结果|反转|真相|高潮|发现|记录|节目组/.test(line)) || lines[lines.length - 1] || first;
  const speakers = Array.from(new Set(lines.map((line) => {
    const match = line.match(/^([^：:]{1,14})[：:]/);
    return match ? match[1].replace(/[【】\[\]（()]/g, '').trim() : '';
  }).filter(Boolean))).slice(0, 5);
  const beats = lines.filter((line) => /突然|发现|原来|最后|终于|反转|真相|危机|高潮|决定|必须|记录|节目组/.test(line)).slice(0, 4);
  return {
    core: {
      logline: stripSpeaker(first),
      conflict: stripSpeaker(conflict),
      audiencePromise: stripSpeaker(promise),
    },
    pacing: [],
    characters: speakers.map((name) => ({
      name,
      role: '主要出场角色',
      desire: '围绕主冲突推进选择',
      pressure: '受到关系和反转压力牵引',
    })),
    keyBeats: (beats.length ? beats : lines.slice(0, 4)).map((line, idx) => ({
      title: ['开场钩子', '冲突升级', '关键转折', '收束回响'][idx] || `看点 ${idx + 1}`,
      detail: stripSpeaker(line),
    })),
    notes: ['模型分析暂不可用，当前展示本地摘要。'],
  };
}

function normalizeArray<T>(value: any, limit: number, mapItem: (item: any, idx: number) => T): T[] {
  return (Array.isArray(value) ? value : []).slice(0, limit).map(mapItem);
}

function normalizeAnalysis(raw: any, scriptText: string, durationSec?: number | null): ScriptAnalysis {
  const lines = scriptLines(scriptText);
  const core = raw?.core || {};
  const pacing = normalizeArray(raw?.pacing, 5, (item, idx) => ({
    label: shortText(item?.label, ['铺垫', '升温', '高潮', '回落', '余韵'][idx] || `段落 ${idx + 1}`, 12),
    emotion: shortText(item?.emotion, ['setup', 'rising', 'climax', 'falling', 'resolution'][idx] || 'setup', 16),
    intensity: clampInt(item?.intensity, 1, 5, 3),
    pacing: shortText(item?.pacing, 'steady', 16),
    note: shortText(item?.note, '节奏说明待补充', 52),
  }));
  return {
    schemaVersion: 'v1',
    sourceHash: scriptSourceHash(scriptText),
    generatedAt: new Date().toISOString(),
    stats: {
      chars: scriptText.length,
      estimatedDurationSec: durationSec ? clampInt(durationSec, 1, 3600, 30) : Math.max(15, Math.round(scriptText.length / 4.2)),
      dialogueLines: countDialogueLines(lines),
      segmentCount: pacing.length || Math.min(5, Math.max(1, Math.ceil(lines.length / 4))),
    },
    core: {
      logline: shortText(core.logline, lines[0] || '剧本核心待分析', 80),
      conflict: shortText(core.conflict, '主冲突待分析', 80),
      audiencePromise: shortText(core.audiencePromise, '观众期待点待分析', 80),
    },
    pacing,
    characters: normalizeArray(raw?.characters, 5, (item) => ({
      name: shortText(item?.name, '未命名', 16),
      role: shortText(item?.role, '主要角色', 24),
      desire: shortText(item?.desire, '目标待分析', 28),
      pressure: shortText(item?.pressure, '阻力待分析', 28),
    })),
    keyBeats: normalizeArray(raw?.keyBeats, 5, (item, idx) => ({
      title: shortText(item?.title, `看点 ${idx + 1}`, 12),
      detail: shortText(item?.detail, '关键剧情点待分析', 64),
    })),
    notes: normalizeArray(raw?.notes, 3, (item) => shortText(item, '阅读提醒待补充', 52)),
  };
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const scriptText: string = (body.script || body.scriptText || '').toString();
  const durationSec: number | undefined = body.durationSec;

  const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const finalScript = (scriptText || (proj as any)?.scriptDraft || (proj as any)?.script || '').trim();
  if (!finalScript) return jsonError('当前没有剧本可分析', 400);

  let rawAnalysis: any = null;
  let analysisError = '';
  try {
    rawAnalysis = await chatCompleteJsonWithRetry(
      user,
      buildScriptAnalysisMessages({
        scriptText: finalScript,
        totalDurationSec: durationSec || (proj as any)?.scriptTargetDurationSec,
        styleBible: (proj as any)?.styleBible || null,
        emotionSegments: (proj as any)?.emotionSegments || (proj as any)?.emotions || [],
      }),
      { temperature: 0.35, maxTokens: 3000, modelRole: 'structured' },
      (raw) => parseJsonLoose(raw),
      'script.analysis',
    );
  } catch (e: any) {
    analysisError = (e?.message || String(e)).slice(0, 180);
    console.error('[analyze] model call failed:', e?.message || String(e));
    rawAnalysis = fallbackRawAnalysis(finalScript);
  }

  const scriptAnalysis = normalizeAnalysis(rawAnalysis, finalScript, durationSec || (proj as any)?.scriptTargetDurationSec);
  scriptAnalysis.status = analysisError ? 'degraded' : 'ready';
  if (analysisError) scriptAnalysis.lastError = analysisError;
  if (projectId && proj && scriptAnalysis.status === 'ready') {
    updateProjectForUser(projectId, user.id, { scriptAnalysis });
  }

  return jsonOk({
    scriptAnalysis,
    scriptAnalysisStatus: scriptAnalysis.status,
    scriptAnalysisError: analysisError,
  });
}
