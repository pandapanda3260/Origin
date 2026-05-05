import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';
import {
  buildAssetCharactersExtractMessages,
  buildAssetPropsExtractMessages,
  buildAssetScenesExtractMessages,
} from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 从剧本里识别角色/场景/道具。
 * 走 SSE 让前端有"AI 正在分析剧本…"的进度提示动画。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const scriptText: string = (body.script || body.scriptText || '').toString();

  const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const finalScript = scriptText || (proj as any)?.scriptDraft || (proj as any)?.script || '';
  const bodyStyleBible = normalizeStyleBible(body.styleBible);
  const styleBible = (proj as any)?.styleBible || bodyStyleBible || null;
  const styleBibleSource = (proj as any)?.styleBible ? 'project' : (bodyStyleBible ? 'request' : 'none');

  return sseResponse(async (writer) => {
    if (!finalScript) {
      writer.error('当前没有剧本，请先生成或上传剧本');
      return;
    }
    console.info(
      `[assets/extract] start projectId=${projectId || 'none'} scriptChars=${finalScript.length} ` +
      `styleBible=${styleBibleSource}`,
    );

    writer.step('正在分析剧本结构…');
    writer.chunk('开始抽取角色 / 场景 / 道具…\n');

    let parsed: any = { characters: [], environments: [], props: [] };
    try {
      writer.step('正在识别角色…');
      const characters = await chatCompleteJsonWithRetry(
        user,
        buildAssetCharactersExtractMessages(finalScript, styleBible),
        { temperature: 0.35, maxTokens: 6000, modelRole: 'structured' },
        (raw) => {
          const json = parseJsonLoose(raw);
          return ensureArray(json.characters);
        },
        'assetsCharacters',
      );

      writer.step('正在识别场景与道具…');
      const characterRefs = characters.map((c: any, index: number) => ({
        id: c.id || `c${index + 1}`,
        name: c.name || '',
        role: c.role || c.identity || '',
      }));
      const [environments, props] = await Promise.all([
        chatCompleteJsonWithRetry(
          user,
          buildAssetScenesExtractMessages(finalScript, styleBible, characterRefs),
          { temperature: 0.35, maxTokens: 5000, modelRole: 'structured' },
          (raw) => {
            const json = parseJsonLoose(raw);
            return ensureArray(json.environments || json.scenes);
          },
          'assetsScenes',
        ),
        chatCompleteJsonWithRetry(
          user,
          buildAssetPropsExtractMessages(finalScript, styleBible, characterRefs),
          { temperature: 0.35, maxTokens: 2500, modelRole: 'structured' },
          (raw) => {
            const json = parseJsonLoose(raw);
            return ensureArray(json.props);
          },
          'assetsProps',
        ),
      ]);

      parsed = {
        characters,
        environments,
        props: normalizePropOwnership(props, characterRefs),
      };
    } catch (e: any) {
      writer.error('资产抽取失败：' + (e?.message || String(e)));
      return;
    }

    // 兜底：如果 LLM 漏了某些必填字段，用其他字段拼一个，免得前端卡片显示空白
    parsed.characters = parsed.characters.map((c: any) => {
      const entityType = (c.entityType === 'non-human' ? 'non-human' : 'human') as 'human' | 'non-human';
      return {
        ...c,
        entityType,
        // role / identity 是前端卡片小字一行；缺了就拿 intro 顶上，否则空
        role: c.role || c.intro || '',
        identity: c.identity || c.intro || '',
        // appearance / clothing / equipment 拼起来是详情段；旧字段 detail 兜底拆给 appearance
        appearance: c.appearance || c.detail || c.intro || '',
        clothing: c.clothing || '',
        equipment: c.equipment || '',
        // temperament / actionTraits 必须是逗号分隔的字符串，前端拆成多个标签胶囊
        temperament: c.temperament || '',
        actionTraits: c.actionTraits || '',
        tags: Array.isArray(c.tags) ? c.tags : [],
        imagePrompt: c.imagePrompt || buildCharacterPrompt(c, styleBible),
      };
    });
    parsed.environments = parsed.environments.map((e: any) => ({
      ...e,
      imagePrompt: e.imagePrompt || buildScenePrompt(e, styleBible),
    }));
    parsed.props = parsed.props.map((p: any) => ({
      ...p,
      imagePrompt: p.imagePrompt || buildPropPrompt(p, styleBible),
    }));

    // 兜底：如果只有主场景没副场景，自动补一个副场景（基于主场景衍生）
    const mainScene = parsed.environments.find((e: any) => e.isMain);
    const hasSubScene = parsed.environments.some((e: any) => !e.isMain && e.baseSceneRef);
    if (mainScene && !hasSubScene) {
      parsed.environments.push({
        id: (mainScene.id || 'e1') + '_sub',
        name: mainScene.name + ' · 副景',
        description: '由主场景衍生的次要区域，与主场景共享色调、光线、材质语言',
        isMain: false,
        baseSceneRef: mainScene.id,
        tags: [...(mainScene.tags || []), '副景'],
        imagePrompt: buildScenePrompt(
          {
            ...mainScene,
            name: mainScene.name + ' corner',
            description: 'a different angle/corner of the main scene, same lighting and color palette',
          },
          styleBible,
        ),
      });
    }

    writer.step('已识别角色 ' + parsed.characters.length + ' 个');
    writer.step('已识别场景 ' + parsed.environments.length + ' 个');
    writer.step('已识别道具 ' + parsed.props.length + ' 个');

    // 前端期望的资产结构：{characters, scenes, props}
    const assets = {
      characters: parsed.characters,
      scenes: parsed.environments,
      props: parsed.props,
    };

    if (projectId && proj) {
      // 写回项目：兼容前端 project.assets.{characters/scenes/props} 老结构 + 新顶层结构
      updateProjectForUser(projectId, user.id, {
        characters: parsed.characters,
        environments: parsed.environments,
        props: parsed.props,
        assets,
        assetsApproved: false,
        currentStep: 2,
      });
    }

    // 前端读 resp.assets.{characters, scenes, props}，所以 done payload 必须有 assets 字段
    writer.done({
      assets,
      // 同时保留扁平字段，兼容其它老调用方
      characters: parsed.characters,
      environments: parsed.environments,
      props: parsed.props,
    });
  });
}

function ensureArray(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

function normalizeStyleBible(value: any): any | null {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizePropOwnership(props: any[], characters: Array<{ id: string }>): any[] {
  const validIds = new Set(characters.map((c) => String(c.id || '')).filter(Boolean));
  return props.map((prop) => {
    const owner = prop?.ownership == null ? null : String(prop.ownership || '').trim();
    if (!owner || validIds.has(owner)) return { ...prop, ownership: owner || null };
    return { ...prop, ownership: null };
  });
}

/** 抽出风格圣经里能用作画面 prompt 后缀的关键词 */
function styleSuffix(sb: any): string {
  if (!sb) return 'cinematic illustration style, high quality';
  const parts: string[] = [];
  if (sb.visualStyle) parts.push(String(sb.visualStyle));
  if (sb.colorPalette && Array.isArray(sb.colorPalette)) {
    const names = sb.colorPalette.map((c: any) => c.name).filter(Boolean).slice(0, 3).join(', ');
    if (names) parts.push(`color palette: ${names.toLowerCase()}`);
  } else if (typeof sb.colorPalette === 'string') {
    parts.push(`color palette: ${sb.colorPalette}`);
  }
  if (sb.cameraStyle) parts.push(String(sb.cameraStyle).slice(0, 60));
  return parts.length ? parts.join(', ') : 'cinematic illustration style';
}

function buildCharacterPrompt(c: any, _sb: any): string {
  // 风格 / 光线 / 背景 / 三视图布局都由 image-gen 的 forceStyleSuffix 强制统一加
  // 这里只描述"主体本身"
  const bits = [
    c.name ? `Subject: ${c.name}.` : '',
    c.appearance || c.detail || c.intro || '',
    c.clothing ? `Clothing: ${c.clothing}.` : '',
    c.equipment ? `Equipment: ${c.equipment}.` : '',
    c.temperament ? `Temperament: ${c.temperament}.` : '',
    c.entityType === 'non-human' ? 'NOTE: this is a non-human creature, keep its actual non-human anatomy, do NOT redraw as a person.' : '',
  ];
  return bits.filter(Boolean).join(' ').trim();
}

function buildScenePrompt(e: any, sb: any): string {
  const bits = [
    'wide environment shot of',
    e.name ? `${e.name},` : '',
    e.description || '',
    'atmospheric lighting, detailed setting,',
    styleSuffix(sb),
  ];
  return bits.filter(Boolean).join(' ').trim();
}

function buildPropPrompt(p: any, sb: any): string {
  const bits = [
    'close-up product shot of',
    p.name ? `${p.name},` : '',
    p.features || '',
    p.propType ? `category: ${p.propType},` : '',
    'studio lighting, isolated on simple background,',
    styleSuffix(sb),
  ];
  return bits.filter(Boolean).join(' ').trim();
}
