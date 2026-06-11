import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { getDataDir } from '../lib/runtime-paths';
import { buildVideoSegmentNamesForRow } from '../lib/video-segment-names';

type Row = {
  id: string;
  owner_id: number;
  project_id: string;
  group_idx: number;
  filename: string;
  created_at?: string | null;
  project_title?: string | null;
  project_data_json?: string | null;
};

type PlannedChange = {
  row: Row;
  oldFilename: string;
  newFilename: string;
  oldPath: string;
  newPath: string;
  oldExists: boolean;
  newExists: boolean;
};

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const dataDir = valueAfter('--data-dir') || getDataDir();
const dbPath = valueAfter('--db') || join(dataDir, 'qd.sqlite');

function valueAfter(flag: string): string | null {
  const rawArgs = process.argv.slice(2);
  const idx = rawArgs.indexOf(flag);
  if (idx >= 0 && rawArgs[idx + 1]) return rawArgs[idx + 1];
  const inline = rawArgs.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

function safeVideoPath(ownerId: number, filename: string) {
  const ownerDir = resolve(dataDir, 'videos', String(ownerId));
  const target = resolve(ownerDir, filename);
  if (target !== ownerDir && !target.startsWith(ownerDir + sep)) {
    throw new Error(`unsafe video filename for ${ownerId}: ${filename}`);
  }
  return target;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupFile(sourcePath: string, suffix: string) {
  if (!existsSync(sourcePath)) return null;
  const backupPath = join(dataDir, 'backups', `${suffix}-${timestamp()}.bak`);
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(sourcePath, backupPath);
  return backupPath;
}

function updateVevBindings(changes: PlannedChange[]) {
  const bindingsPath = join(dataDir, 'vevdemo-material-bindings.json');
  if (!existsSync(bindingsPath)) return { changed: 0, backupPath: null as string | null };
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(bindingsPath, 'utf8') || '{}');
  } catch (error) {
    throw new Error(`failed to parse ${bindingsPath}: ${(error as Error).message}`);
  }
  const materials = parsed && typeof parsed === 'object' && parsed.materials && typeof parsed.materials === 'object'
    ? parsed.materials
    : {};
  const byId = new Map(changes.map((change) => [change.row.id, change]));
  let changed = 0;
  for (const entry of Object.values(materials) as any[]) {
    if (!entry || entry.resourceType !== 'video_task') continue;
    const change = byId.get(String(entry.resourceId || ''));
    if (!change) continue;
    if (entry.originFilePath !== change.newPath) {
      entry.originFilePath = change.newPath;
      changed += 1;
    }
    if (entry.title !== change.newFilename) {
      entry.title = change.newFilename;
      changed += 1;
    }
  }
  if (!apply || changed <= 0) return { changed, backupPath: null };
  const backupPath = backupFile(bindingsPath, 'vevdemo-material-bindings.video-segment-filenames');
  writeFileSync(bindingsPath, JSON.stringify(parsed, null, 2) + '\n');
  return { changed, backupPath };
}

function displayNameFromFilename(filename: string) {
  return String(filename || '').replace(/\.mp4$/i, '');
}

function segmentProjectKeyFromFilename(filename: string) {
  const raw = displayNameFromFilename(String(filename || '').trim());
  const legacy = raw.match(/^片段[0-9]+(?:(?:（[0-9]+）)|(?:\([0-9]+\)))?_第(.+?)集_(.+)$/u);
  if (legacy) return `${legacy[2]}\t第${legacy[1]}集`;
  const current = raw.match(/^片段[0-9]+(?:(?:（[0-9]+）)|(?:\([0-9]+\)))?(.+)第(.+?)集$/u);
  if (current) return `${current[1]}\t第${current[2]}集`;
  return '';
}

function textHasTaskId(value: unknown, taskId: string) {
  return typeof value === 'string' && taskId && value.includes(taskId);
}

function objectMatchesVideoTask(value: any, change: PlannedChange) {
  if (!value || typeof value !== 'object') return false;
  const taskId = change.row.id;
  const ids = [
    value.videoTaskId,
    value.taskId,
    value.serverTaskId,
    value.id,
    value.clipId,
    value.mediaId,
    value.resourceId,
  ].map((item) => String(item || '').trim()).filter(Boolean);
  if (ids.includes(taskId)) return true;
  return [
    value.videoUrl,
    value._originVideoUrl,
    value.protectedUrl,
    value.url,
  ].some((item) => textHasTaskId(item, taskId));
}

function assignVideoNameFields(value: any, change: PlannedChange, storyboard = false) {
  if (!value || typeof value !== 'object') return false;
  const displayName = displayNameFromFilename(change.newFilename);
  let touched = false;
  const fields = storyboard
    ? {
        videoFilename: change.newFilename,
        videoDisplayName: displayName,
        videoDownloadFilename: change.newFilename,
      }
    : {
        filename: change.newFilename,
        displayName,
        downloadFilename: change.newFilename,
      };
  for (const [key, next] of Object.entries(fields)) {
    if (value[key] !== next) {
      value[key] = next;
      touched = true;
    }
  }
  if (!storyboard) {
    if (value._mediaName !== displayName) {
      value._mediaName = displayName;
      touched = true;
    }
  }
  return touched;
}

function updateProjectJson(db: any, changes: PlannedChange[]) {
  const grouped = new Map<string, PlannedChange[]>();
  for (const change of changes) {
    const key = `${change.row.owner_id}\t${change.row.project_id}`;
    const list = grouped.get(key) || [];
    list.push(change);
    grouped.set(key, list);
  }

  const selectProject = db.prepare('SELECT id, owner_id, data_json FROM projects WHERE id = ? AND owner_id = ?');
  const updateProject = db.prepare(
    `UPDATE projects
        SET data_json = @dataJson,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = @id AND owner_id = @ownerId`,
  );

  let projectsTouched = 0;
  let jsonFieldsUpdated = 0;
  for (const list of grouped.values()) {
    const first = list[0];
    const projectRow = selectProject.get(first.row.project_id, first.row.owner_id) as any;
    if (!projectRow) continue;
    let data: any;
    try {
      data = JSON.parse(projectRow.data_json || '{}');
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    let touched = false;
    const storyboards = Array.isArray(data.storyboards) ? data.storyboards : [];
    const videoTasks = Array.isArray(data.videoTasks) ? data.videoTasks : [];
    const timeline = Array.isArray(data?.editData?.edl?.timeline) ? data.editData.edl.timeline : [];

    for (const change of list) {
      const groupIdx = Number(change.row.group_idx);
      const sb = storyboards[groupIdx];
      if (objectMatchesVideoTask(sb, change)) {
        if (assignVideoNameFields(sb, change, true)) {
          touched = true;
          jsonFieldsUpdated += 1;
        }
      }
      const vt = videoTasks[groupIdx];
      if (objectMatchesVideoTask(vt, change)) {
        if (assignVideoNameFields(vt, change, false)) {
          touched = true;
          jsonFieldsUpdated += 1;
        }
      }
      for (const entry of timeline) {
        if (!objectMatchesVideoTask(entry, change)) continue;
        if (assignVideoNameFields(entry, change, false)) {
          touched = true;
          jsonFieldsUpdated += 1;
        }
      }
    }
    if (touched) {
      updateProject.run({
        id: projectRow.id,
        ownerId: Number(projectRow.owner_id),
        dataJson: JSON.stringify(data),
      });
      projectsTouched += 1;
    }
  }
  return { projectsTouched, jsonFieldsUpdated };
}

async function main() {
  if (!existsSync(dbPath)) throw new Error(`DB not found: ${dbPath}`);
  const db = new Database(dbPath);
  const rows = db.prepare(
    `SELECT vt.id, vt.owner_id, vt.project_id, vt.group_idx, vt.filename, vt.created_at,
            p.title AS project_title, p.data_json AS project_data_json
       FROM video_tasks vt
       LEFT JOIN projects p ON p.id = vt.project_id AND p.owner_id = vt.owner_id
      WHERE vt.filename IS NOT NULL AND vt.filename <> ''
        AND vt.group_idx IS NOT NULL
        AND (
          (vt.project_id IS NOT NULL AND vt.project_id <> '')
          OR vt.filename GLOB '片段*_第*集_*.mp4'
          OR vt.filename GLOB '片段*第*集.mp4'
        )
      ORDER BY vt.owner_id ASC, vt.project_id ASC, vt.group_idx ASC, vt.created_at ASC, vt.id ASC`,
  ).all() as Row[];

  const planned: PlannedChange[] = [];
  const copyCounts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.owner_id}\t${row.project_id || row.project_title || segmentProjectKeyFromFilename(row.filename) || 'projectless'}\t${row.group_idx}`;
    const copyIndex = (copyCounts.get(key) || 0) + 1;
    copyCounts.set(key, copyIndex);
    const names = buildVideoSegmentNamesForRow(row, undefined, {
      copyIndex,
      preferStoredFilename: false,
    });
    const oldFilename = String(row.filename || '').trim();
    const newFilename = names.filename;
    if (!oldFilename || oldFilename === newFilename) continue;
    const oldPath = safeVideoPath(Number(row.owner_id), oldFilename);
    const newPath = safeVideoPath(Number(row.owner_id), newFilename);
    planned.push({
      row,
      oldFilename,
      newFilename,
      oldPath,
      newPath,
      oldExists: existsSync(oldPath),
      newExists: existsSync(newPath),
    });
  }

  const conflicts = planned.filter((change) => change.oldExists && change.newExists);
  const missing = planned.filter((change) => !change.oldExists && !change.newExists);
  if (conflicts.length) {
    console.error(JSON.stringify({
      ok: false,
      apply,
      scanned: rows.length,
      planned: planned.length,
      conflicts: conflicts.map((c) => ({ id: c.row.id, old: c.oldPath, next: c.newPath })),
      missingFiles: missing.length,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  let dbBackupPath: string | null = null;
  if (apply && planned.length) {
    const backupDir = join(dataDir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    dbBackupPath = join(backupDir, `qd.sqlite.video-segment-filenames-${timestamp()}.bak`);
    await db.backup(dbBackupPath);
  }

  let renamed = 0;
  if (apply) {
    for (const change of planned) {
      if (change.oldExists && !change.newExists) {
        mkdirSync(dirname(change.newPath), { recursive: true });
        renameSync(change.oldPath, change.newPath);
        renamed += 1;
      }
    }
  }

  let videoTaskUpdated = 0;
  let assetUpdated = 0;
  let projectJsonUpdated = { projectsTouched: 0, jsonFieldsUpdated: 0 };
  if (apply && planned.length) {
    const updateVideo = db.prepare(
      `UPDATE video_tasks
          SET filename = @filename,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = @id AND owner_id = @ownerId`,
    );
    const updateAssets = db.prepare(
      `UPDATE assets
          SET file_uri = @newUri,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE owner_id = @ownerId
          AND asset_kind = 'video'
          AND (asset_id = @id OR file_uri = @oldUri)`,
    );
    const txn = db.transaction((changes: PlannedChange[]) => {
      for (const change of changes) {
        videoTaskUpdated += updateVideo.run({
          id: change.row.id,
          ownerId: Number(change.row.owner_id),
          filename: change.newFilename,
        }).changes;
        assetUpdated += updateAssets.run({
          id: change.row.id,
          ownerId: Number(change.row.owner_id),
          oldUri: `local://videos/${change.row.owner_id}/${change.oldFilename}`,
          newUri: `local://videos/${change.row.owner_id}/${change.newFilename}`,
        }).changes;
      }
      projectJsonUpdated = updateProjectJson(db, changes);
    });
    txn(planned);
  }

  const vev = updateVevBindings(planned);
  const sample = planned.slice(0, 8).map((change) => ({
    id: change.row.id,
    ownerId: change.row.owner_id,
    groupIdx: change.row.group_idx,
    oldFilename: change.oldFilename,
    newFilename: change.newFilename,
    bytes: apply && existsSync(change.newPath) ? statSync(change.newPath).size : undefined,
  }));

  console.log(JSON.stringify({
    ok: true,
    apply,
    dbPath,
    dataDir,
    scanned: rows.length,
    planned: planned.length,
    missingFiles: missing.length,
    renamed,
    videoTaskUpdated,
    assetUpdated,
    projectJsonProjectsTouched: projectJsonUpdated.projectsTouched,
    projectJsonFieldsUpdated: projectJsonUpdated.jsonFieldsUpdated,
    vevBindingsUpdated: vev.changed,
    dbBackupPath,
    vevBackupPath: vev.backupPath,
    sample,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
