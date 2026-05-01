import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatStream, parseJsonLoose } from '@/lib/llm';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { sseResponse } from '@/lib/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 剪辑工作台 · AI 分析（叙事结构 / 情绪曲线 / 段落标签 / BGM 建议）。
 *
 * 协议：SSE — 前端 apiPostStream 期望 chunk 流 + done 事件。
 * 完成后写入 project.editData.segmentTags，并 bump editData.version 作为
 * serverVersion 返回给前端，让 _ctx.bumpProjectVersion 推进版本号。
 *
 * 返回 schema 必须严格匹配前端 _renderEditTags 的消费字段，否则右侧面板会
 * 渲染成空白：
 *   {
 *     narrative,
 *     suggestedBGMCategory,
 *     segments: [
 *       { groupIdx, plotRole, pace, emotion, emotionIntensity, keyAction, keyCharacters }
 *     ]
 *   }
 */

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

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return new Response(
      `data: ${JSON.stringify({ type: 'error', error: 'unauthorized' })}\n\n`,
      { status: 401, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body?.projectId;

  return sseResponse(async (writer) => {
    if (!projectId) { writer.error('缺 projectId'); return; }
    const proj = getProjectByIdForUser(projectId, user.id) as any;
    if (!proj) { writer.error('项目不存在'); return; }

    const sbs: any[] = Array.isArray(proj.storyboards) ? proj.storyboards : [];
    const shotsAll: any[] = Array.isArray(proj.shots) ? proj.shots : [];

    // 给 LLM 的 segments 上下文：每段带 videoPrompt / 关联镜头 visual+dialogue / 角色
    const segmentsCtx = sbs
      .map((sb, i) => {
        if (!sb || !sb.videoUrl) return null;
        const shotIdx: number[] = Array.isArray(sb.shotIndices) && sb.shotIndices.length
          ? sb.shotIndices
          : [i];
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
          groupIdx: i,
          durationSec: sb.duration || 4,
          videoPrompt: (sb.videoPrompt || '').slice(0, 250),
          visuals: visuals.join(' / ').slice(0, 300),
          dialogues: dialogues.join(' / ').slice(0, 200),
          characters: Array.from(chars).slice(0, 4),
        };
      })
      .filter(Boolean) as any[];

    if (!segmentsCtx.length) {
      writer.error('当前还没有已生成的视频片段，先去批量页生成');
      return;
    }

    const ctx = {
      script: (proj.script || proj.scriptDraft || '').slice(0, 2500),
      totalSegments: segmentsCtx.length,
      segments: segmentsCtx,
    };

    let raw = '';
    try {
      writer.step('正在分析叙事结构…');
      await chatStream(
        user,
        [
          { role: 'system', content: SP_EDIT_ANALYZE },
          { role: 'user', content: JSON.stringify(ctx) },
        ],
        { temperature: 0.5, responseFormat: 'json_object', maxTokens: 1500 },
        (delta) => { raw += delta; writer.chunk(delta); },
      );
    } catch (e: any) {
      writer.error('分析失败：' + (e?.message || String(e)));
      return;
    }

    let json: any = {};
    try { json = parseJsonLoose<any>(raw); } catch (_) {
      writer.error('AI 输出无法解析为 JSON，请稍后重试');
      return;
    }

    // 规范化：把 LLM 输出对齐到前端消费的 schema，缺项给默认值，避免渲染空白
    const PLOT = ['setup', 'rising', 'climax', 'falling', 'resolution'];
    const PACE = ['舒缓', '平稳', '推进', '急促', '紧凑'];
    const BGM = ['calm', 'tense', 'action', 'romantic', 'sad', 'epic', 'mysterious', 'hopeful'];
    const pickEnum = (v: any, list: string[], dflt: string) => {
      const s = String(v || '').trim();
      return list.includes(s) ? s : dflt;
    };
    const clampInt = (v: any, lo: number, hi: number, dflt: number) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) return dflt;
      return Math.max(lo, Math.min(hi, n));
    };

    const inSegs: any[] = Array.isArray(json.segments) ? json.segments : [];
    // 按 groupIdx 索引，缺失的用兜底填齐（跟 segmentsCtx 顺序对齐）
    const byGroup = new Map<number, any>();
    inSegs.forEach((s: any) => {
      const gi = Number(s?.groupIdx);
      if (Number.isInteger(gi)) byGroup.set(gi, s);
    });

    const segments = segmentsCtx.map((c: any, idx: number) => {
      const aiSeg = byGroup.get(c.groupIdx) || inSegs[idx] || {};
      // 默认弧线分布：第一段 setup，最后段 resolution，中间挑一个 climax
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

    const result = {
      narrative: typeof json.narrative === 'string' ? json.narrative.trim() : '',
      suggestedBGMCategory: pickEnum(json.suggestedBGMCategory, BGM, 'hopeful'),
      segments,
      tags: Array.isArray(json.tags) ? json.tags : [],
    };

    try {
      const fresh = getProjectByIdForUser(projectId, user.id) as any;
      const editData = { ...(fresh?.editData || {}) };
      editData.segmentTags = result;
      const next = (Number(editData.version) || 0) + 1;
      editData.version = next;
      updateProjectForUser(projectId, user.id, { editData });
      writer.done({ result, serverVersion: next });
    } catch (e: any) {
      writer.error('保存失败：' + (e?.message || String(e)));
    }
  });
}
