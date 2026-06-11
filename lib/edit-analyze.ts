import type { UserRow } from './db';
import { chatStream, parseJsonLoose, type ChatMessage } from './llm';
import { buildKnowledgeContextForStage } from './knowledge/compile-context';
import { maybeInjectKnowledgePromptBlock } from './knowledge/inject-messages';
import type { KnowledgeContextForStage, KnowledgeStageTarget } from './knowledge/types';

const SP_EDIT_ANALYZE = `你是短视频后期剪辑顾问。给你一个项目的剧本 + 镜头 + 已生成的视频片段，
请输出一份**结构化的剪辑分析**，要被剪辑工作台直接渲染成"故事弧线 + 片段标签"。

输出严格 JSON（不要 markdown 围栏，不要解释，不要多余字段）：
{
  "narrative": "整体故事弧线总结，60-120 字，描述情绪曲线 / 关键转折 / 节奏",
  "suggestedBGMCategory": "calm | tense | action | romantic | sad | epic | mysterious | hopeful 之一",
  "segments": [
    {
      "groupIdx": 0,
      "plotRole": "setup | rising | climax | falling | resolution 之一（剧作五段式角色）",
      "pace": "舒缓 | 平稳 | 推进 | 急促 | 紧凑 之一（这一段的剪辑节奏）",
      "emotion": "本段情绪关键词，2-4 个汉字（如：怀疑 / 欣喜 / 紧迫 / 释然 / 怅然）",
      "emotionIntensity": 4,
      "keyAction": "本段视频里发生了什么、镜头在表达什么。30-60 字，直接陈述，不要写'本段'/'此段'开头",
      "keyCharacters": ["出现的主要角色名，最多 3 个"]
    }
  ]
}

【硬性约束】
- segments 必须按时间顺序 1:1 对应输入的 segments 数组（同 groupIdx，同顺序，不允许少或多）
- emotionIntensity 是 1-10 的整数，反映本段情绪张力（铺垫低、高潮高）；五段式应呈现"低→中→高→中→低/中"的弧形
- 整片至少出现 climax 一次；setup / resolution 至少一次；rising / falling 视片长酌情
- plotRole 不要全部填 setup / rising，要让弧线有起伏
- emotion 用名词或形容词，不要句子，不要标点
- keyAction 要从输入的 videoPrompt / 镜头 visual / 剧本台词里提炼，禁止泛泛"本段铺垫氛围"之类废话
- keyCharacters 必须是真实出现的角色名（从镜头 characters / 剧本里抽），没有就给空数组
- suggestedBGMCategory 根据整片情绪基调选一个（轻松治愈→hopeful，紧张推进→tense，温馨→calm，热血→action 等）`;

export type AnalyzeSegmentInput = {
  groupIdx: number;
  videoUrl?: string;
  videoDurationSec?: number;
  duration?: number;
};

export type EditAnalyzeSegmentContext = {
  groupIdx: number;
  durationSec: number;
  videoPrompt: string;
  visuals: string;
  dialogues: string;
  characters: string[];
};

function pickEnum(v: any, list: string[], dflt: string) {
  const s = String(v || '').trim();
  return list.includes(s) ? s : dflt;
}

function clampInt(v: any, lo: number, hi: number, dflt: number) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

export function buildEditAnalyzeSegments(project: any, usableSegments?: AnalyzeSegmentInput[]): EditAnalyzeSegmentContext[] {
  const sbs: any[] = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shotsAll: any[] = Array.isArray(project?.shots) ? project.shots : [];
  const scoped = Array.isArray(usableSegments) && usableSegments.length > 0;
  const source = scoped
    ? usableSegments
    : sbs.map((sb, i) => ({ groupIdx: i, videoUrl: sb?.videoUrl, duration: sb?.duration }));

  return source
    .map((seg: any) => {
      const groupIdx = Number(seg?.groupIdx);
      if (!Number.isInteger(groupIdx) || groupIdx < 0) return null;
      const sb = sbs[groupIdx];
      const videoUrl = seg?.videoUrl || sb?.videoUrl;
      if (!videoUrl) return null;

      const shotIdx: number[] = Array.isArray(sb?.shotIndices) && sb.shotIndices.length
        ? sb.shotIndices
        : [groupIdx];
      const shotsForSeg = shotIdx.map((si) => shotsAll[si]).filter(Boolean);
      const chars = new Set<string>();
      const visuals: string[] = [];
      const dialogues: string[] = [];
      shotsForSeg.forEach((s: any) => {
        (Array.isArray(s.characters) ? s.characters : []).forEach((c: string) => c && chars.add(String(c)));
        if (s.visual || s.description) visuals.push(String(s.visual || s.description));
        const d = String(s.dialogue || '').trim();
        if (d && d !== '——' && d !== '-' && d !== '无') dialogues.push(d);
      });

      return {
        groupIdx,
        durationSec: Number(seg?.videoDurationSec ?? seg?.duration ?? sb?.duration) || 4,
        videoPrompt: String(sb?.videoPrompt || '').slice(0, 250),
        visuals: visuals.join(' / ').slice(0, 300),
        dialogues: dialogues.join(' / ').slice(0, 200),
        characters: Array.from(chars).slice(0, 4),
      };
    })
    .filter(Boolean) as EditAnalyzeSegmentContext[];
}

export function normalizeEditAnalysis(json: any, segmentsCtx: EditAnalyzeSegmentContext[]) {
  const PLOT = ['setup', 'rising', 'climax', 'falling', 'resolution'];
  const PACE = ['舒缓', '平稳', '推进', '急促', '紧凑'];
  const BGM = ['calm', 'tense', 'action', 'romantic', 'sad', 'epic', 'mysterious', 'hopeful'];

  const inSegs: any[] = Array.isArray(json?.segments) ? json.segments : [];
  const byGroup = new Map<number, any>();
  inSegs.forEach((s: any) => {
    const gi = Number(s?.groupIdx);
    if (Number.isInteger(gi)) byGroup.set(gi, s);
  });

  const segments = segmentsCtx.map((c, idx) => {
    const aiSeg = byGroup.get(c.groupIdx) || inSegs[idx] || {};
    const total = segmentsCtx.length;
    let defaultRole = 'rising';
    if (idx === 0) defaultRole = 'setup';
    else if (idx === total - 1) defaultRole = 'resolution';
    else if (idx === Math.floor(total / 2)) defaultRole = 'climax';
    else if (idx > Math.floor(total / 2)) defaultRole = 'falling';

    const defaultIntensity = (() => {
      if (idx === 0) return 3;
      if (idx === total - 1) return 4;
      if (idx === Math.floor(total / 2)) return 8;
      if (idx < Math.floor(total / 2)) return 5;
      return 6;
    })();

    let chars: string[] = Array.isArray(aiSeg.keyCharacters) ? aiSeg.keyCharacters.map(String) : [];
    if (!chars.length) chars = c.characters || [];

    const fallbackAction = (c.dialogues || c.visuals || c.videoPrompt || '').slice(0, 80);

    return {
      groupIdx: c.groupIdx,
      plotRole: pickEnum(aiSeg.plotRole, PLOT, defaultRole),
      pace: pickEnum(aiSeg.pace, PACE, '平稳'),
      emotion: String(aiSeg.emotion || '').trim().slice(0, 12) || '平静',
      emotionIntensity: clampInt(aiSeg.emotionIntensity, 1, 10, defaultIntensity),
      keyAction: String(aiSeg.keyAction || '').trim().slice(0, 200) || fallbackAction,
      keyCharacters: chars.filter(Boolean).slice(0, 4),
    };
  });

  return {
    narrative: typeof json?.narrative === 'string' ? json.narrative.trim() : '',
    suggestedBGMCategory: pickEnum(json?.suggestedBGMCategory, BGM, 'hopeful'),
    segments,
    tags: Array.isArray(json?.tags) ? json.tags : [],
  };
}

export async function analyzeUsableSegments(args: {
  user: UserRow;
  project: any;
  usableSegments?: AnalyzeSegmentInput[];
  knowledge?: {
    ownerId: number;
    projectId: string;
    runId?: string | null;
    stageTarget?: KnowledgeStageTarget;
  };
  onKnowledgeContext?: (context: KnowledgeContextForStage) => void;
  onStep?: (label: string) => void;
  onChunk?: (delta: string) => void;
}) {
  const segmentsCtx = buildEditAnalyzeSegments(args.project, args.usableSegments);
  if (!segmentsCtx.length) {
    throw new Error('当前还没有已生成的视频片段，先去片段页生成');
  }

  const ctx = {
    script: (args.project?.script || args.project?.scriptDraft || '').slice(0, 2500),
    totalSegments: segmentsCtx.length,
    segments: segmentsCtx,
  };

  let raw = '';
  args.onStep?.('正在分析叙事结构…');
  const analyzeMaxTokens = Math.min(12_000, Math.max(4_000, segmentsCtx.length * 800));
  let messages: ChatMessage[] = [
    { role: 'system', content: SP_EDIT_ANALYZE },
    { role: 'user', content: JSON.stringify(ctx) },
  ];
  if (args.knowledge) {
    try {
      const context = buildKnowledgeContextForStage({
        ownerId: args.knowledge.ownerId,
        project: {
          ...(args.project || {}),
          id: args.knowledge.projectId,
        },
        stage: 'edit_analyze',
        stageTarget: {
          ...(args.knowledge.stageTarget || {}),
          inputSegmentCount: segmentsCtx.length,
          groupIdxs: segmentsCtx.map((segment) => segment.groupIdx),
          scopedSegments: Array.isArray(args.usableSegments) && args.usableSegments.length > 0,
        },
        runId: args.knowledge.runId,
      });
      const injected = maybeInjectKnowledgePromptBlock({ messages, context });
      messages = injected.messages;
      args.onKnowledgeContext?.(injected.context);
    } catch (error) {
      console.warn('[edit-analyze] knowledge context injection skipped:', error);
    }
  }
  await chatStream(
    args.user,
    messages,
    {
      temperature: 0.5,
      responseFormat: 'json_object',
      maxTokens: analyzeMaxTokens,
      modelRole: 'structured',
      reasoningEffort: 'none',
      traceName: 'edit.analyze',
      tokenContext: {
        projectId: args.knowledge?.projectId || null,
        projectTitleSnapshot: args.project?.title || null,
        requestPath: 'edit_analyze',
        routeName: 'edit.analyze',
        moduleKey: 'edit',
        moduleLabel: '剪辑页',
        featureKey: 'edit_analyze',
        featureLabel: '剪辑分析',
        callItemType: 'project',
        callItemId: args.knowledge?.projectId || null,
        callItemLabel: args.project?.title || null,
        runId: args.knowledge?.runId || null,
      },
    },
    (delta) => {
      raw += delta;
      args.onChunk?.(delta);
    },
  );

  let json: any = {};
  try {
    json = parseJsonLoose<any>(raw);
  } catch {
    throw new Error('AI 输出无法解析为 JSON，请稍后重试');
  }
  return normalizeEditAnalysis(json, segmentsCtx);
}
