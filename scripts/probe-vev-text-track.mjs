/**
 * 【一次性探针，用完即删】VevDemo 文本轨 schema 取样
 *
 * 目的（2026-06-10，字幕→剪辑器文本轨 方向A 前置验证）：
 *   在剪辑器里手动加过"文字"片段后，跑本脚本把工程 EditParam.Track 拉下来，
 *   看火山真实的文本片段字段结构（Type/Content/TargetTime/样式字段……），
 *   作为自动铺字幕轨的 schema 依据。
 *
 * 用法：node scripts/probe-vev-text-track.mjs
 *   结果写到 vev-text-track-probe.result.json（项目根），控制台打精简结论。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function readEnvFile(file) {
  const map = {};
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) map[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return map;
}

const envLocal = readEnvFile(join(ROOT, '.env.local'));
const env = (key) => (process.env[key] || envLocal[key] || '').trim().replace(/\/+$/, '');
const apiBase = env('VITE_VEVDEMO_API_BASE') || env('VEVDEMO_API_URL') || env('VEVDEMO_BACKEND_URL') || 'http://127.0.0.1:3002';

async function postJson(pathname, body) {
  const res = await fetch(`${apiBase}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, httpStatus: res.status }; }
}

const bindingsFile = join(ROOT, 'data', 'vevdemo-project-bindings.json');
const bindings = JSON.parse(readFileSync(bindingsFile, 'utf8'));
const projects = Object.values(bindings.projects || {});
if (!projects.length) {
  console.error('没有任何 VevDemo 工程绑定，先打开过剪辑器再跑');
  process.exit(1);
}

const KNOWN_AV_TYPES = new Set(['video', 'audio']);
const report = { apiBase, probedAt: new Date().toISOString(), projects: [] };
let textSamples = 0;

for (const b of projects) {
  const entry = {
    originProjectId: b.originProjectId,
    originTitle: b.originTitle || '',
    vevProjectId: b.vevProjectId,
    trackTypeCounts: {},
    nonAvItems: [],
    error: null,
  };
  try {
    const data = await postJson('/api/describeProject', {
      ProjectId: b.vevProjectId,
      GroupId: b.vevGroupId,
    });
    const result = data?.Result || data?.result || {};
    let editParam = result.EditParam ?? result.LatestEditParam ?? null;
    if (typeof editParam === 'string') {
      try { editParam = JSON.parse(editParam); } catch { /* keep string */ }
    }
    // 时间单位拦截诊断：这些标记决定 resolveTimelineTimeUnit 走哪个分支
    entry.timeUnitMarkers = {
      OriginTimelineTimeUnit: editParam?.OriginTimelineTimeUnit ?? null,
      OriginTimelineTimeUnitSource: editParam?.OriginTimelineTimeUnitSource ?? null,
      appliedTimeline: editParam?.OriginAppliedTimeline ? {
        bridgeVersion: editParam.OriginAppliedTimeline.bridgeVersion ?? null,
        timeUnit: editParam.OriginAppliedTimeline.timeUnit ?? null,
        timeUnitSource: editParam.OriginAppliedTimeline.timeUnitSource ?? null,
        appliedAt: editParam.OriginAppliedTimeline.appliedAt ?? null,
        edlVersion: editParam.OriginAppliedTimeline.edlVersion ?? null,
      } : null,
    };
    const track = editParam && typeof editParam === 'object' ? editParam.Track : null;
    if (!Array.isArray(track)) {
      entry.error = `无 Track（EditParam ${editParam ? '存在但无轨道' : '为空'}）`;
    } else {
      entry.laneSummaries = track.map((lane, laneIdx) => {
        const items = Array.isArray(lane) ? lane : [];
        return {
          laneIdx,
          count: items.length,
          types: [...new Set(items.map((it) => String(it?.Type ?? it?.type ?? '(none)').toLowerCase()))],
          // 时间样本：用于人工核对 ms/us 与片段时长是否对得上
          samples: items.slice(0, 3).map((it) => ({
            type: String(it?.Type ?? it?.type ?? '(none)').toLowerCase(),
            targetTime: it?.TargetTime ?? it?.targetTime ?? null,
            sourceTime: it?.SourceTime ?? it?.sourceTime ?? null,
            originGroupIdx: it?.OriginGroupIdx ?? null,
            originResourceId: it?.OriginResourceId ?? null,
            text: typeof it?.Text === 'string' ? it.Text.slice(0, 20) : undefined,
          })),
        };
      });
      track.forEach((lane, laneIdx) => {
        (Array.isArray(lane) ? lane : []).forEach((item) => {
          const type = String(item?.Type ?? item?.type ?? '(none)').toLowerCase();
          entry.trackTypeCounts[`lane${laneIdx}:${type}`] = (entry.trackTypeCounts[`lane${laneIdx}:${type}`] || 0) + 1;
          if (!KNOWN_AV_TYPES.has(type)) {
            entry.nonAvItems.push({ laneIdx, item });
            textSamples += 1;
          }
        });
      });
    }
  } catch (err) {
    entry.error = err?.message || String(err);
  }
  report.projects.push(entry);
  console.log(`${entry.originTitle || entry.originProjectId} → ${entry.error || JSON.stringify(entry.trackTypeCounts)}`);
  if (entry.timeUnitMarkers) {
    console.log(`  时间单位标记: unit=${entry.timeUnitMarkers.OriginTimelineTimeUnit} source=${entry.timeUnitMarkers.OriginTimelineTimeUnitSource} bridge=${entry.timeUnitMarkers.appliedTimeline?.bridgeVersion || '(无)'}`);
  }
}

const outFile = join(ROOT, 'vev-text-track-probe.result.json');
writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n非视频/音频片段样本数：${textSamples}`);
console.log(`完整结果已写入：${outFile}`);
if (!textSamples) {
  console.log('⚠ 没采到文本片段——请先在剪辑器里用左侧"文字"面板加一条文字到时间线，等右上角"所有更改已保存"后重跑。');
}
