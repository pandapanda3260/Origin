import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatStream, parseJsonLoose } from '@/lib/llm';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { getDb } from '@/lib/db';
import { sseResponse } from '@/lib/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 剪辑工作台 · AI 一键生成 EDL（剪辑决策表）。
 *
 * 协议：SSE — 前端 apiPostStream 期望 chunk 流 + done 事件。
 * 完成后写入 project.editData.edl（结构与 /api/edit/timeline 一致：
 *   { timeline: [...], bgm, version }），让剪辑页 _renderEditTimeline 直接消费。
 * 同时返回 serverVersion，前端 _ctx.bumpProjectVersion 推进版本号。
 */

const SP_GENERATE_EDL = `你是工业级 AI 剪辑师。下面这组视频片段是同一个项目的连续故事节拍，请按
**Walter Murch《眨眼之间》"剪辑六字诀"** + **行业短视频/电影叙事节奏** 给出剪辑方案。

【剪辑六字诀（优先级从高到低）】
1) 情绪 (Emotion)            —— 这一刀切下去观众情绪是否对？最重要
2) 故事 (Story)              —— 是否推进剧情？
3) 节奏 (Rhythm)             —— 切点落在动作 / 对白的"自然呼吸点"上
4) 视线追踪 (Eye-Trace)      —— 主体视线 / 注意力点不要骤变
5) 二维构图 (2D Plane)       —— 主体在画面内的位置过渡平滑
6) 三维空间 (3D Space)       —— 轴线 / 空间方位连贯

【⚠️ 对白完整性是硬底线 ⚠️】
**含 dialogue 的段绝对禁止 trim**——必须 in=0 + out=durationSec，把整段保留。
人开口说话半句话被切掉是观众最反感的剪辑事故。
只有 dialogue 为空 / "无" / "——" 的段（纯空镜 / 反应镜头）才允许裁前后冗余。

【行业级节奏与转场建议】
- 总时长 = 各段对白时长之和 + 头尾各 0.5s 留白，不要硬卡到 targetDurationSec
- "铺垫"段：保留完整长度，节奏舒缓，让观众进入情境
- "递进"段：完整保留，节奏开始加快（不要裁对白）
- "高潮"段：完整保留，开始时用 cut 强化冲击
- "回落 / 收尾"段：完整保留 + 尾部留白
- 转场（transitionIn）—— **默认 cut，能 cut 就 cut**：
   * Walter Murch 原则：cut 是最强的剪辑工具，干脆有力是工业级剪辑的常态
   * 用户反馈："该硬切的地方加转场反倒别扭"——所以宁可少加转场，也不要在错误位置加
   * 第 0 段固定 cut
   * **绝大多数段都应该是 cut**。整片只有当你能明确说出"这里不 cut 不行"的理由时，才考虑非 cut
   * 全片建议：5 段以上最多 1 处非 cut；少于 5 段全 cut 即可
   * 何时才该非 cut（必须满足其一才能用）：
     - **情绪基调发生剧烈反转**（如紧张惊恐→温暖治愈，emotionIntensity 差≥4）：用 **fade**（约 0.8s）让观众有缓冲
     - **明确的章节分隔**（剧本明显的"第一幕完→第二幕开"）：用 **fade**（约 0.8s）做呼吸
     - **同角色跨明显时空**（"上午公司"→"晚上家里"）：用 **dissolve**（约 1.0s）暗示时间流逝
   * 【绝对禁止用转场的场景】
     - 同一场景内的镜头切换（人物对话、连续动作、反应镜头）—— 一律 cut
     - 含对白的段间转场会把对白前后吞掉 0.4-0.5s，会切坏台词
     - 任何"我也不太确定要不要加"的位置 —— 一律 cut
- 不要写"运镜"或"画面变化"——你只决定时间和切点，不决定画面内容
- J-cut / L-cut（音画错位）：仅在没对白的段才考虑

【硬性约束】
- 输出严格 JSON，不要 markdown 围栏
- 不要重复同一个 clipId
- 含 dialogue 的 clip：in=0, out=durationSec（保留完整对白），违反此约束剪辑会被拒
- 不含 dialogue 的 clip：in/out 在 [0, durationSec]，可以裁但不要砍超过 30%
- transitionIn / transitionOut 只用 cut / fade / dissolve / wipe
- 不要砍片段（每段都必须出现在 edl 里）
- **转场分布上限**：全片最多 1 处非 cut 转场；如不必要可以全 cut（cut 永远是安全选择）

输出格式：
{
  "edl": [
    {
      "clipId": "c1",
      "in": 0.0,
      "out": 5.0,
      "transitionIn": "cut",
      "transitionOut": "cut",
      "note": "为什么这样切（≤30 字，例：'铺垫段完整保留，cut 进虾盾激动反应'）"
    }
  ],
  "duration": 25.5,
  "narrative": "整体剪辑思路：节奏曲线 + 关键剪辑决定（≤80 字，要让导演能一眼看懂）",
  "pacingPlan": "舒缓→渐快→高潮 cut→回落 fade（每段一个简短描述，用 → 连）"
}`;

function clamp(v: number, lo: number, hi: number) {
  if (!isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
function pickEnum(v: any, list: string[], dflt: string) {
  const s = String(v || '').toLowerCase().trim();
  return list.includes(s) ? s : dflt;
}

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
  const targetDurationSec: number = Number(body?.targetDurationSec || body?.durationSec || 30);

  return sseResponse(async (writer) => {
    if (!projectId) { writer.error('缺 projectId'); return; }
    const proj = getProjectByIdForUser(projectId, user.id) as any;
    if (!proj) { writer.error('项目不存在'); return; }

    // 收集"已完成"的视频片段（来自 video_tasks，按 group_idx 排序）
    const db = getDb();
    const videos = db
      .prepare<{ uid: number; pid: string }, any>(
        `SELECT id, group_idx, prompt, duration_sec, filename FROM video_tasks
         WHERE owner_id = @uid AND project_id = @pid AND status = 'completed' AND filename IS NOT NULL
         ORDER BY group_idx ASC, created_at DESC`,
      )
      .all({ uid: user.id, pid: projectId });

    // 同 group 多条只留最新（与 /api/tasks/video-by-project 行为一致）
    const seen = new Set<number>();
    const dedup: any[] = [];
    for (const v of videos) {
      const gi = Number(v.group_idx);
      if (seen.has(gi)) continue;
      seen.add(gi);
      dedup.push(v);
    }

    if (!dedup.length) {
      writer.error('当前还没有已生成的视频片段，先去批量页生成');
      return;
    }

    const sbsForDialogue: any[] = Array.isArray(proj.storyboards) ? proj.storyboards : [];
    const shotsForDialogue: any[] = Array.isArray(proj.shots) ? proj.shots : [];
    /** 取某 groupIdx 下所有 shots 的 dialogue 文本拼接 */
    const dialogueForGroup = (gIdx: number): string => {
      const sb = sbsForDialogue[gIdx];
      const idxList: number[] = (sb && Array.isArray(sb.shotIndices) && sb.shotIndices.length) ? sb.shotIndices : [gIdx];
      const lines: string[] = [];
      for (const si of idxList) {
        const sh = shotsForDialogue[si];
        if (!sh) continue;
        const raw = String(sh.dialogue || '').trim();
        if (!raw || raw === '——' || raw === '-' || raw === '无') continue;
        lines.push(raw);
      }
      return lines.join(' / ');
    };

    const clips = dedup.map((v: any) => {
      const gIdx = Number(v.group_idx);
      const dialogue = dialogueForGroup(gIdx);
      return {
        clipId: v.id,
        durationSec: Number(v.duration_sec) || 4,
        groupIdx: gIdx,
        videoUrl: `/api/videos/file/${v.id}`,
        prompt: (v.prompt || '').slice(0, 300),
        dialogue,                     // 让 AI 看到对白内容
        hasDialogue: dialogue.length > 0, // 给 AI 一个明确信号：这段不要 trim
      };
    });

    // 把 segmentTags（AI 分析）的 plotRole / emotionIntensity 也喂给剪辑师，
    // 让它知道每段在情绪曲线上的位置——铺垫慢切、高潮 cut 进、收尾留白。
    const segTags: any[] = (proj.editData?.segmentTags?.segments) || [];
    const clipsAnnotated = clips.map((c) => {
      const tag = segTags.find((t: any) => Number(t?.groupIdx) === c.groupIdx) || {};
      return {
        ...c,
        plotRole: tag.plotRole || '',
        pace: tag.pace || '',
        emotion: tag.emotion || '',
        emotionIntensity: tag.emotionIntensity || 5,
      };
    });

    const ctx = {
      targetDurationSec,
      clips: clipsAnnotated,
      script: ((proj.script || proj.scriptDraft) || '').slice(0, 2000),
      shots: (Array.isArray(proj.shots) ? proj.shots : []).slice(0, 30),
    };

    let raw = '';
    try {
      writer.step('正在生成剪辑方案…');
      await chatStream(
        user,
        [
          { role: 'system', content: SP_GENERATE_EDL },
          { role: 'user', content: JSON.stringify(ctx) },
        ],
        { temperature: 0.5, responseFormat: 'json_object', maxTokens: 1500 },
        (delta) => { raw += delta; writer.chunk(delta); },
      );
    } catch (e: any) {
      writer.error('EDL 生成失败：' + (e?.message || String(e)));
      return;
    }

    let json: any = {};
    try { json = parseJsonLoose<any>(raw); } catch (_) {
      writer.error('AI 输出无法解析为 JSON，请稍后重试');
      return;
    }

    const clipMap = new Map(clips.map((c) => [c.clipId, c]));
    let aiEdl: any[] = Array.isArray(json.edl) ? json.edl : [];
    aiEdl = aiEdl
      .filter((e: any) => clipMap.has(e.clipId))
      .map((e: any) => {
        const c = clipMap.get(e.clipId)!;
        let inSec = clamp(Number(e.in ?? 0), 0, c.durationSec - 0.5);
        let outSec = clamp(Number(e.out ?? c.durationSec), inSec + 0.5, c.durationSec);

        // ⚠️ 对白完整性硬底线：含 dialogue 的段强制全段保留，无视 AI 给的 in/out。
        // 这是用户反馈"第 3 段话还没说完就跳了 / 第 5 段台词没说完就结束"后加的兜底。
        if (c.hasDialogue) {
          inSec = 0;
          outSec = c.durationSec;
        }

        return {
          clipId: e.clipId,
          in: inSec,
          out: outSec,
          transitionIn: pickEnum(e.transitionIn, ['cut', 'fade', 'dissolve', 'wipe'], 'cut'),
          transitionOut: pickEnum(e.transitionOut, ['cut', 'fade', 'dissolve', 'wipe'], 'cut'),
          note: String(e.note || '').slice(0, 200),
          groupIdx: c.groupIdx,
          videoUrl: c.videoUrl,
        };
      });

    // 补全：AI 漏掉的 clip（包括所有 clipId 不在 aiEdl 里的）按原顺序追加
    if (aiEdl.length < clips.length) {
      const inEdl = new Set(aiEdl.map((e) => e.clipId));
      for (const c of clips) {
        if (!inEdl.has(c.clipId)) {
          aiEdl.push({
            clipId: c.clipId,
            in: 0,
            out: c.durationSec,
            transitionIn: 'cut',
            transitionOut: 'cut',
            note: '',
            groupIdx: c.groupIdx,
            videoUrl: c.videoUrl,
          });
        }
      }
      // 按 groupIdx 排序，保持故事顺序
      aiEdl.sort((a, b) => a.groupIdx - b.groupIdx);
    }

    if (!aiEdl.length) {
      // 兜底：原顺序拼一遍
      aiEdl = clips.map((c) => ({
        clipId: c.clipId,
        in: 0,
        out: c.durationSec,
        transitionIn: 'cut',
        transitionOut: 'cut',
        note: '',
        groupIdx: c.groupIdx,
        videoUrl: c.videoUrl,
      }));
    }

    // ── 转场注入：只在"绝对应该有"的强情绪/段落跳跃处加，其它一律保留 cut。
    //    设计原则（用户反馈"该硬切的地方加转场反倒别扭"）：
    //      1. 默认 0 强制注入。AI 觉得该 cut 就 cut，干净利落是工业级剪辑的常态。
    //      2. 只有情绪差 ≥ 4 (1-10 量表的强落差) 才考虑注入，且总片段≥5才会触发。
    //      3. 永远不向"已经是 cut 序列里"插超过 1 个转场——避免观感破碎。
    //      4. 收尾 / 回落 段落用 fade（章节呼吸感），不用 dissolve（避免拖沓）。
    const _injectTransitions = () => {
      const n = aiEdl.length;
      if (n < 5) return; // 短片（4 段以下）全 cut 反而更紧凑

      const intensityFor = (gi: number) => {
        const t = segTags.find((s: any) => Number(s?.groupIdx) === gi);
        return Number(t?.emotionIntensity) || 5;
      };
      const STRONG_DELTA = 4; // 情绪差至少 4 档（1-10）才算"必须转场"
      const candidates: { idx: number; delta: number; toRole: string; fromRole: string }[] = [];
      for (let i = 1; i < n; i++) {
        const d = Math.abs(intensityFor(aiEdl[i].groupIdx) - intensityFor(aiEdl[i - 1].groupIdx));
        if (d < STRONG_DELTA) continue;
        const toTag = segTags.find((s: any) => Number(s?.groupIdx) === aiEdl[i].groupIdx);
        const fromTag = segTags.find((s: any) => Number(s?.groupIdx) === aiEdl[i - 1].groupIdx);
        candidates.push({
          idx: i, delta: d,
          toRole: String(toTag?.plotRole || ''),
          fromRole: String(fromTag?.plotRole || ''),
        });
      }
      if (!candidates.length) return;
      candidates.sort((a, b) => b.delta - a.delta);

      // 已经有非 cut 转场的总数 + 新注入数，硬上限 = 1（AI 已给的不动）
      const currentNonCut = aiEdl.slice(1).filter((e) => e.transitionIn && e.transitionIn !== 'cut').length;
      if (currentNonCut >= 1) return; // AI 自己加过转场了就不再插手

      const top = candidates[0];
      if (aiEdl[top.idx].transitionIn === 'cut') {
        const role = top.toRole;
        const trans = (role === '收尾' || role === '回落') ? 'fade'
                    : (role === '高潮' && top.delta >= 5) ? 'dissolve'
                    : 'fade';
        aiEdl[top.idx].transitionIn = trans;
      }
    };
    _injectTransitions();

    // 转换成剪辑页 _renderEditTimeline 消费的 timeline 形态
    // 转场时长与 lib/ffmpeg.ts defaultTransDuration / export/route.ts 保持一致
    const transDur = (t: string) => {
      if (t === 'cut') return 0;
      if (t === 'dissolve') return 1.0;
      if (t === 'wipe') return 0.7;
      return 0.8; // fade
    };
    const timeline = aiEdl.map((e) => ({
      groupIdx: e.groupIdx,
      videoUrl: e.videoUrl,
      inPoint: e.in,
      outPoint: e.out,
      duration: Math.max(0.1, e.out - e.in),
      transitionIn: { type: e.transitionIn, duration: transDur(e.transitionIn) },
      transitionOut: { type: e.transitionOut, duration: transDur(e.transitionOut) },
      note: e.note,
    }));
    const totalDuration = timeline.reduce((s, e) => s + e.duration, 0);

    // 写盘到 editData.edl，并把 storyboards[i].importedToEdit 翻 true
    try {
      const fresh = getProjectByIdForUser(projectId, user.id) as any;
      const editData = { ...(fresh?.editData || {}) };
      const prevEdl = editData.edl && typeof editData.edl === 'object' ? editData.edl : {};
      const newVersion = (Number(prevEdl.version) || 0) + 1;
      const result = {
        timeline,
        bgm: prevEdl.bgm || null,
        version: newVersion,
        narrative: typeof json.narrative === 'string' ? json.narrative : '',
        pacingPlan: typeof json.pacingPlan === 'string' ? json.pacingPlan : '',
        duration: totalDuration,
      };
      editData.edl = result;
      // 顶层 version 也推一下，bumpProjectVersion 取 max
      editData.version = (Number(editData.version) || 0) + 1;

      const sbs = Array.isArray(fresh?.storyboards) ? [...fresh.storyboards] : [];
      const inTl = new Set<number>(timeline.map((e) => e.groupIdx).filter((g) => Number.isInteger(g)) as number[]);
      let sbsTouched = false;
      for (let i = 0; i < sbs.length; i++) {
        const want = inTl.has(i);
        if (sbs[i] && !!sbs[i].importedToEdit !== want) {
          sbs[i] = { ...sbs[i], importedToEdit: want };
          sbsTouched = true;
        }
      }

      const patch: any = { editData };
      if (sbsTouched) patch.storyboards = sbs;
      updateProjectForUser(projectId, user.id, patch);

      writer.done({ result, serverVersion: editData.version });
    } catch (e: any) {
      writer.error('保存失败：' + (e?.message || String(e)));
    }
  });
}
