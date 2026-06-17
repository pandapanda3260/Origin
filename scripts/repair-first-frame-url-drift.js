#!/usr/bin/env node
/* eslint-disable no-console */
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const MAX_HISTORY = 30;

function usage() {
  console.log(`Usage:
  node scripts/repair-first-frame-url-drift.js --project-id <id> [--db data/qd.sqlite] [--apply]

Options:
  --project-id <id>  Required project id to scan or repair.
  --db <path>        SQLite path. Defaults to DB_PATH or data/qd.sqlite.
  --backup-dir <dir> Backup directory for --apply. Defaults beside the DB.
  --apply            Write repairs. Without this flag the script is dry-run.
  --help             Show this message.`);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'qd.sqlite'),
    projectId: '',
    backupDir: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--db') {
      args.dbPath = argv[++i] || '';
      continue;
    }
    if (arg === '--project-id') {
      args.projectId = argv[++i] || '';
      continue;
    }
    if (arg === '--backup-dir') {
      args.backupDir = argv[++i] || '';
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.projectId) throw new Error('--project-id is required');
  if (!args.dbPath) throw new Error('--db cannot be empty');
  args.dbPath = path.resolve(args.dbPath);
  args.backupDir = args.backupDir
    ? path.resolve(args.backupDir)
    : path.dirname(args.dbPath);
  return args;
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanUrl(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function firstFrameCanonical(storyboard) {
  return (
    cleanUrl(storyboard?.firstFrame?.currentUrl) ||
    cleanUrl(storyboard?.firstFrameUrl) ||
    cleanUrl(storyboard?.frames?.first?.url)
  );
}

function collectUrlFields(storyboard) {
  return [
    ['url', storyboard?.url],
    ['imageUrl', storyboard?.imageUrl],
    ['rawUrl', storyboard?.rawUrl],
    ['firstFrameUrl', storyboard?.firstFrameUrl],
    ['firstFrame.currentUrl', storyboard?.firstFrame?.currentUrl],
    ['firstFrame.rawUrl', storyboard?.firstFrame?.rawUrl],
    ['firstFrame.lastKnownGoodUrl', storyboard?.firstFrame?.lastKnownGoodUrl],
    ['frames.first.url', storyboard?.frames?.first?.url],
  ].map(([field, value]) => ({ field, url: cleanUrl(value) }));
}

function hasFirstFrameRecord(storyboard) {
  return !!(
    cleanUrl(storyboard?.firstFrameUrl) ||
    cleanUrl(storyboard?.firstFrame?.currentUrl) ||
    cleanUrl(storyboard?.frames?.first?.url)
  );
}

function historyHasUrl(history, url) {
  return history.some((entry) => (
    cleanUrl(entry?.url) === url ||
    cleanUrl(entry?.rawUrl) === url ||
    cleanUrl(entry?.imageUrl) === url ||
    cleanUrl(entry?.currentUrl) === url
  ));
}

function historyEntriesForOverwrittenUrls(storyboard, canonicalUrl, now) {
  const history = Array.isArray(storyboard?.imageHistory) ? storyboard.imageHistory : [];
  const seen = new Set();
  const entries = [];
  for (const item of collectUrlFields(storyboard)) {
    if (!item.url || item.url === canonicalUrl || seen.has(item.url) || historyHasUrl(history, item.url)) {
      continue;
    }
    seen.add(item.url);
    entries.push({
      url: item.url,
      at: now,
      source: 'first_frame_url_drift_repair',
      repairedField: item.field,
    });
  }
  return entries;
}

function repairStoryboard(storyboard, now) {
  if (!isObject(storyboard) || !hasFirstFrameRecord(storyboard)) {
    return { changed: false, storyboard, canonicalUrl: '', driftFields: [], missingFields: [] };
  }
  const canonicalUrl = firstFrameCanonical(storyboard);
  if (!canonicalUrl) {
    return { changed: false, storyboard, canonicalUrl: '', driftFields: [], missingFields: [] };
  }

  const driftFields = collectUrlFields(storyboard)
    .filter((item) => item.url && item.url !== canonicalUrl)
    .map((item) => item.field);
  const missingFields = collectUrlFields(storyboard)
    .filter((item) => !item.url)
    .map((item) => item.field);
  if (!driftFields.length && !missingFields.length) {
    return { changed: false, storyboard, canonicalUrl, driftFields: [], missingFields: [] };
  }

  const firstFrame = isObject(storyboard.firstFrame) ? storyboard.firstFrame : {};
  const frames = isObject(storyboard.frames) ? storyboard.frames : {};
  const first = isObject(frames.first) ? frames.first : {};
  const history = Array.isArray(storyboard.imageHistory) ? storyboard.imageHistory : [];
  const archived = historyEntriesForOverwrittenUrls(storyboard, canonicalUrl, now);
  const nextHistory = archived.length ? [...archived, ...history].slice(0, MAX_HISTORY) : history;

  return {
    changed: true,
    canonicalUrl,
    driftFields,
    missingFields,
    storyboard: {
      ...storyboard,
      url: canonicalUrl,
      imageUrl: canonicalUrl,
      rawUrl: canonicalUrl,
      firstFrameUrl: canonicalUrl,
      imageHistory: nextHistory,
      firstFrame: {
        ...firstFrame,
        currentUrl: canonicalUrl,
        rawUrl: canonicalUrl,
        lastKnownGoodUrl: canonicalUrl,
      },
      frames: {
        ...frames,
        first: {
          ...first,
          url: canonicalUrl,
        },
      },
    },
  };
}

async function backupDatabase(db, dbPath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${path.basename(dbPath)}.first-frame-url-drift-${stamp}.bak`);
  await db.backup(backupPath);
  const checkDb = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = checkDb.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`backup integrity_check failed: ${integrity}`);
  } finally {
    checkDb.close();
  }
  return backupPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dbPath)) {
    throw new Error(`SQLite database not found: ${args.dbPath}`);
  }

  const db = new Database(args.dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    const row = db.prepare(
      'SELECT id, owner_id, version, data_json FROM projects WHERE id = ?',
    ).get(args.projectId);
    if (!row) {
      console.log(JSON.stringify({ ok: true, apply: args.apply, projectId: args.projectId, found: false }, null, 2));
      return;
    }

    const data = JSON.parse(row.data_json || '{}');
    const storyboards = Array.isArray(data.storyboards) ? data.storyboards : [];
    const now = new Date().toISOString();
    const changes = [];
    const nextStoryboards = storyboards.map((storyboard, index) => {
      const result = repairStoryboard(storyboard, now);
      if (result.changed) {
        changes.push({
          index,
          shotIdx: storyboard?.shotIdx || index + 1,
          canonicalUrl: result.canonicalUrl,
          driftFields: result.driftFields,
          missingFields: result.missingFields,
        });
      }
      return result.storyboard;
    });

    let backupPath = '';
    if (args.apply && changes.length) {
      backupPath = await backupDatabase(db, args.dbPath, args.backupDir);
      const nextData = { ...data, storyboards: nextStoryboards };
      db.prepare(
        `UPDATE projects
            SET data_json = ?,
                version = version + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`,
      ).run(JSON.stringify(nextData), row.id);
    }

    console.log(JSON.stringify({
      ok: true,
      apply: args.apply,
      projectId: row.id,
      ownerId: row.owner_id,
      versionBefore: row.version,
      versionAfter: args.apply && changes.length ? row.version + 1 : row.version,
      storyboardsScanned: storyboards.length,
      changeCount: changes.length,
      backupPath: backupPath || null,
      changes,
    }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('[repair-first-frame-url-drift] failed:', error?.message || error);
  process.exit(1);
});
