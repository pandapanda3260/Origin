import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { buildAgentMessages } from '@/lib/prompts';
import { getProjectByIdForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AgentAction = Record<string, any>;

function readRefs(body: any): any[] {
  if (Array.isArray(body?.refs)) return body.refs;
  if (Array.isArray(body?.references)) return body.references;
  return [];
}

function readProjectId(body: any): string | undefined {
  const value = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
  return value || undefined;
}

function readClientProjectContext(body: any): any | null {
  const ctx = body?.projectContext;
  return ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : null;
}

function stripPatchLines(text: string): string {
  return text
    .replace(/[ \t]*\[PATCH\][^\r\n]*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 模型偶尔会把整段回复包成 {"reply":"...\n[PATCH]..."} 这类 JSON（与 COMMON_RULES 的
// JSON 输出要求冲突所致），导致 [PATCH] 被埋进 JSON 字符串里、无法按行解析。
// 这里把 JSON 外壳剥掉：replyText 用于展示，patchText 用于扫描 [PATCH]。
function collectStringValues(value: any, out: string[], depth = 0): void {
  if (value == null || depth > 2) return;
  if (typeof value === 'string') { out.push(value); return; }
  if (Array.isArray(value)) { value.forEach((v) => collectStringValues(v, out, depth + 1)); return; }
  if (typeof value === 'object') { Object.values(value).forEach((v) => collectStringValues(v, out, depth + 1)); }
}

function coerceAgentOutput(buf: string): { replyText: string; patchText: string } {
  const trimmed = buf.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const replyField = [parsed.reply, parsed.text, parsed.content, parsed.message]
          .find((v) => typeof v === 'string' && v.trim());
        const strings: string[] = [];
        collectStringValues(parsed, strings, 0);
        const patchText = strings.join('\n');
        return { replyText: (replyField as string) || patchText, patchText };
      }
    } catch {
      // 不是合法 JSON，按纯文本处理
    }
  }
  return { replyText: buf, patchText: buf };
}

function jsonPayloadFromPatch(line: string): any {
  const match = line.match(/\spayload=(.+)\s*$/);
  if (!match) return null;
  const raw = match[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function textValue(value: any): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function normalizeAssetField(field: string): string {
  const key = String(field || '').trim();
  const aliases: Record<string, string> = {
    outfit: 'clothing',
    costume: 'clothing',
    clothes: 'clothing',
    actions: 'actionTraits',
    action: 'actionTraits',
    traits: 'temperament',
  };
  return aliases[key] || key;
}

function actionsFromAssetPatch(assetType: string, assetIdx: number, payload: any): AgentAction[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const normalizedType = assetType === 'character' ? 'char' : assetType;
  if (!['char', 'scene', 'prop'].includes(normalizedType)) return [];
  const allowedByType: Record<string, Set<string>> = {
    char: new Set([
      'name', 'role', 'identity', 'gender', 'appearance', 'clothing', 'equipment',
      'temperament', 'actionTraits', 'description', 'entityType', 'appearanceMode', 'via',
      'crowdSize',
    ]),
    scene: new Set(['name', 'location', 'timeSetting', 'atmosphere', 'description', 'lighting', 'elements']),
    prop: new Set(['name', 'description', 'features', 'ownership', 'propType', 'function', 'visualFeatures']),
  };
  const actions: AgentAction[] = [];
  for (const [rawField, rawValue] of Object.entries(payload)) {
    const field = normalizeAssetField(rawField);
    const value = textValue(rawValue);
    if (!field || !value || !allowedByType[normalizedType].has(field)) continue;
    actions.push({
      type: 'updateAssetDesc',
      assetType: normalizedType,
      assetIdx,
      field,
      value,
    });
  }
  return actions;
}

function actionsFromPatchLine(line: string): AgentAction[] {
  const target = line.match(/\btarget=([^\s]+)/)?.[1] || '';
  const payload = jsonPayloadFromPatch(line);
  if (!target || payload == null) return [];

  const assetMatch = target.match(/^asset:(char|character|scene|prop):(\d+)$/);
  if (assetMatch) {
    return actionsFromAssetPatch(assetMatch[1], Number(assetMatch[2]), payload);
  }

  const shotMatch = target.match(/^shot:(\d+)$/);
  if (shotMatch && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return Object.entries(payload)
      .map(([field, value]) => ({ type: 'updateShot', shotIdx: Number(shotMatch[1]), field, value: textValue(value) }))
      .filter((action) => action.field && action.value);
  }

  const videoPromptMatch = target.match(/^videoPrompt:(\d+)$/);
  if (videoPromptMatch) {
    const value = typeof payload === 'string'
      ? payload
      : textValue(payload.value || payload.prompt || payload.content || payload.text);
    return value ? [{ type: 'updateVideoPrompt', groupIdx: Number(videoPromptMatch[1]), value }] : [];
  }

  if (target === 'script') {
    const value = typeof payload === 'string'
      ? payload
      : textValue(payload.value || payload.script || payload.content || payload.text);
    return value ? [{ type: 'updateScript', value }] : [];
  }

  return [];
}

function parseAgentPatches(text: string): { patches: any[]; actions: AgentAction[] } {
  const patchLines = (text.match(/\[PATCH\][^\r\n]*/g) || []).map((line) => line.trim());
  return {
    patches: patchLines.map((raw) => ({ raw })),
    actions: patchLines.flatMap(actionsFromPatchLine),
  };
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId = readProjectId(body);
  const userMsg: string = (body.message || body.text || '').toString();
  const refs = readRefs(body);
  if (!userMsg.trim()) {
    return new Response(JSON.stringify({ detail: '消息不能为空' }), { status: 400 });
  }
  const proj = projectId ? getProjectByIdForUser(projectId, user.id) : readClientProjectContext(body);

  return sseResponse(async (writer) => {
    writer.step('Creative Agent 思考中…');
    let buf = '';
    await chatStream(
      user,
      buildAgentMessages({ project: proj, refs, userMsg }),
      {
        temperature: 0.5,
        maxTokens: 1000,
        modelRole: 'brain',
        traceName: 'agent.chat',
        tokenContext: {
          projectId: projectId && proj ? projectId : null,
          projectTitleSnapshot: (proj as any)?.title || null,
          requestPath: req.nextUrl.pathname,
          routeName: 'agent.chat',
          moduleKey: 'agent',
          moduleLabel: '智能助手',
          featureKey: 'agent_chat',
          featureLabel: 'Creative Agent 对话',
          callItemType: 'project',
          callItemId: projectId && proj ? projectId : null,
          callItemLabel: (proj as any)?.title || null,
        },
      },
      (delta) => {
        buf += delta;
        writer.chunk(delta);
      },
    );

    const { replyText, patchText } = coerceAgentOutput(buf);
    const { patches, actions } = parseAgentPatches(patchText);
    const reply = stripPatchLines(replyText)
      || (actions.length ? '已生成可应用的修改方案。' : (replyText.trim() || buf.trim()));

    writer.done({ reply, patches, actions });
  });
}
