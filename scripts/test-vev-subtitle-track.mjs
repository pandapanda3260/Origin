/**
 * VevDemo subtitle material import contract.
 *
 * 字幕只走官方素材路径：
 *   Origin 生成 SRT -> bridge 上传 object subtitle -> CreateEditMaterial -> SearchEditMaterial 回读。
 *
 * 不再通过 UpdateProject 直写 Type:'text' 轨道；当前 VevDemo 会接受更新但回读丢失 text item。
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

// ── 1. 哨兵：applyTimeline 仍不得夹带字幕轨 ─────────────────────
const buildTimelineTrackFn = extract(shellJs, 'buildTrackFromOriginPlan');
assert(!buildTimelineTrackFn.includes('subtitleLane'), 'buildTrackFromOriginPlan 不应夹带字幕 lane');
assert(!/track\.push\(subtitleLane\)/.test(buildTimelineTrackFn), 'buildTrackFromOriginPlan 不应 push subtitleLane');

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
assert(shellJs.includes('function rememberSubtitleMaterialTitle'), 'subtitle material 回读后必须缓存字幕文件名');
assert(shellJs.includes('latestSubtitleTitle'), 'subtitle material 必须记录最新字幕标题用于未知类型展示兜底');
assert(shellJs.includes('rememberOriginMaterialTitle({') && shellJs.includes('{ persist: true }'), 'subtitle material 标题缓存必须跨素材标题刷新保留');
assert(shellJs.includes('未知\\s*Item|Unknown\\s*Item'), 'subtitle material 必须兜底替换 VevDemo 的未知 Item 展示');
assert(shellJs.includes('function enhanceSubtitleEditMaterialItem') && shellJs.includes('OriginSubtitleMaterial'), 'subtitle material 搜索结果必须补全字幕素材字段');
assert(shellJs.includes('function polishOriginSubtitleMaterialCards') && shellJs.includes('origin-subtitle-file-badge'), 'subtitle material 必须有素材区卡片 UI 兜底');
assert(shellJs.includes("case 'origin:importSubtitles'"), 'bridge 必须监听 origin:importSubtitles');
assert(oeJs.includes("origin:importSubtitles"), 'Origin 必须发送独立字幕导入消息');
assert(oeJs.includes('origin-subtitles-${originProjectId}-v${edlVersion}.srt'), '字幕文件名必须按 projectId+edlVersion 防重');
assert(oeJs.includes('OEV_SUBTITLE_IMPORT_ACK_TIMEOUT_MS = 120000'), '字幕导入必须有独立 120s 回执预算');
assert(oeJs.includes('function _buildCurrentVevSubtitlePlan'), '手动字幕导入必须有独立字幕 plan，不依赖素材 source');
const manualSubtitleFn = extract(oeJs, 'importCurrentSubtitlesToVevDemo');
assert(manualSubtitleFn.includes('_buildCurrentVevSubtitlePlan'), '手动字幕导入必须直接从当前 EDL 构造字幕 plan');
assert(!manualSubtitleFn.includes('_postMaterialImport'), '手动字幕导入不应因素材同步/旧工程 binding 阻塞');
assert(!manualSubtitleFn.includes('_assertVevMaterialsBelongToBoundProject'), '手动字幕导入不应做视频素材工程归属校验');

// ── 3. 哨兵：禁止恢复直写字幕 text lane 的失败路径 ───────────────
assert(!shellJs.includes('function buildSubtitleLaneFromPlan'), 'bridge 不应再构造字幕 text lane');
assert(!shellJs.includes('function handleOriginApplySubtitles'), 'bridge 不应再提供字幕落轨 handler');
assert(!shellJs.includes("case 'origin:applySubtitles'"), 'bridge 不应再监听 origin:applySubtitles');
assert(!shellJs.includes("postToOrigin('vevdemo:subtitlesApplied'"), 'bridge 不应再返回字幕落轨回执');
assert(!shellJs.includes("OriginSubtitleSource: 'origin'"), 'bridge 不应再写 Origin 字幕 text item');
assert(!shellJs.includes('function buildTrackWithOriginSubtitles'), 'bridge 不应再合并字幕 text lane');
assert(!shellJs.includes('function resolveTimelineTimeUnitForSubtitleApply'), 'bridge 不应再为字幕直写推断时间单位');
assert(!oeJs.includes('function _sendSubtitleApplyToVevDemo'), 'Origin 不应再发送字幕落轨消息');
assert(!oeJs.includes("origin:applySubtitles"), 'Origin 不应再发送 origin:applySubtitles');
assert(!oeJs.includes("vevdemo:subtitlesApplied"), 'Origin 不应再等待 vevdemo:subtitlesApplied');
assert(!oeJs.includes('function _applyCurrentVevSubtitlesToTimeline'), 'Origin 不应再保留字幕落轨封装');
assert(!manualSubtitleFn.includes('_applyCurrentVevSubtitlesToTimeline'), '手动导入字幕成功后只应导入素材库，不应尝试落轨');

// ── 4. 哨兵：自动铺轨根因锁 ────────────────────────────────────
const autoFn = extract(oeJs, '_autoSyncCurrentEdlVideosToVevDemo');
assert(autoFn.indexOf('_ensureCurrentVideosEdlForVevDemo') >= 0, '自动路径必须调用 ensure');
assert(autoFn.indexOf('_ensureCurrentVideosEdlForVevDemo') < autoFn.indexOf('_collectCurrentEdlVideoResourceIds'), '自动路径 ensure 必须早于 EDL ids 采集');
const importFn = extract(oeJs, 'importMaterialsToVevDemo');
assert(importFn.indexOf('_ensureCurrentVideosEdlForVevDemo') >= 0, '手动同步路径必须调用 ensure');
assert(importFn.indexOf('_ensureCurrentVideosEdlForVevDemo') < importFn.indexOf('_collectCurrentVideoResourceIds'), '手动同步 ensure 必须早于素材 ids 采集');
assert(oeJs.includes("mode: 'fill-if-empty'"), 'applyTimeline 必须发送 fill-if-empty policy');

// ── 5. 哨兵：object subtitle 上传参数 ───────────────────────────
assert(/RecordType:\s*category === 'image' \|\| fileType\.fileType === 'object' \? 2 : undefined/.test(actionsJs), 'object 上传必须设置 RecordType:2');

// ── 6. 哨兵：缓存入口 ─────────────────────────────────────────
assert(workspaceHtml.includes('"/modules/online_editor.js": "/modules/online_editor.js?v=29"'), 'workspace import map 应引用 online_editor.js?v=29');
assert(workspaceHtml.includes('id="oeBtnImportSubtitles"'), 'Origin 顶栏必须提供手动导入字幕入口');
assert(shellJs.includes("uploadAccept: 'image/*,.mp3,.mp4,.webm,.srt,.vtt,.ass'"), 'VevDemo 本地上传必须允许字幕文件扩展名');

// ── 7. 行为：SRT 序列化 ───────────────────────────────────────
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

// ── 8. 行为：递归判空和上传 source 提取 ────────────────────────
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
assert(shellSandbox.extractSupportedSubtitleVevSource({ info: { uploadResult: { Source: 'mid://i123' } } }).vevSource === 'mid://i123', 'uploadResult.Source 应作为 vevSource');
assert(shellSandbox.extractSupportedSubtitleVevSource({ info: { uploadResult: { Vid: 'v456' } } }).vevSource === 'vid://v456', 'uploadResult.Vid 应转换为 vid://');
const midSource = shellSandbox.extractSupportedSubtitleVevSource({ info: { uploadResult: { Mid: 'i789', Oid: 'o1' } } });
assert(midSource.vevSource === 'mid://i789' && midSource.mid === 'i789' && midSource.oid === 'o1', 'uploadResult.Mid 应转换为 mid://');
const missing = shellSandbox.extractSupportedSubtitleVevSource({ info: { uploadResult: { Oid: 'o1' } } });
assert(!missing.vevSource && !missing.mid && missing.oid === 'o1', '只有 Oid 时不应伪造可注册 source');

if (failures.length) {
  console.error(`✗ ${failures.length} 处断言失败：`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}

console.log('✓ subtitle material import contract passed');
