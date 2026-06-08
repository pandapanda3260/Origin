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
import { sanitizePromptObject } from '@/lib/content-sanitize';
import { mutateCharacterLock } from '@/lib/character-consistency';
import { hashNormalizedScript } from '@/lib/script-style-state';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { maybeInjectKnowledgePromptBlock } from '@/lib/knowledge/inject-messages';
import type { ChatMessage } from '@/lib/llm';
import type { KnowledgeContextForStage } from '@/lib/knowledge/types';
import {
  appendCharacterCastingPrompt,
  normalizeCastingProfile,
  styleBibleForCharacterAsset,
  styleBibleForScenePrompt,
} from '@/lib/casting-profile';
import {
  isAnonymousCrowdAsset,
  normalizeCrowdFlag,
  normalizeCrowdFlagForCompare,
  normalizeCrowdSize,
} from '@/lib/crowd-character';
import { projectWorldContextForStage } from '@/lib/world-template-context';
import { mergeProjectFactsIntoWorldSnapshot } from '@/lib/world-templates-db';

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
  const rawStyleBible = (proj as any)?.styleBible || bodyStyleBible || null;
  const styleBible = sanitizePromptObject(rawStyleBible);
  const styleBibleSource = (proj as any)?.styleBible ? 'project' : (bodyStyleBible ? 'request' : 'none');
  const rawWorldTemplate = (proj as any)?.worldTemplateSnapshot || body.worldTemplateSnapshot || null;
  const worldTemplate = rawWorldTemplate ? sanitizePromptObject(rawWorldTemplate) : null;
  const worldContext = projectWorldContextForStage('assets_extract', worldTemplate, {
    project: proj,
    scriptText: finalScript,
  });

  return sseResponse(async (writer) => {
    if (!finalScript) {
      writer.error('当前没有剧本，请先生成或上传剧本');
      return;
    }
    console.info(
      `[assets/extract] start projectId=${projectId || 'none'} scriptChars=${finalScript.length} ` +
      `styleBible=${styleBibleSource} worldTemplate=${worldTemplate ? 'yes' : 'none'}`,
    );

    writer.step('正在分析剧本结构…');
    writer.chunk('开始抽取角色 / 场景 / 道具…\n');
    const scriptHash = hashNormalizedScript(finalScript);
    let knowledgeContext: KnowledgeContextForStage | null = null;
    const applyKnowledge = (messages: ChatMessage[]) => {
      if (!knowledgeContext) return messages;
      const injected = maybeInjectKnowledgePromptBlock({ messages, context: knowledgeContext });
      knowledgeContext = injected.context;
      return injected.messages;
    };
    if (projectId && proj) {
      try {
        const context = buildKnowledgeContextForStage({
          ownerId: user.id,
          project: {
            ...(proj as any),
            id: projectId,
            styleBible,
            worldTemplateSnapshot: worldTemplate,
          },
          stage: 'assets_extract',
          stageTarget: {
            scriptHash,
            styleBibleSource,
            hasWorldTemplate: !!worldTemplate,
          },
        });
        knowledgeContext = maybeInjectKnowledgePromptBlock({
          messages: [{ role: 'user', content: 'asset extraction context probe' }],
          context,
        }).context;
      } catch (error) {
        console.warn('[assets/extract] knowledge context injection skipped:', error);
      }
    }

    let parsed: any = { characters: [], environments: [], props: [] };
    try {
      writer.step('正在识别角色…');
      const characterStyleBible = styleBibleForCharacterAsset(styleBible);
      const sceneStyleBible = styleBibleForScenePrompt(styleBible);
      const characters = await chatCompleteJsonWithRetry(
        user,
        applyKnowledge(buildAssetCharactersExtractMessages(finalScript, characterStyleBible, worldContext)),
        {
          temperature: 0.35,
          maxTokens: 10000,
          modelRole: 'structured',
          tokenContext: {
            projectId: projectId || null,
            projectTitleSnapshot: (proj as any)?.title || null,
            requestPath: req.nextUrl.pathname,
            routeName: 'assets.extract',
            moduleKey: 'assets',
            moduleLabel: '资产生成',
            featureKey: 'asset_character_extract',
            featureLabel: '角色资产抽取',
            callItemType: 'project',
            callItemId: projectId || null,
            callItemLabel: (proj as any)?.title || null,
          },
        },
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
          applyKnowledge(buildAssetScenesExtractMessages(finalScript, sceneStyleBible, characterRefs, worldContext)),
          {
            temperature: 0.35,
            maxTokens: 5000,
            modelRole: 'structured',
            tokenContext: {
              projectId: projectId || null,
              projectTitleSnapshot: (proj as any)?.title || null,
              requestPath: req.nextUrl.pathname,
              routeName: 'assets.extract',
              moduleKey: 'assets',
              moduleLabel: '资产生成',
              featureKey: 'asset_scene_extract',
              featureLabel: '场景资产抽取',
              callItemType: 'project',
              callItemId: projectId || null,
              callItemLabel: (proj as any)?.title || null,
            },
          },
          (raw) => {
            const json = parseJsonLoose(raw);
            return ensureArray(json.environments || json.scenes);
          },
          'assetsScenes',
        ),
        chatCompleteJsonWithRetry(
          user,
          applyKnowledge(buildAssetPropsExtractMessages(finalScript, sceneStyleBible, characterRefs, worldContext)),
          {
            temperature: 0.35,
            maxTokens: 2500,
            modelRole: 'structured',
            tokenContext: {
              projectId: projectId || null,
              projectTitleSnapshot: (proj as any)?.title || null,
              requestPath: req.nextUrl.pathname,
              routeName: 'assets.extract',
              moduleKey: 'assets',
              moduleLabel: '资产生成',
              featureKey: 'asset_prop_extract',
              featureLabel: '道具资产抽取',
              callItemType: 'project',
              callItemId: projectId || null,
              callItemLabel: (proj as any)?.title || null,
            },
          },
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
      const explicitCrowd = normalizeCrowdFlag(c.isCrowd ?? c.is_crowd);
      const isCrowd = explicitCrowd === undefined ? isAnonymousCrowdAsset(c) : explicitCrowd;
      const crowdSize = normalizeCrowdSize(c.crowdSize ?? c.crowd_size ?? c.groupSize);
      const normalized: any = {
        ...c,
        entityType,
        isCrowd,
        crowdSize: isCrowd && crowdSize ? crowdSize : undefined,
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
        castingOverride: normalizeCastingProfile(c.castingOverride || c.casting_override) || undefined,
      };
      normalized.imagePrompt = appendCharacterCastingPrompt(
        c.imagePrompt || buildCharacterPrompt(normalized, styleBible),
        normalized,
        styleBible,
        { script: finalScript },
      );
      if (!isCrowd) delete normalized.crowdSize;
      return normalized;
    });
    let mainAssigned = false;
    const usedSceneIds = new Set<string>();
    parsed.environments = ensureArray(parsed.environments).map((e: any, idx: number) => {
      let isMain = !!e?.isMain;
      if (isMain && mainAssigned) isMain = false;
      if (isMain) mainAssigned = true;
      const baseId = String(e?.id || e?.sceneId || `e${idx + 1}`).trim() || `e${idx + 1}`;
      let id = baseId;
      let suffix = 2;
      while (usedSceneIds.has(id)) {
        id = `${baseId}_${suffix}`;
        suffix++;
      }
      usedSceneIds.add(id);
      return {
        ...e,
        id,
        isMain,
        tags: Array.isArray(e?.tags) ? [...e.tags] : [],
        imagePrompt: e.imagePrompt || buildScenePrompt(e, styleBible),
      };
    });
    if (parsed.environments.length && !parsed.environments.some((e: any) => e.isMain)) {
      parsed.environments[0].isMain = true;
    }
    const mainIdx = parsed.environments.findIndex((e: any) => e.isMain);
    if (mainIdx > 0) {
      const [mainEnv] = parsed.environments.splice(mainIdx, 1);
      parsed.environments.unshift(mainEnv);
    }
    parsed.environments = parsed.environments.map((e: any) => ({
      ...e,
      tags: e.isMain
        ? Array.from(new Set([...(e.tags || []), '主场景']))
        : (e.tags || []).filter((t: string) => t !== '主场景'),
    }));
    parsed.props = parsed.props.map((p: any) => ({
      ...p,
      imagePrompt: p.imagePrompt || buildPropPrompt(p, styleBible),
    }));

    parsed = sanitizePromptObject(parsed);
    if (proj) {
      parsed.characters = preserveGeneratedAssetFields(
        'characters',
        parsed.characters,
        (proj as any)?.assets?.characters,
        (proj as any)?.characters,
      );
      parsed.environments = preserveGeneratedAssetFields(
        'scenes',
        parsed.environments,
        (proj as any)?.assets?.scenes,
        (proj as any)?.environments,
      );
      parsed.props = preserveGeneratedAssetFields(
        'props',
        parsed.props,
        (proj as any)?.assets?.props,
        (proj as any)?.props,
      );
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
    let responsePendingWorldFacts: any = undefined;

    if (projectId && proj) {
      let consistencyProject: any = {
        ...(proj as any),
        characters: parsed.characters,
        environments: parsed.environments,
        props: parsed.props,
        assets,
      };
      parsed.characters = parsed.characters.map((character: any, index: number) => {
        const characterId = String(character.characterId || character.id || `c${index + 1}`);
        const result = mutateCharacterLock(
          consistencyProject,
          characterId,
          {
            sourceAssetId: character.id || characterId,
            canonicalName: character.name || character.role || characterId,
            aliases: [character.name, character.role].filter(Boolean),
            identityLock: {
              role: character.role || '',
              identity: character.identity || '',
              entityType: character.entityType === 'non-human' ? 'non-human' : 'human',
              species: character.species,
              gender: character.gender,
              ageBand: character.ageBand || character.age,
            },
            visualLock: {
              appearance: character.appearance || '',
              clothing: character.clothing || '',
              equipment: character.equipment || '',
              canonicalPrompt: character.imagePrompt || '',
            },
            performanceLock: {
              temperament: character.temperament || '',
              actionTraits: character.actionTraits || '',
            },
          },
          { source: 'asset_extract' },
        );
        consistencyProject = result.project;
        return { ...character, characterId: result.character.characterId };
      });
      assets.characters = parsed.characters;
      const worldSnapshotMerge = mergeProjectFactsIntoWorldSnapshot({
        ...consistencyProject,
        characters: parsed.characters,
        environments: parsed.environments,
        props: parsed.props,
        assets,
      });
      if (worldSnapshotMerge.changed) {
        responsePendingWorldFacts = {
          schema: 'origin-pending-world-facts-v1',
          source: 'assets_extract',
          createdAt: new Date().toISOString(),
          worldTemplateSnapshot: worldSnapshotMerge.worldTemplateSnapshot,
          summary: {
            characterCount: Array.isArray(worldSnapshotMerge.worldTemplateSnapshot?.characters) ? worldSnapshotMerge.worldTemplateSnapshot.characters.length : 0,
            locationCount: Array.isArray(worldSnapshotMerge.worldTemplateSnapshot?.locations) ? worldSnapshotMerge.worldTemplateSnapshot.locations.length : 0,
            propCount: Array.isArray(worldSnapshotMerge.worldTemplateSnapshot?.props) ? worldSnapshotMerge.worldTemplateSnapshot.props.length : 0,
          },
        };
      }
      const staleFlags = { ...(((proj as any)._staleFlags || {}) as Record<string, unknown>) };
      delete staleFlags.assets;
      // 写回项目：兼容前端 project.assets.{characters/scenes/props} 老结构 + 新顶层结构
      updateProjectForUser(projectId, user.id, {
        characters: parsed.characters,
        environments: parsed.environments,
        props: parsed.props,
        assets,
        consistency: consistencyProject.consistency,
        pendingWorldFacts: responsePendingWorldFacts || null,
        _staleFlags: staleFlags,
        assetsApproved: false,
        currentStep: 2,
      });
      try {
        if (knowledgeContext) recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context: knowledgeContext });
      } catch (error) {
        console.warn('[assets/extract] knowledge context audit skipped:', error);
      }
    }

    // 前端读 resp.assets.{characters, scenes, props}，所以 done payload 必须有 assets 字段
    writer.done({
      assets,
      // 同时保留扁平字段，兼容其它老调用方
      characters: parsed.characters,
      environments: parsed.environments,
      props: parsed.props,
      pendingWorldFacts: responsePendingWorldFacts,
    });
  });
}

function ensureArray(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

const GENERATED_ASSET_FIELDS = [
  'imageUrl',
  'rawUrl',
  'realPhotoUrl',
  'pencilUrl',
  'assetId',
  'imageAssetId',
  'pencilAssetId',
  'submittedImagePrompt',
  'imageSafetyAudit',
  'effectiveVisualDescription',
  'reference',
  'imageGeneratedAt',
  'skippedStylize',
];

function nonEmptyAssetValue(value: any): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function hasGeneratedAssetUrl(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  return [
    item.imageUrl,
    item.rawUrl,
    item.realPhotoUrl,
    item.pencilUrl,
    item.reference?.currentUrl,
    item.reference?.lastKnownGoodUrl,
  ].some(nonEmptyAssetValue);
}

function cloneAssetField(value: any): any {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeAssetMatchKey(value: any): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, '');
}

function assetMatchKeys(item: any): string[] {
  if (!item || typeof item !== 'object') return [];
  // 只用稳定标识匹配：characterId 是跨抽取保留的一致性 ID；name 是用户视角的稳定锚点。
  // 不要用 LLM 每次重新生成的 id/sceneId（c1/c2/e1/p1），那是顺序敏感的，
  // 会导致脚本里增删/换序后串图。
  return [
    item.characterId,
    item.name,
  ].map(normalizeAssetMatchKey).filter(Boolean);
}

type PreserveAssetKind = 'characters' | 'scenes' | 'props';

// 影响图片生成的字段清单：任一字段变化就要重生成图，并把旧版本（图+全套信息）归档到 imageHistory。
const IMAGE_RELEVANT_FIELDS: Record<PreserveAssetKind, string[]> = {
  characters: ['name', 'role', 'identity', 'appearance', 'clothing', 'equipment',
               'temperament', 'actionTraits', 'entityType', 'castingOverride',
               'imagePrompt', 'description', 'tags', 'isCrowd', 'crowdSize'],
  scenes: ['name', 'description', 'location', 'timeSetting', 'weather', 'lighting',
           'atmosphere', 'elements', 'imagePrompt'],
  props: ['name', 'propType', 'features', 'material', 'imagePrompt'],
};

function _stableStringify(value: any): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return '[' + value.map(_stableStringify).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + _stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function _normalizeFieldForCompare(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return _stableStringify(value);
}

function _normalizeAssetFieldForCompare(kind: PreserveAssetKind, field: string, value: any): string {
  if (kind === 'characters' && field === 'isCrowd') return normalizeCrowdFlagForCompare(value);
  if (kind === 'characters' && field === 'crowdSize') return normalizeCrowdSize(value);
  return _normalizeFieldForCompare(value);
}

function imageRelevantFieldsChanged(kind: PreserveAssetKind, next: any, prev: any): boolean {
  const fields = IMAGE_RELEVANT_FIELDS[kind];
  for (const f of fields) {
    if (_normalizeAssetFieldForCompare(kind, f, next?.[f]) !== _normalizeAssetFieldForCompare(kind, f, prev?.[f])) return true;
  }
  return false;
}

// 给一个老资产 item 抓一份"全套信息"快照，准备塞进 imageHistory。
function _captureFullInfoSnapshot(kind: PreserveAssetKind, item: any): Record<string, any> {
  const fields = IMAGE_RELEVANT_FIELDS[kind];
  const out: Record<string, any> = {};
  fields.forEach((f) => {
    if (item?.[f] !== undefined) out[f] = cloneAssetField(item[f]);
  });
  return out;
}

function normalizeCharacterEntityType(value: any): string {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'non-human' || text === 'nonhuman' || text.includes('非人')) return 'non-human';
  if (text === 'human' || text.includes('人物') || text.includes('人类')) return 'human';
  return text;
}

function panelSchemaEntityType(value: any): string {
  const schema = String(value?.schema || '').trim().toLowerCase();
  if (!schema) return '';
  if (schema.includes('non-human') || schema.includes('nonhuman')) return 'non-human';
  if (schema.includes('human-character')) return 'human';
  return '';
}

function canPreserveGeneratedAssetFields(kind: PreserveAssetKind, next: any, previous: any): boolean {
  if (kind !== 'characters') return true;
  const status = previous?.reference?.status;
  if (status === 'failed' || status === 'missing') return false;
  const nextEntity = normalizeCharacterEntityType(next?.entityType || next?.identityLock?.entityType);
  const previousEntity = normalizeCharacterEntityType(previous?.entityType || previous?.identityLock?.entityType);
  if (nextEntity && previousEntity && nextEntity !== previousEntity) return false;
  const previousSchemaEntity = panelSchemaEntityType(previous?.panels);
  if (nextEntity && previousSchemaEntity && nextEntity !== previousSchemaEntity) return false;
  if (nextEntity === 'non-human' && !previousEntity && !previousSchemaEntity) return false;
  return true;
}

function buildGeneratedAssetLookup(collections: any[][]): Map<string, any> {
  const lookup = new Map<string, any>();
  collections.forEach((collection) => {
    ensureArray(collection).forEach((item) => {
      if (!hasGeneratedAssetUrl(item)) return;
      assetMatchKeys(item).forEach((key) => {
        const existing = lookup.get(key);
        if (!existing || !hasGeneratedAssetUrl(existing)) lookup.set(key, item);
      });
    });
  });
  return lookup;
}

function preserveGeneratedAssetFields(kind: PreserveAssetKind, nextItems: any[], ...previousCollections: any[][]): any[] {
  const lookup = buildGeneratedAssetLookup(previousCollections);
  return ensureArray(nextItems).map((item) => {
    if (!item || typeof item !== 'object' || hasGeneratedAssetUrl(item)) return item;
    const match = assetMatchKeys(item).map((key) => lookup.get(key)).find(Boolean);
    if (!match) return item;
    if (!canPreserveGeneratedAssetFields(kind, item, match)) return item;

    // 关键：信息没变 → 保留旧图；信息有变 → 把旧版本（图+全套信息）归档进 imageHistory，
    // 新 item 不带 URL 字段，等前端"生成全部图片"再重生成。
    const changed = imageRelevantFieldsChanged(kind, item, match);

    if (!changed) {
      // 字段一字不差 → 保留旧的图片相关字段
      const preserved = { ...item };
      GENERATED_ASSET_FIELDS.forEach((field) => {
        if (!nonEmptyAssetValue(preserved[field]) && nonEmptyAssetValue(match[field])) {
          preserved[field] = cloneAssetField(match[field]);
        }
      });
      // imageHistory 也一并继承（用户之前的历史栈不丢）
      if (Array.isArray(match.imageHistory) && match.imageHistory.length && !Array.isArray(preserved.imageHistory)) {
        preserved.imageHistory = match.imageHistory.map(cloneAssetField);
      }
      return preserved;
    }

    // 字段变了 → 旧版本归档；图为空，等重新生成
    const snapshot: Record<string, any> = {
      at: Date.now(),
      source: 'info_changed',
      info: _captureFullInfoSnapshot(kind, match),
    };
    GENERATED_ASSET_FIELDS.forEach((field) => {
      if (nonEmptyAssetValue(match[field])) snapshot[field] = cloneAssetField(match[field]);
    });
    // 把当时的 URL 也单独提一份到 snapshot.url 顶层，方便前端读
    const snapUrl = match.imageUrl || match.rawUrl || match.realPhotoUrl || match.pencilUrl || '';
    if (snapUrl) snapshot.url = snapUrl;

    const prior = Array.isArray(match.imageHistory) ? match.imageHistory.map(cloneAssetField) : [];
    const nextHistory = [snapshot, ...prior].slice(0, 10);

    const result = { ...item, imageHistory: nextHistory };
    return result;
  });
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
