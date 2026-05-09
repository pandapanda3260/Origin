import { statSync } from 'node:fs';
import { isIndependentMultiImageModeEnabled } from './feature-flags';

export type VideoReferenceImage = {
  role: 'first_frame' | 'character' | 'scene' | 'prop' | 'storyboard_sketch' | 'previous_tail' | 'target_end';
  path: string;
  label: string;
  sourceUrl?: string;
  assetId?: string;
  assetName?: string;
  promptHint?: string;
  priority?: number;
};

export type VideoPromptRuleBlock = {
  id: string;
  title: string;
  content: string;
};

export type SeedancePromptInput = {
  prompt: string;
  ratio: string;
  durationSec: number;
  dialoguePairs?: Array<{ speaker: string; text: string }>;
  characterLockRoster?: string;
  voiceRoster?: string;
  prevTailSummary?: string;
  nextHeadSummary?: string;
  referenceImagePath?: string;
  referenceImageRole?: 'first_frame' | 'storyboard_sketch';
  sceneReferencePath?: string;
  characterReferencePaths?: string[];
  characterReferencePanels?: Array<{
    characterName: string;
    panel: string;
    path: string;
    intent: string;
  }>;
  propReferencePaths?: string[];
  referenceImages?: VideoReferenceImage[];
};

function referenceRoleText(role: VideoReferenceImage['role']): string {
  switch (role) {
    case 'first_frame': return 'first frame';
    case 'character': return 'character reference';
    case 'scene': return 'scene reference';
    case 'prop': return 'prop reference';
    case 'previous_tail': return 'previous shot ending frame';
    case 'target_end': return 'target ending frame';
    case 'storyboard_sketch': return 'storyboard sketch';
    default: return 'reference image';
  }
}

export function normalizeIndependentReferenceImages(refs: VideoReferenceImage[] | undefined): VideoReferenceImage[] {
  if (!isIndependentMultiImageModeEnabled()) return [];
  if (!Array.isArray(refs) || !refs.length) return [];
  const seen = new Set<string>();
  const out: VideoReferenceImage[] = [];
  for (const ref of refs) {
    const p = String(ref?.path || '').trim();
    if (!p || seen.has(p)) continue;
    try {
      if (!statSync(p).isFile()) continue;
    } catch (_) {
      continue;
    }
    seen.add(p);
    out.push({
      ...ref,
      path: p,
      label: String(ref.label || ref.role || 'reference image').slice(0, 80),
      promptHint: ref.promptHint ? String(ref.promptHint).slice(0, 180) : undefined,
    });
    if (out.length >= 9) break;
  }
  return out;
}

export function buildIndependentReferencePromptBlock(refs: VideoReferenceImage[]): string {
  if (!refs.length) return '';
  const lines = refs.map((ref, idx) => {
    const hint = ref.promptHint ? ` ${ref.promptHint}` : '';
    return `Image ${idx + 1}: ${referenceRoleText(ref.role)} - ${ref.label}.${hint}`;
  });
  return [
    '【独立参考图编号 - 必须按顺序理解】',
    ...lines,
    'Use each image only for its stated role. Do not render reference-image borders, grids, thumbnails, labels, UI, captions, or subtitles.',
    '',
  ].join('\n');
}

function buildDialogueBlock(dialoguePairs: Array<{ speaker: string; text: string }> | undefined): string {
  const dialogPairs = Array.isArray(dialoguePairs)
    ? dialoguePairs.filter((p) => p && p.text)
    : [];

  if (dialogPairs.length > 0) {
    const lines = dialogPairs
      .map((p, i) => {
        const cleanText = p.text.replace(/\s+/g, ' ');
        const sp = p.speaker
          ? `说话人: ${p.speaker}（必须由该角色开口配音，唇形要对得上）`
          : `说话人: 旁白`;
        return `  [${i + 1}] ${sp}\n      台词内容: "${cleanText}"`;
      })
      .join('\n');
    return (
      `【本片段台词 - 必须严格按原文配音、按列表顺序、由指定说话人开口】\n` +
      lines +
      `\n` +
      `严格规则：\n` +
      `  · "说话人:" 后面的角色名是元信息，**绝对不准念出来**（不要把"老板"、"帝王蟹队长"等角色名当成台词的一部分朗读）\n` +
      `  · 只有"台词内容:"引号里的字才是真正要念的台词\n` +
      `  · 每句台词的发声角色必须严格匹配上面"说话人:"指定的那个名字，` +
      `其它角色只做反应/听不发声\n` +
      `  · 提示词里任何「」/""/''/⟦⟧ 包裹的、不在上面列表里的句子都禁止念出\n\n`
    );
  }

  return (
    `【本片段无台词】\n` +
    `角色保持沉默，禁止从画面描述中提取任何"" /「」/⟦⟧ 内的对白朗读出来，` +
    `即便提示词里有引号包住的句子也不要念，只保留环境音 / 动作音 / 背景音。\n\n`
  );
}

function buildCharacterLockBlock(characterLockRoster?: string, legacyVoiceRoster?: string): string {
  const roster = characterLockRoster || legacyVoiceRoster || '';
  return roster
    ? `【角色一致性主档 - 跨片段最高优先级】\n${roster}\n` +
      `硬规则：\n` +
      `  · 同一个角色名/别名在所有片段中必须保持同一身份、外观、服装、物种、比例、表演气质和声音\n` +
      `  · 角色参考图只定义形象，不得把参考图边框、网格、缩略图条、标签或 UI 画进视频\n` +
      `  · 拟人化非人角色必须保留实际物种身体结构，严禁替换成普通真人\n` +
      `  · 如下方画面描述与本主档冲突，以本主档为准\n\n`
    : '';
}

function buildContinuityBlock(prevTailSummary?: string, nextHeadSummary?: string): string {
  return prevTailSummary || nextHeadSummary
    ? `【前后片段衔接 - 避免硬切】\n` +
      (prevTailSummary
        ? `· 上一片段结束在：${prevTailSummary.slice(0, 200)}\n` +
          `  → 本片段第一帧的角色站位、视线方向、灯光要与之自然承接\n`
        : '') +
      (nextHeadSummary
        ? `· 下一片段开始时：${nextHeadSummary.slice(0, 200)}\n` +
          `  → 本片段最后一帧要为下一镜留出过渡空间（不要镜头突然推到死/拉到底）\n`
        : '') +
      `\n`
    : '';
}

function buildMotionOpeningBlock(): string {
  return (
    `【开场动态强制】\n` +
    `视频第 0 帧就必须是动态画面，禁止前 0.3 秒呈现"参考图静帧定格"效果。\n` +
    `  · 镜头从第 1 帧就要按【运镜系统】描述的方向开始物理位移（推/拉/横移/跟随等）\n` +
    `  · 角色从第 1 帧就要有微动作（呼吸起伏 / 眨眼 / 手部小动作 / 嘴唇微动），不能像照片一样定格\n` +
    `  · 多个视频拼成成片时，每段开头的那一瞬间必须无缝接得上"在动"，不能让人感觉切到一张静态封面\n\n`
  );
}

function buildFirstFrameStyleBlock(): string {
  return (
    `【风格强制覆盖 - 彩色首帧参考图说明】\n` +
    `已附上一张彩色视频首帧参考图，这是本片段第 0 帧的直接视觉锚点，定义开场构图、角色站位、光照、色调和真实画面质感。\n` +
    `最终视频必须满足：\n` +
    `  · 从这张彩色首帧自然运动起来，首帧构图和主体不能突变\n` +
    `  · 保持全彩电影级真人画质（live-action cinematic full color）\n` +
    `  · 画面中严禁出现参考图 UI、网格、黑条、缩略图条、边框、说明文字或字幕\n` +
    `  · 角色严格匹配首帧与文字 roster；非人/拟人角色绝对不能画成真人\n` +
    `  · 道具若出现在镜头中，外观/材质/颜色必须匹配首帧和道具描述\n\n`
  );
}

function buildColorCompositeStyleBlock(hasPanelRefs: boolean, panelSummary: string): string {
  return (
    `【风格强制覆盖 - 视觉圣经参考图说明】\n` +
    `已附上一张合成参考图，包含三块信息：\n` +
    `  ① 主背景（顶部铺满）= 彩色场景资产图，定义环境、光照、色调、材质\n` +
    (hasPanelRefs
      ? `  ② 底部缩略图条 = 按本片段景别自动挑选的角色参考 panel（${panelSummary || '角色 panel'}），定义脸部/全身/侧面/背面细节\n`
      : `  ② 底部缩略图条 = 本片段出场角色/道具的彩色资产图，定义角色外形/服装/物种和关键道具（拟人化角色必须保留物种特征）\n`) +
    `  ③ 右上小角标 = 黑白铅笔分镜草图，仅用于参考镜头构图/景别/角色站位（不要复制黑白色调）\n` +
    `最终视频必须满足：\n` +
    `  · 全彩电影级真人画质（live-action cinematic full color, professional cinematography）\n` +
    `  · 色调/光照/材质完全跟随彩色场景图，禁止保留分镜草图的黑白灰阶 / 铅笔肌理 / 草稿质感\n` +
    `  · 每个角色严格匹配底部对应的彩色参考图（人物形象、衣着、物种）；非人/拟人角色绝对不能画成真人\n` +
    `  · 镜头构图/景别遵循右上角标的草图，但成片是真人电影质感\n\n`
  );
}

function buildSketchStyleBlock(): string {
  return (
    `【风格强制覆盖】\n` +
    `参考图为黑白铅笔分镜草图（pre-production storyboard sketch），` +
    `仅用于构图、角色站位、镜头视角、动作走位的参考。\n` +
    `最终视频必须满足：\n` +
    `  · 全彩电影级真人画质（live-action cinematic full color, professional cinematography）\n` +
    `  · 严禁保留参考图的铅笔线条 / 素描肌理 / 黑白灰阶 / 网格纹理 / 草稿质感\n` +
    `  · 角色皮肤、服装颜色、环境光照、道具材质均按真实场景渲染\n\n`
  );
}

function buildIndependentStyleBlock(refCount: number): string {
  return (
    `【风格强制覆盖 - 独立多参考图说明】\n` +
    `已附上 ${refCount} 张独立 reference_image。必须按上方 Image 编号理解每张图的职责，不要把角色图、场景图、道具图混成拼贴画。\n` +
    `最终视频必须满足：\n` +
    `  · Image 1 若为 first frame，视频必须从该彩色首帧自然运动起来，开场构图和主体不能突变\n` +
    `  · 角色严格匹配对应 character reference；非人/拟人角色绝对不能画成真人\n` +
    `  · 场景、道具只参考其指定图片，保持全彩电影级真人画质\n` +
    `  · 画面中严禁出现参考图 UI、网格、黑条、缩略图条、边框、说明文字或字幕\n\n`
  );
}

export function buildSeedancePromptParts(input: SeedancePromptInput) {
  const panelRefs = Array.isArray(input.characterReferencePanels) ? input.characterReferencePanels : [];
  const panelSummary = panelRefs.slice(0, 4).map((panel) => `${panel.characterName}/${panel.panel}`).join('，');
  const hasPanelRefs = panelRefs.length > 0;
  const hasFirstFrameRef = !!input.referenceImagePath && input.referenceImageRole === 'first_frame';
  const independentReferenceImages = normalizeIndependentReferenceImages(input.referenceImages);
  const hasIndependentImageRefs = independentReferenceImages.length > 0;
  const propRefs = Array.isArray(input.propReferencePaths) ? input.propReferencePaths : [];
  const hasColorRefs =
    hasFirstFrameRef ||
    !!input.sceneReferencePath ||
    hasPanelRefs ||
    (Array.isArray(input.characterReferencePaths) && input.characterReferencePaths.length > 0) ||
    propRefs.length > 0;
  const hasAnyRef = hasIndependentImageRefs || hasColorRefs || !!input.referenceImagePath;

  const dialogueBlock = buildDialogueBlock(input.dialoguePairs);
  const characterLockBlock = buildCharacterLockBlock(input.characterLockRoster, input.voiceRoster);
  const continuityBlock = buildContinuityBlock(input.prevTailSummary, input.nextHeadSummary);
  const independentReferenceBlock = buildIndependentReferencePromptBlock(independentReferenceImages);
  const motionOpeningBlock = buildMotionOpeningBlock();

  let styleOverrideBlock = '';
  if (hasIndependentImageRefs) {
    styleOverrideBlock = buildIndependentStyleBlock(independentReferenceImages.length);
  } else if (hasFirstFrameRef) {
    styleOverrideBlock = buildFirstFrameStyleBlock();
  } else if (hasColorRefs) {
    styleOverrideBlock = buildColorCompositeStyleBlock(hasPanelRefs, panelSummary);
  } else if (input.referenceImagePath) {
    styleOverrideBlock = buildSketchStyleBlock();
  }

  const ruleBlocks: VideoPromptRuleBlock[] = [
    { id: 'dialogue', title: '台词系统规则', content: dialogueBlock },
    { id: 'character-lock', title: '角色一致性主档', content: characterLockBlock },
    { id: 'continuity', title: '前后片段衔接规则', content: continuityBlock },
    { id: 'independent-reference', title: '独立多图参考规则', content: independentReferenceBlock },
    { id: 'motion-opening', title: '开场动态强制规则', content: motionOpeningBlock },
    { id: 'style-override', title: '风格/参考图负向约束', content: styleOverrideBlock },
  ].filter((block) => block.content);

  const promptCore =
    `${dialogueBlock}` +
    `${characterLockBlock}` +
    `${continuityBlock}` +
    `${independentReferenceBlock}` +
    `${motionOpeningBlock}` +
    `${styleOverrideBlock}` +
    `${input.prompt}`;
  const finalPrompt = `${promptCore}\n--ratio ${input.ratio} --duration ${input.durationSec}`;

  return {
    dialogueBlock,
    characterLockBlock,
    voiceBlock: '',
    continuityBlock,
    independentReferenceBlock,
    motionOpeningBlock,
    styleOverrideBlock,
    ruleBlocks,
    promptCore,
    finalPrompt,
    independentReferenceImages,
    hasIndependentImageRefs,
    hasFirstFrameRef,
    hasColorRefs,
    hasAnyRef,
  };
}
