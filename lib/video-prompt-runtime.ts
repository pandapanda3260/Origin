import { statSync } from 'node:fs';
import { isIndependentMultiImageModeEnabled } from './feature-flags';
import type { TailFrameSignals } from './shot-tail-frame-signals';
import type { TargetEndStrategy } from './video-provider-capabilities';
import {
  buildReferenceBriefLine,
  cleanDialogueCharCountFromText,
  type ReferenceManifestItem,
} from './video-reference-manifest';

export type VideoReferenceImage = {
  role: 'first_frame' | 'character' | 'scene' | 'prop' | 'storyboard_sketch' | 'previous_tail' | 'target_end';
  path: string;
  label: string;
  sourceUrl?: string;
  assetId?: string;
  assetName?: string;
  promptHint?: string;
  priority?: number;
  useFor?: string[];
  immutable?: string[];
  panelInfo?: {
    panel: string;
    intent: string;
  };
  referenceBrief?: string;
};

export type VideoPromptRuleBlock = {
  id: string;
  title: string;
  content: string;
};

export type VideoPromptShotPlanItem = {
  idx?: number;
  durationSec?: number;
	  pace?: string;
	  shotType?: string;
	  angle?: string;
	  lens?: string;
	  focus?: string;
	  light?: string;
	  composition?: string;
	  camera?: string;
	  visual?: string;
  emotion?: string;
  tailFrameSignals?: TailFrameSignals;
		};

export type SeedancePromptInput = {
  prompt: string;
  ratio: string;
  durationSec: number;
  shotPlan?: VideoPromptShotPlanItem[];
  dialoguePairs?: Array<{ speaker: string; text: string; shotIdx?: number }>;
  /** tempoBudget.endingReserveSec 透传：首尾帧 tail_ready 时为 1.0s，
   *  台词"建议说完窗口"和收声规则要与它一致，避免和尾帧落点打架。 */
  tailReserveSec?: number;
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
  targetEndStrategy?: TargetEndStrategy;
  targetEndCaption?: string;
  targetEndUnsupportedReason?: string;
};

function panelBindingText(panel: string | undefined): string {
  if (panel === 'sheet') return '角色设定';
  if (panel === 'headshot') return '脸部近景';
  if (panel === 'front') return '正面';
  if (panel === 'side') return '侧面';
  if (panel === 'back') return '背面';
  return '';
}

function referenceBindingName(ref: ReferenceManifestItem): string {
  return String(ref.assetName || ref.label || ref.role || 'reference').trim();
}

function buildIndependentReferenceBindingCorrection(refs: ReferenceManifestItem[]): string {
  const characterRefs = refs.filter((ref) => ref.role === 'character');
  if (!characterRefs.length) {
    return '如果下方可编辑正文里的 Image 编号与本块冲突，必须忽略正文旧编号，以本块为唯一准。';
  }
  const groups = new Map<string, ReferenceManifestItem[]>();
  for (const ref of characterRefs) {
    const name = referenceBindingName(ref);
    const group = groups.get(name) || [];
    group.push(ref);
    groups.set(name, group);
  }
  const characterBindings = [...groups.entries()].map(([name, group]) => {
    const parts = group
      .slice()
      .sort((a, b) => Number(a.imageNo) - Number(b.imageNo))
      .map((ref) => {
        const panelText = panelBindingText(ref.panelInfo?.panel);
        return `Image ${ref.imageNo}${panelText ? ` ${panelText}` : ''}`;
      });
    return `${name}=${parts.join(' + ')}`;
  });
  return [
    '如果下方可编辑正文里的 Image 编号与本块冲突，必须忽略正文旧编号，以本块为唯一准。',
    `当前角色绑定：${characterBindings.join('；')}。`,
  ].join('\n');
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
      referenceBrief: ref.referenceBrief ? String(ref.referenceBrief).slice(0, 420) : undefined,
    });
    if (out.length >= 9) break;
  }
  return out;
}

export function buildIndependentReferencePromptBlock(refs: VideoReferenceImage[]): string {
  if (!refs.length) return '';
  const manifestRefs: ReferenceManifestItem[] = refs.map((ref, idx) => ({
    imageNo: idx + 1,
    role: ref.role === 'storyboard_sketch' || ref.role === 'previous_tail' ? 'first_frame' : ref.role,
    assetId: ref.assetId,
    assetName: ref.assetName,
    label: ref.label,
    url: ref.sourceUrl || ref.path,
    localPath: ref.path,
    useFor: Array.isArray(ref.useFor) ? ref.useFor : [],
    immutable: Array.isArray(ref.immutable) ? ref.immutable : [],
    promptHint: ref.promptHint,
    priority: ref.priority,
    panelInfo: ref.panelInfo,
    referenceBrief: ref.referenceBrief,
  }));
  const lines = manifestRefs.map((ref) => buildReferenceBriefLine(ref, manifestRefs));
  const bindingCorrection = buildIndependentReferenceBindingCorrection(manifestRefs);
  return [
    '【独立参考图编号 - 必须按顺序理解】',
    ...lines,
    bindingCorrection,
    'Use each image only for its stated role. Do not render reference-image borders, grids, thumbnails, labels, UI, captions, or subtitles.',
    '',
  ].join('\n');
}

function formatPlanSeconds(value: unknown): string {
  const n = Number(value);
  const rounded = Math.round((Number.isFinite(n) && n > 0 ? n : 4) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/\.0$/, '');
}

function normalizePlanDuration(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 4;
  return Math.round(Math.max(1, n) * 10) / 10;
}

function paceLabel(value: unknown): string {
  const raw = String(value || '').trim();
  const map: Record<string, string> = {
    slow: '慢',
    normal: '正常',
    fast: '快',
    fast_forward: '快进',
    'fast-forward': '快进',
    慢节奏: '慢',
    舒缓: '慢',
    平稳: '正常',
    标准: '正常',
    快节奏: '快',
    紧凑: '快',
  };
  return map[raw] || raw || '正常';
}

export function stripEditablePromptTimingLines(prompt: unknown): string {
  const raw = String(prompt ?? '');
  if (!raw) return '';
  let shotNo = 1;
  const out: string[] = [];
  for (const line of raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const trimmed = line.trim();
    const isDurationClockHeading = /^\d+(?:\.\d+)?\s*秒\s*[（(]\s*\d+:\d{2}(?:\.\d+)?\s*[-–~]\s*\d+:\d{2}(?:\.\d+)?\s*[）)]$/.test(trimmed);
    const isLegacySecondsHeading = /^\d+(?:\.\d+)?\s*[-–~]\s*\d+(?:\.\d+)?\s*(?:s|秒)$/i.test(trimmed);
    const isClockOnlyHeading = /^\d+:\d{2}(?:\.\d+)?\s*[-–~]\s*\d+:\d{2}(?:\.\d+)?$/.test(trimmed);
    const isDurationOnlyHeading = /^时长\s*[=:：]?\s*\d+(?:\.\d+)?\s*秒$/.test(trimmed);
    const isTimecodeOnlyHeading = /^时间码\s*[=:：]?\s*\d+:\d{2}(?:\.\d+)?\s*[-–~]\s*\d+:\d{2}(?:\.\d+)?$/.test(trimmed);

    if (isDurationClockHeading || isLegacySecondsHeading || isClockOnlyHeading) {
      out.push(`镜头 ${String(shotNo++).padStart(2, '0')}`);
      continue;
    }
    if (isDurationOnlyHeading || isTimecodeOnlyHeading) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildShotPlanBlock(shotPlan: VideoPromptShotPlanItem[] | undefined, requestDurationSec: number): string {
  const items = Array.isArray(shotPlan) ? shotPlan.filter(Boolean) : [];
  if (!items.length) return '';
  let total = 0;
  const lines = items.map((item, i) => {
    const duration = normalizePlanDuration(item.durationSec);
    total += duration;
    const shotNo = Number.isFinite(Number(item.idx)) && Number(item.idx) > 0
      ? Number(item.idx)
      : i + 1;
    const parts = [
      `时长 ${formatPlanSeconds(duration)}秒`,
	      `节奏 ${paceLabel(item.pace)}`,
	      item.shotType ? `景别 ${String(item.shotType).trim()}` : '',
	      item.angle ? `角度 ${String(item.angle).trim()}` : '',
	      item.lens ? `焦距 ${String(item.lens).trim()}` : '',
	      item.focus ? `景深 ${String(item.focus).trim()}` : '',
	      item.light ? `光线 ${String(item.light).trim()}` : '',
	      item.composition ? `构图 ${String(item.composition).trim()}` : '',
	      item.camera ? `运镜 ${String(item.camera).trim()}` : '',
	    ].filter(Boolean);
    return `  · 镜头 ${String(shotNo).padStart(2, '0')}：${parts.join('；')}`;
  });
  const requestRaw = Number(requestDurationSec);
  const requestDuration = Number.isFinite(requestRaw) && requestRaw > 0
    ? Math.round(requestRaw * 10) / 10
    : total;
  const extraRule = requestDuration > total
    ? `\n  · 供应商请求时长为 ${formatPlanSeconds(requestDuration)}秒，多出的 ${formatPlanSeconds(requestDuration - total)}秒只做自然收尾或环境延展，禁止新增剧情。`
    : '';
  return (
    `【镜头计划 - 结构化参数为准】\n` +
    `下面的时长和节奏来自镜头表，是本片段的唯一时长依据；不要从正文里另行推断或改写时长。\n` +
    lines.join('\n') +
    `\n  · 镜头计划总时长 ${formatPlanSeconds(total)}秒。` +
    extraRule +
    `\n\n`
  );
}

/** 开场气口锚点：窗口计算用 0.4s（提示词文案写"约 0.3~0.5 秒"，与
 *  video-segment-runtime 的 openingReserveSec=0.3 兜底值兼容）。 */
const DIALOGUE_HEAD_GAP_SEC = 0.4;
/** 结尾收声预留下限：调用方可传 tempoBudget.endingReserveSec 抬高
 *  （首尾帧 tail_ready 时是 1.0s），但不允许低于 0.4s。 */
const DIALOGUE_TAIL_GAP_SEC = 0.4;

export type DialoguePairPromptInput = {
  speaker: string;
  text: string;
  /** 台词来自镜头表的第几个 shot（0-based，对应 shotPlan 的 idx-1）。
   *  多镜头合并片段靠它把建议窗口对齐到所属镜头的时间轴。 */
  shotIdx?: number;
};

function formatWindowSec(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function resolveDialogueTailGapSec(tailReserveSec?: number): number {
  const n = Number(tailReserveSec);
  return Number.isFinite(n) && n > DIALOGUE_TAIL_GAP_SEC ? n : DIALOGUE_TAIL_GAP_SEC;
}

/**
 * 给每句台词分配"建议说完窗口"。
 *
 * 单镜头片段：在 [气口, 时长-尾留] 区间按净字数比例线性分配。
 * 多镜头合并片段：先用 shotPlan 时长（等比缩放到请求时长）摆出各镜头的
 * [start,end) 时间轴，每句台词只在**自己所属镜头**的区间内分配——
 * 否则 shot1 无台词、shot2 有台词时，窗口会把第二镜的台词错误地
 * 提示到片段开头（审查 finding，2026-06-11）。
 *
 * 返回 null = 放弃逐句窗口（无时长 / 多镜头但台词缺 shotIdx 映射 / 窗口
 * 挤不下），此时只输出气口规则——宁缺毋错，不给误导性时间。
 * 窗口是"建议节奏"不是硬时间码：模型只能粗略执行，写死到帧是假精确。
 */
function buildDialogueWindows(
  pairs: DialoguePairPromptInput[],
  durationSec?: number,
  shotPlan?: VideoPromptShotPlanItem[],
  tailReserveSec?: number,
): Array<{ startSec: number; endSec: number }> | null {
  const total = Number(durationSec);
  if (!Number.isFinite(total) || total <= 0) return null;
  const tailGap = resolveDialogueTailGapSec(tailReserveSec);
  const plan = Array.isArray(shotPlan) ? shotPlan.filter(Boolean) : [];

  // 多镜头：按 shotPlan 顺序累加时长（等比缩放到请求时长）→ 每镜 [start,end)
  let spans: Map<number, { startSec: number; endSec: number }> | null = null;
  if (plan.length > 1) {
    const durations = plan.map((item) => {
      const n = Number(item.durationSec);
      return Number.isFinite(n) && n > 0 ? n : 4;
    });
    const planTotal = durations.reduce((sum, n) => sum + n, 0);
    if (planTotal <= 0) return null;
    const scale = total / planTotal;
    spans = new Map();
    let cursor = 0;
    plan.forEach((item, i) => {
      const len = durations[i] * scale;
      const shotNo = Number.isFinite(Number(item.idx)) && Number(item.idx) > 0 ? Number(item.idx) : i + 1;
      spans!.set(shotNo, { startSec: cursor, endSec: cursor + len });
      cursor += len;
    });
  }

  // 把台词按所属镜头分组；多镜头但映射不全 → 整体放弃窗口
  const groups: Array<{ startSec: number; endSec: number; pairIdx: number[] }> = [];
  if (spans) {
    for (let i = 0; i < pairs.length; i += 1) {
      const shotIdx = Number(pairs[i].shotIdx);
      const span = Number.isFinite(shotIdx) ? spans.get(shotIdx + 1) : undefined;
      if (!span) return null;
      const last = groups[groups.length - 1];
      if (last && last.startSec === span.startSec) {
        last.pairIdx.push(i);
      } else {
        groups.push({ startSec: span.startSec, endSec: span.endSec, pairIdx: [i] });
      }
    }
  } else if (plan.length > 1) {
    return null;
  } else {
    groups.push({ startSec: 0, endSec: total, pairIdx: pairs.map((_, i) => i) });
  }

  const windows: Array<{ startSec: number; endSec: number }> = new Array(pairs.length);
  for (const group of groups) {
    const adjStart = Math.max(group.startSec, DIALOGUE_HEAD_GAP_SEC);
    const adjEnd = Math.min(group.endSec, total - tailGap);
    const usable = adjEnd - adjStart;
    // 挤不下就整体放弃：0.5s/句 是能念出 2 个字的底线
    if (usable < Math.max(1, group.pairIdx.length * 0.5)) return null;
    const charCounts = group.pairIdx.map((i) => Math.max(1, cleanDialogueCharCountFromText(pairs[i].text)));
    const charTotal = charCounts.reduce((sum, n) => sum + n, 0);
    let consumedChars = 0;
    group.pairIdx.forEach((pairIndex, k) => {
      const startSec = adjStart + (consumedChars / charTotal) * usable;
      consumedChars += charCounts[k];
      const endSec = adjStart + (consumedChars / charTotal) * usable;
      windows[pairIndex] = { startSec, endSec };
    });
  }
  return windows;
}

function buildDialogueBlock(
  dialoguePairs: DialoguePairPromptInput[] | undefined,
  durationSec?: number,
  shotPlan?: VideoPromptShotPlanItem[],
  tailReserveSec?: number,
): string {
  const dialogPairs = Array.isArray(dialoguePairs)
    ? dialoguePairs.filter((p) => p && p.text)
    : [];

  if (dialogPairs.length > 0) {
    const windows = buildDialogueWindows(dialogPairs, durationSec, shotPlan, tailReserveSec);
    const tailGap = resolveDialogueTailGapSec(tailReserveSec);
    const lines = dialogPairs
      .map((p, i) => {
        const cleanText = p.text.replace(/\s+/g, ' ');
        const sp = p.speaker
          ? `说话人: ${p.speaker}（必须由该角色开口配音，唇形要对得上）`
          : `说话人: 旁白`;
        const win = windows
          ? `（建议在 ${formatWindowSec(windows[i].startSec)}s ~ ${formatWindowSec(windows[i].endSec)}s 内说完）`
          : '';
        return `  [${i + 1}]${win} ${sp}\n      台词内容: "${cleanText}"`;
      })
      .join('\n');
    return (
      `【本片段台词 - 必须严格按原文配音、按列表顺序、由指定说话人开口】\n` +
      lines +
      `\n` +
      `严格规则：\n` +
      `  · 开口时机【最重要】：视频开场必须先留约 0.3~0.5 秒气口（呼吸 / 环境音 / 动作起手），` +
      `第一句台词在气口之后才开口；严禁从第 0 帧开讲，严禁开场就处于"话说到一半"的状态\n` +
      `  · 每句台词都要从第一个字完整念到最后一个字，句首的字严禁吞掉、弱化或淡入半个字\n` +
      (windows
        ? `  · 各句的"建议说完窗口"是节奏参考（允许 ±0.3 秒自然浮动），但第一句不得早于其窗口开始，` +
          `最后一句必须在视频结束前约 ${formatWindowSec(tailGap)} 秒说完，不要贴边\n`
        : '') +
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

function isFixedCameraPlan(item: VideoPromptShotPlanItem): boolean {
  const camera = String(item?.camera || '').trim();
  if (!camera) return false;
  const saysFixed = /固定|静止|锁定|不动/.test(camera);
  const saysMoving = /推进|推近|拉远|横移|平移|跟随|环绕|摇|甩|升降|移动|手持/.test(camera);
  return saysFixed && !saysMoving;
}

function buildMotionOpeningBlock(shotPlan?: VideoPromptShotPlanItem[], hasDialogue = false): string {
  const items = Array.isArray(shotPlan) ? shotPlan.filter(Boolean) : [];
  const hasPlan = items.length > 0;
  const fixedCount = items.filter(isFixedCameraPlan).length;
  const allFixed = hasPlan && fixedCount === items.length;
  const hasFixed = fixedCount > 0;

  const cameraRule = allFixed
    ? `  · 镜头计划为固定机位：机位必须保持固定，禁止为了"动起来"而擅自推/拉/横移/升降；用角色微动作、环境反光、灯光波动和空气流动制造动态\n`
    : hasFixed
      ? `  · 每个镜头按镜头计划的 camera 执行：固定镜头保持机位固定，运动镜头才从第 1 帧按推/拉/横移/跟随等方向开始物理位移\n`
      : `  · 镜头从第 1 帧就要按镜头计划和【运镜系统】描述的方向开始物理位移（推/拉/横移/跟随等）\n`;

  // 有台词时把"嘴唇微动"从微动作示例里拿掉，并明确"画面动 ≠ 开口"——
  // 否则本块会把模型推向第 0 帧开讲，台词第一个字被吃（开头吃字根因之一）。
  const microActionRule = hasDialogue
    ? `  · 角色从第 1 帧就要有微动作（呼吸起伏 / 眨眼 / 手部小动作），不能像照片一样定格\n` +
      `  · 开场动态指的是画面与肢体动作，**不等于开口说话**：本片段有台词，` +
      `第一句台词必须等开场气口（约 0.3~0.5 秒）之后再开始，禁止第 0 帧就开口\n`
    : `  · 角色从第 1 帧就要有微动作（呼吸起伏 / 眨眼 / 手部小动作 / 嘴唇微动），不能像照片一样定格\n`;

  return (
    `【开场动态强制】\n` +
    `视频第 0 帧就必须是动态画面，禁止前 0.3 秒呈现"参考图静帧定格"效果。\n` +
    cameraRule +
    microActionRule +
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
    `  · 若存在 target ending frame，视频最后一帧必须逐步接近它的构图、角色位置、动作状态和光照\n` +
    `  · 角色严格匹配对应 character reference；非人/拟人角色绝对不能画成真人\n` +
    `  · 场景、道具只参考其指定图片，保持全彩电影级真人画质\n` +
    `  · 画面中严禁出现参考图 UI、网格、黑条、缩略图条、边框、说明文字或字幕\n\n`
  );
}

function buildTargetEndConstraintBlock(input: SeedancePromptInput, refs: VideoReferenceImage[]): string {
  const targetEndRefIndex = refs.findIndex((ref) => ref.role === 'target_end');
  if (targetEndRefIndex >= 0) {
    return (
      `【目标结束帧约束】\n` +
      `Image ${targetEndRefIndex + 1} 是本片段的 target ending frame。视频必须从 first frame 自然运动，` +
      `并在结尾逐步接近 Image ${targetEndRefIndex + 1} 的构图、角色位置、动作结束状态、光照和空间关系。\n` +
      `不要在中途硬切到尾帧；需要通过角色动作和镜头运动自然抵达该终点。\n\n`
    );
  }

  const caption = String(input.targetEndCaption || '').trim();
  if (caption && input.targetEndStrategy === 'caption') {
    return (
      `【目标结束帧约束】\n` +
      `本片段结尾必须接近以下尾帧描述：${caption.slice(0, 800)}\n` +
      `保持结尾构图、角色位置、动作结束状态、光照和空间关系，不要把这段描述画成字幕或屏幕文字。\n\n`
    );
  }

  return '';
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

  const hasDialoguePairs = Array.isArray(input.dialoguePairs)
    && input.dialoguePairs.some((p) => p && p.text);
  const dialogueBlock = buildDialogueBlock(input.dialoguePairs, input.durationSec, input.shotPlan, input.tailReserveSec);
  const shotPlanBlock = buildShotPlanBlock(input.shotPlan, input.durationSec);
  const characterLockBlock = buildCharacterLockBlock(input.characterLockRoster, input.voiceRoster);
  const continuityBlock = buildContinuityBlock(input.prevTailSummary, input.nextHeadSummary);
  const independentReferenceBlock = buildIndependentReferencePromptBlock(independentReferenceImages);
  const targetEndConstraintBlock = buildTargetEndConstraintBlock(input, independentReferenceImages);
  const motionOpeningBlock = buildMotionOpeningBlock(input.shotPlan, hasDialoguePairs);
  const editablePrompt = stripEditablePromptTimingLines(input.prompt);

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
    { id: 'shot-plan', title: '镜头计划参数', content: shotPlanBlock },
    { id: 'dialogue', title: '台词系统规则', content: dialogueBlock },
    { id: 'character-lock', title: '角色一致性主档', content: characterLockBlock },
    { id: 'continuity', title: '前后片段衔接规则', content: continuityBlock },
    { id: 'independent-reference', title: '独立多图参考规则', content: independentReferenceBlock },
    { id: 'target-end', title: '目标结束帧约束', content: targetEndConstraintBlock },
    { id: 'motion-opening', title: '开场动态强制规则', content: motionOpeningBlock },
    { id: 'style-override', title: '风格/参考图负向约束', content: styleOverrideBlock },
  ].filter((block) => block.content);

  const promptCore =
    `${shotPlanBlock}` +
    `${dialogueBlock}` +
    `${characterLockBlock}` +
    `${continuityBlock}` +
    `${independentReferenceBlock}` +
    `${targetEndConstraintBlock}` +
    `${motionOpeningBlock}` +
    `${styleOverrideBlock}` +
    `${editablePrompt}`;
  const finalPrompt = `${promptCore}\n--ratio ${input.ratio} --duration ${input.durationSec}`;

  return {
    dialogueBlock,
    characterLockBlock,
    voiceBlock: '',
    continuityBlock,
    independentReferenceBlock,
    targetEndConstraintBlock,
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

// ============================================================================
// Builder A — first + last frame prompt builder
//
// Seedance's "first+last frame image-to-video" mode is mutually exclusive
// with its multi-reference mode. When Builder A is active, the payload
// contains exactly two image_url items (role: first_frame / last_frame) and
// NO reference_image items. The prompt therefore must not reference any
// "Image N / character reference / scene reference" bindings.
//
// ratio and duration are sent as TOP-LEVEL body fields in Builder A, not
// embedded in the prompt tail. So finalPrompt here does NOT append
// "--ratio X --duration Y" (unlike buildSeedancePromptParts above).
// ============================================================================

export type SeedanceFirstLastFramePromptInput = {
  prompt: string;
  durationSec?: number;
  shotPlan?: VideoPromptShotPlanItem[];
  dialoguePairs?: Array<{ speaker: string; text: string; shotIdx?: number }>;
  /** 见 SeedancePromptInput.tailReserveSec。首尾帧模式下尤其重要。 */
  tailReserveSec?: number;
  characterLockRoster?: string;
  voiceRoster?: string;
  prevTailSummary?: string;
  nextHeadSummary?: string;
};

function buildFirstLastFrameConstraintBlock(): string {
  return (
    `【首尾帧约束 - 首尾帧图生视频】\n` +
    `本片段使用首尾帧模式生成，请严格遵守以下约束：\n` +
    `  · 视频第 0 帧必须锚定到 first frame（提交的首帧图）：开场构图、角色站位、光照、色调与首帧一致\n` +
    `  · 视频最后一帧必须接近 last frame（提交的尾帧图/target ending frame）：结尾构图、角色位置、动作结束状态、光照与尾帧一致\n` +
    `  · 中间部分从首帧自然运动到尾帧，禁止硬切；通过角色动作和镜头运动自然抵达终点\n` +
    `  · 保持全彩电影级真人画质；禁止保留参考图的 UI / 网格 / 边框 / 说明文字\n` +
    `  · 不要把约束描述画成字幕或屏幕文字\n\n`
  );
}

export function buildSeedanceFirstLastFramePromptParts(input: SeedanceFirstLastFramePromptInput) {
  const hasDialoguePairs = Array.isArray(input.dialoguePairs)
    && input.dialoguePairs.some((p) => p && p.text);
  const dialogueBlock = buildDialogueBlock(input.dialoguePairs, input.durationSec, input.shotPlan, input.tailReserveSec);
  const shotPlanBlock = buildShotPlanBlock(input.shotPlan, input.durationSec || 0);
  const characterLockBlock = buildCharacterLockBlock(input.characterLockRoster, input.voiceRoster);
  const continuityBlock = buildContinuityBlock(input.prevTailSummary, input.nextHeadSummary);
  const firstLastFrameBlock = buildFirstLastFrameConstraintBlock();
  const motionOpeningBlock = buildMotionOpeningBlock(input.shotPlan, hasDialoguePairs);
  const editablePrompt = stripEditablePromptTimingLines(input.prompt || '');

  const ruleBlocks: VideoPromptRuleBlock[] = [
    { id: 'shot-plan', title: '镜头计划参数', content: shotPlanBlock },
    { id: 'dialogue', title: '台词系统规则', content: dialogueBlock },
    { id: 'character-lock', title: '角色一致性主档', content: characterLockBlock },
    { id: 'continuity', title: '前后片段衔接规则', content: continuityBlock },
    { id: 'first-last-frame', title: '首尾帧约束', content: firstLastFrameBlock },
    { id: 'motion-opening', title: '开场动态强制规则', content: motionOpeningBlock },
  ].filter((block) => block.content);

  const promptCore =
    `${shotPlanBlock}` +
    `${dialogueBlock}` +
    `${characterLockBlock}` +
    `${continuityBlock}` +
    `${firstLastFrameBlock}` +
    `${motionOpeningBlock}` +
    `${editablePrompt}`;

  // Intentional: no "--ratio X --duration Y" suffix. Those are top-level
  // fields in Builder A's request body.
  const finalPrompt = promptCore;

  return {
    dialogueBlock,
    characterLockBlock,
    continuityBlock,
    firstLastFrameBlock,
    motionOpeningBlock,
    ruleBlocks,
    promptCore,
    finalPrompt,
  };
}
