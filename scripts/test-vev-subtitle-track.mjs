/**
 * 字幕自动进剪辑器文字轨 契约测试
 *
 * 背景（2026-06-11，方向A）：
 *   自动铺轨时把台词转成 VevDemo 工程文字轨：
 *   - Origin 侧 online_editor.js：_buildVevSubtitleCues 按"一键成片 buildSrt 同规则"
 *     生成 plan.subtitles（行来源 videoPrompt→dialogue 回退；段内均分时间）。
 *   - 壳层 fe/index.js：buildSubtitleLaneFromPlan 按火山直接剪辑协议生成
 *     Type:'text' 片段（TargetTime/FontSize/FontColor/transform），文字 lane 放 Track 最前；
 *     updateProject 失败自动去文字 lane 降级重试（fail-soft），视频铺轨永不因字幕挂掉。
 *
 *   fe/index.js 是未跟踪手改文件，vendor 重同步会静默冲掉——本测试兼当哨兵。
 *
 * 运行：node scripts/test-vev-subtitle-track.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSubtitleLinesFromPrompt, splitSubtitleDialogueLines } from '../public/modules/subtitle_format.js';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];

function assert(cond, label) {
  if (cond) return;
  failures.push(label);
}

const shellJs = readFileSync(join(ROOT, 'vevdemo-1.0.6/fe/index.js'), 'utf8');
const oeJs = readFileSync(join(ROOT, 'public/modules/online_editor.js'), 'utf8');
const mainJs = readFileSync(join(ROOT, 'public/main.js'), 'utf8');

function extract(source, name, label) {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`无法提取 ${label || name}`);
  return match[0];
}

// ── 1. 哨兵：关键代码在场 ───────────────────────────────────────
assert(shellJs.includes('function buildSubtitleLaneFromPlan'), 'fe/index.js 应有 buildSubtitleLaneFromPlan（vendor 重同步冲掉即红）');
assert(/track\.push\(subtitleLane\);[\s\S]{0,80}track\.push\(videoTrack\);/.test(shellJs), '文字 lane 必须在视频 lane 之前 push（协议要求文字放 Track 最前）');
assert(/catch \(err\) \{[\s\S]{0,400}filter\(\(lane\) => !isSubtitleLane\(lane\)\)/.test(shellJs), 'updateProject 失败必须有去文字 lane 的 fail-soft 降级重试');
assert(shellJs.includes('subtitleApplied'), '铺轨结果必须上报 subtitleApplied（Origin 侧降级提示依赖它）');
assert(oeJs.includes('subtitles: _buildVevSubtitleCues(project, entries)'), 'plan 必须挂 subtitles（cue 列表）');
assert(oeJs.includes("from '/modules/subtitle_format.js?v=300'"), 'online_editor.js 必须从 subtitle_format.js 取行提取函数（与 importmap 同号）');
assert(oeJs.includes('字幕轨写入失败'), '降级时必须有软提示 toast');
assert(/online_editor\.js\?v=1[1-9]/.test(mainJs), 'main.js 应引用 online_editor.js?v=11+（cache bump 纪律）');

// ── 2. 行为：Origin 侧 cue 构建（注入真实 subtitle_format 实现） ──
const oeSandbox = new Function('extractSubtitleLinesFromPrompt', 'splitSubtitleDialogueLines', `
  ${extract(oeJs, '_roundVevSyncSec')}
  ${extract(oeJs, '_vevSubtitleLinesForGroup')}
  ${extract(oeJs, '_buildVevSubtitleCues')}
  return { _vevSubtitleLinesForGroup, _buildVevSubtitleCues };
`)(extractSubtitleLinesFromPrompt, splitSubtitleDialogueLines);

const project = {
  storyboards: [
    { videoPrompt: '少年抬头看向钟楼。林尘：「师父，我准备好了。」老者：「随我来。」' },
    { videoPrompt: '(无台词标记的描述)', shotIndices: [1] },
    {},
  ],
  shots: [
    { dialogue: '' },
    { dialogue: '林尘：师父，这是什么地方？\n老者：混沌圣地。' },
    { dialogue: '旁白独白一句' },
  ],
};

// 2a. videoPrompt 引号台词优先
const linesFromPrompt = oeSandbox._vevSubtitleLinesForGroup(project, 0);
assert(linesFromPrompt.length === 2 && linesFromPrompt[0].includes('师父，我准备好了'), `videoPrompt 应提取 2 行台词，实际：${JSON.stringify(linesFromPrompt)}`);

// 2b. prompt 无台词 → 回退 shotIndices 绑定镜头的 dialogue
const linesFromDialogue = oeSandbox._vevSubtitleLinesForGroup(project, 1);
assert(linesFromDialogue.length === 2 && linesFromDialogue[1].includes('混沌圣地'), `dialogue 回退应切出 2 行，实际：${JSON.stringify(linesFromDialogue)}`);

// 2c. 无 shotIndices → 回退 [groupIdx]
const linesFallback = oeSandbox._vevSubtitleLinesForGroup(project, 2);
assert(linesFallback.length === 1, `无绑定时应回退 shots[groupIdx].dialogue，实际：${JSON.stringify(linesFallback)}`);

// 2d. 时间分配：段内均分 + 0.15 起步 + 段尾 -0.05；无台词段产出 0 条
const entries = [
  { groupIdx: 0, targetStartSec: 0, targetEndSec: 5 },
  { groupIdx: 2, targetStartSec: 5, targetEndSec: 9 },
];
const cues = oeSandbox._buildVevSubtitleCues(project, entries);
assert(cues.length === 3, `两段应产出 2+1=3 条 cue，实际 ${cues.length}`);
const [c1, c2, c3] = cues;
assert(Math.abs(c1.startSec - 0.15) < 0.02, `首条应 0.15s 起，实际 ${c1.startSec}`);
assert(c2.startSec > c1.endSec, '同段两条 cue 不应重叠');
assert(c2.endSec <= 4.95 + 0.001, `段尾应留 0.05s，实际 ${c2.endSec}`);
assert(Math.abs(c3.startSec - 5.15) < 0.02 && c3.endSec <= 8.95 + 0.001, `第二段 cue 应落在段内，实际 ${c3.startSec}-${c3.endSec}`);

// ── 3. 行为：壳层文字 lane 构建 ─────────────────────────────────
const feSandbox = new Function(`
  ${extract(shellJs, 'toTimelineTime')}
  ${extract(shellJs, 'resolveCanvasSize')}
  const SUBTITLE_FONT_COLOR = '#FFFFFFFF';
  ${extract(shellJs, 'buildSubtitleLaneFromPlan')}
  ${extract(shellJs, 'isSubtitleLane')}
  ${extract(shellJs, 'laneItemCount')}
  return { buildSubtitleLaneFromPlan, isSubtitleLane, laneItemCount };
`)();

const plan = { subtitles: [
  { text: '第一句', startSec: 0.15, endSec: 2.3 },
  { text: '  ', startSec: 2.4, endSec: 3 },
  { text: '第二句', startSec: 3, endSec: 4.9 },
] };
const lane = feSandbox.buildSubtitleLaneFromPlan(plan, 'ms', { Canvas: { Width: 1080, Height: 1920 } });
assert(lane.length === 2, `空白文本应被跳过，lane 应 2 条，实际 ${lane.length}`);
assert(lane[0].Type === 'text' && lane[0].Text === '第一句', 'text 片段应带 Type/Text');
assert(lane[0].TargetTime[0] === 150 && lane[0].TargetTime[1] === 2300, `ms 单位换算错误：${JSON.stringify(lane[0].TargetTime)}`);
assert(lane[0].FontColor === '#FFFFFFFF' && Number.isFinite(lane[0].FontSize), '应带 FontColor/FontSize');
const tf = lane[0].Extra?.[0];
assert(tf?.Type === 'transform' && tf.Width === 1080 && tf.PosY === Math.round(1920 * 0.82), `transform 布局错误：${JSON.stringify(tf)}`);
assert(lane[0].OriginSubtitle === true, '应带 OriginSubtitle 标记便于识别');

// us 单位换算
const laneUs = feSandbox.buildSubtitleLaneFromPlan({ subtitles: [{ text: 'x', startSec: 1, endSec: 2 }] }, 'us', null);
assert(laneUs[0].TargetTime[0] === 1000000, 'us 单位应 ×1e6');

// isSubtitleLane / laneItemCount
assert(feSandbox.isSubtitleLane(lane) === true && feSandbox.isSubtitleLane([{ Type: 'video' }]) === false, 'isSubtitleLane 判定错误');
assert(feSandbox.laneItemCount([lane, [{ Type: 'video' }]], 'text') === 2, 'laneItemCount 统计错误');

if (failures.length) {
  console.error(`✗ ${failures.length} 处断言失败：`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('✓ 字幕→剪辑器文字轨契约测试通过（哨兵+行为 共 21 断言）');
