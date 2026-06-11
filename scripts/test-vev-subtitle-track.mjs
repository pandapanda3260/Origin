/**
 * VevDemo subtitle material import contract.
 *
 * 字幕 P0 不再直写 EditParam.Track 的 Type:'text'，而是：
 *   Origin 生成 SRT -> bridge 上传 object subtitle -> CreateEditMaterial -> SearchEditMaterial 回读。
 * 字幕是否进一步自动落入时间线字幕轨属于 P1 SDK 探针，不在本契约内承诺。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];

function assert(cond, label) {
  if (cond) return;
  failures.push(label);
}

function extract(source, name, label) {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`无法提取 ${label || name}`);
  return match[0];
}

const shellJs = readFileSync(join(ROOT, 'vevdemo-1.0.6/fe/index.js'), 'utf8');
const actionsJs = readFileSync(join(ROOT, 'vevdemo-1.0.6/fe/actions.js'), 'utf8');
const materialTs = readFileSync(join(ROOT, 'vevdemo-1.0.6/fe/material.ts'), 'utf8');
const oeJs = readFileSync(join(ROOT, 'public/modules/online_editor.js'), 'utf8');
const workspaceHtml = readFileSync(join(ROOT, 'public/workspace.html'), 'utf8');

// ── 1. 哨兵：旧 text lane 路线必须断开 ──────────────────────────
assert(!shellJs.includes('function buildSubtitleLaneFromPlan'), 'fe/index.js 不应再保留 buildSubtitleLaneFromPlan');
assert(!shellJs.includes('subtitleApplied'), '铺轨结果不应再上报 subtitleApplied 假成功');
assert(!shellJs.includes('OriginSubtitle'), 'bridge 不应再构造 OriginSubtitle text item');
assert(!/track\.push\(subtitleLane\)/.test(shellJs), 'buildTrackFromOriginPlan 不应 push subtitleLane');

// ── 2. 哨兵：subtitle material 路线必须在场 ──────────────────────
assert(materialTs.includes("type: 'subtitle'") && materialTs.includes("format: ['srt', 'vtt', 'ass']") && materialTs.includes("fileType: 'object'"), 'material.ts 必须声明 subtitle srt object');
assert(shellJs.includes("import { getType } from './util.js'"), 'bridge 必须导入 getType 做 srt preflight');
assert(shellJs.includes("getType('srt')"), 'bridge 必须显式 preflight getType("srt")');
assert(shellJs.includes("new File([srtText], filename, { type: 'subtitle/srt' })"), 'SRT File MIME 必须让 getType 命中 srt');
assert(shellJs.includes('function findSubtitleMaterialByName'), 'bridge 必须按 Name 做字幕防重');
assert(shellJs.includes('function uploadSubtitleFile') && shellJs.includes('new Promise'), 'uploadMaterial callback 必须被 Promise 包装');
assert(shellJs.includes('function readBackSubtitleMaterial') && shellJs.includes('EditMids: [editMid]'), '注册后必须强制 SearchEditMaterial 回读');
assert(shellJs.includes('registerOriginMaterialToVevDemo(material)'), 'subtitle material 必须走 CreateEditMaterial 注册');
assert(shellJs.includes('upload_result_missing_source'), '上传无可注册 source 时必须显式报 upload_result_missing_source');
assert(shellJs.includes("case 'origin:importSubtitles'"), 'bridge 必须监听 origin:importSubtitles');
assert(oeJs.includes("origin:importSubtitles"), 'Origin 必须发送独立字幕导入消息');
assert(oeJs.includes('origin-subtitles-${originProjectId}-v${edlVersion}.srt'), '字幕文件名必须按 projectId+edlVersion 防重');
assert(oeJs.includes('OEV_SUBTITLE_IMPORT_ACK_TIMEOUT_MS = 120000'), '字幕导入必须有独立 120s 回执预算');

// ── 3. 哨兵：自动铺轨根因锁 ────────────────────────────────────
const autoFn = extract(oeJs, '_autoSyncCurrentEdlVideosToVevDemo');
assert(autoFn.indexOf('_ensureCurrentVideosEdlForVevDemo') >= 0, '自动路径必须调用 ensure');
assert(autoFn.indexOf('_ensureCurrentVideosEdlForVevDemo') < autoFn.indexOf('_collectCurrentEdlVideoResourceIds'), '自动路径 ensure 必须早于 EDL ids 采集');
const importFn = extract(oeJs, 'importMaterialsToVevDemo');
assert(importFn.indexOf('_ensureCurrentVideosEdlForVevDemo') >= 0, '手动同步路径必须调用 ensure');
assert(importFn.indexOf('_ensureCurrentVideosEdlForVevDemo') < importFn.indexOf('_collectCurrentVideoResourceIds'), '手动同步 ensure 必须早于素材 ids 采集');
assert(oeJs.includes("mode: 'fill-if-empty'"), 'applyTimeline 必须发送 fill-if-empty policy');

// ── 4. 哨兵：object subtitle 上传参数 ───────────────────────────
assert(/RecordType:\s*category === 'image' \|\| fileType\.fileType === 'object' \? 2 : undefined/.test(actionsJs), 'object 上传必须设置 RecordType:2');

// ── 5. 哨兵：缓存入口 ─────────────────────────────────────────
assert(workspaceHtml.includes('"/modules/online_editor.js": "/modules/online_editor.js?v=25"'), 'workspace import map 应引用 online_editor.js?v=25');

// ── 6. 行为：SRT 序列化 ───────────────────────────────────────
const oeSandbox = new Function(`
  ${extract(oeJs, '_formatSrtTimestamp')}
  ${extract(oeJs, '_buildSrtFromVevSubtitleCues')}
  return { _formatSrtTimestamp, _buildSrtFromVevSubtitleCues };
`)();
assert(oeSandbox._formatSrtTimestamp(3723.456) === '01:02:03,456', 'SRT 时间格式应为 HH:MM:SS,mmm');
const srt = oeSandbox._buildSrtFromVevSubtitleCues([
  { text: '第一句', startSec: 0.15, endSec: 2.3 },
  { text: '  ', startSec: 2.4, endSec: 3 },
  { text: '第二句\n下一行', startSec: 3, endSec: 4.9 },
  { text: '非法', startSec: 5, endSec: 4 },
]);
assert(srt.includes('1\n00:00:00,150 --> 00:00:02,300\n第一句'), 'SRT 应包含首条 cue');
assert(srt.includes('2\n00:00:03,000 --> 00:00:04,900\n第二句\n下一行'), 'SRT 应保留规范化换行');
assert(!srt.includes('非法') && srt.endsWith('\n'), 'SRT 应跳过非法 cue 并以换行结尾');

// ── 7. 行为：递归判空和上传 source 提取 ────────────────────────
const shellSandbox = new Function('console', `
  ${extract(shellJs, 'readFirst')}
  ${extract(shellJs, 'isSupportedVevSource')}
  ${extract(shellJs, 'countTrackItemsByType')}
  ${extract(shellJs, 'extractSupportedSubtitleVevSource')}
  return { countTrackItemsByType, extractSupportedSubtitleVevSource };
`)({ info() {}, warn() {} });

const nestedTrack = [[
  { Type: 'video', Source: 'vid://v1', TargetTime: [0, 1000] },
  { Type: 'audio', Source: 'vid://a1', TargetTime: [0, 1000] },
], { lanes: [{ Type: 'text', Text: '字幕', TargetTime: [0, 1000] }] }];
assert(shellSandbox.countTrackItemsByType(nestedTrack) === 3, '递归 Type 计数应统计无 ID 的 Origin/SDK 项');
assert(shellSandbox.countTrackItemsByType(nestedTrack, 'video') === 1, '递归 Type 计数应支持 type 过滤');
assert(shellSandbox.extractSupportedSubtitleVevSource({ info: { Source: 'tos://bucket/key.srt' } }).vevSource === 'tos://bucket/key.srt', 'Source 应优先作为 vevSource');
assert(shellSandbox.extractSupportedSubtitleVevSource({ info: { Vid: 'v123' } }).vevSource === 'vid://v123', 'Vid 应转换为 vid://');
const missing = shellSandbox.extractSupportedSubtitleVevSource({ info: { Mid: 'm1', Oid: 'o1' } });
assert(!missing.vevSource && missing.mid === 'm1' && missing.oid === 'o1', 'Mid/Oid 不应直接作为可注册 source');

if (failures.length) {
  console.error(`✗ ${failures.length} 处断言失败：`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}

console.log('✓ subtitle material import contract passed（哨兵+行为 共 34 断言）');
