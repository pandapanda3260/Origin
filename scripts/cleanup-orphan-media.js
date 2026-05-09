#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const MEDIA_BUCKETS = ['images', 'videos', 'uploads', 'exports'];
const PROJECT_TABLES = ['images', 'video_tasks', 'uploads', 'exports', 'batches', 'continuity_cache', 'script_library_items'];

function parseArgs(argv) {
  const args = {
    db: process.env.DB_PATH || path.join('data', 'qd.sqlite'),
    apply: false,
    minAgeHours: 24,
    deleteUser: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--db') args.db = argv[++i];
    else if (arg.startsWith('--db=')) args.db = arg.slice('--db='.length);
    else if (arg === '--min-age-hours') args.minAgeHours = Number(argv[++i]);
    else if (arg.startsWith('--min-age-hours=')) args.minAgeHours = Number(arg.slice('--min-age-hours='.length));
    else if (arg === '--delete-user') args.deleteUser = argv[++i] || '';
    else if (arg.startsWith('--delete-user=')) args.deleteUser = arg.slice('--delete-user='.length);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.minAgeHours) || args.minAgeHours < 0) args.minAgeHours = 24;
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/cleanup-orphan-media.js [--db data/qd.sqlite] [--min-age-hours 24] [--apply]
  node scripts/cleanup-orphan-media.js --delete-user alice [--apply]

Default mode is dry-run and prints a JSON report.
Use --apply to delete orphan DB rows/files or the requested user data.
`);
}

function tableExists(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function all(db, sql, params = {}) {
  return db.prepare(sql).all(params);
}

function fileKey(ownerId, filename) {
  return `${ownerId}/${filename}`;
}

function safeFilePath(bucket, ownerId, filename) {
  const name = String(filename || '').trim();
  if (!MEDIA_BUCKETS.includes(bucket) || !name) return null;
  const base = path.resolve(process.cwd(), 'data', bucket, String(ownerId));
  const target = path.resolve(base, name);
  if (target === base || !target.startsWith(base + path.sep)) return null;
  return target;
}

function addFile(files, bucket, ownerId, filename, reason) {
  const fullPath = safeFilePath(bucket, ownerId, filename);
  if (!fullPath) return;
  files.set(fullPath, { bucket, ownerId, filename: String(filename), reason });
}

function imageBucket(row) {
  return row?.style === 'video-cover' || String(row?.asset_ref || '').startsWith('video-cover/') ? 'videos' : 'images';
}

function collectReferencedFiles(db) {
  const refs = {
    images: new Set(),
    videos: new Set(),
    uploads: new Set(),
    exports: new Set(),
  };
  if (tableExists(db, 'images')) {
    for (const row of all(db, "SELECT owner_id, filename, style, asset_ref FROM images WHERE filename IS NOT NULL AND filename <> ''")) {
      refs[imageBucket(row)].add(fileKey(row.owner_id, row.filename));
    }
  }
  if (tableExists(db, 'video_tasks')) {
    for (const row of all(db, "SELECT id, owner_id, filename FROM video_tasks WHERE filename IS NOT NULL AND filename <> ''")) {
      refs.videos.add(fileKey(row.owner_id, row.filename));
      refs.videos.add(fileKey(row.owner_id, `${row.id}.cover.png`));
    }
  }
  if (tableExists(db, 'uploads')) {
    for (const row of all(db, "SELECT owner_id, filename FROM uploads WHERE filename IS NOT NULL AND filename <> ''")) {
      refs.uploads.add(fileKey(row.owner_id, row.filename));
    }
  }
  if (tableExists(db, 'exports')) {
    for (const row of all(db, "SELECT owner_id, filename FROM exports WHERE filename IS NOT NULL AND filename <> ''")) {
      refs.exports.add(fileKey(row.owner_id, row.filename));
    }
  }
  return refs;
}

function collectOrphanProjectRows(db) {
  const projectIds = new Set(tableExists(db, 'projects') ? all(db, 'SELECT id FROM projects').map((row) => row.id) : []);
  const rows = {};
  for (const table of PROJECT_TABLES) {
    if (!tableExists(db, table)) continue;
    rows[table] = all(
      db,
      `SELECT * FROM ${table} WHERE project_id IS NOT NULL AND project_id <> ''`,
    ).filter((row) => !projectIds.has(row.project_id));
  }
  return rows;
}

function collectFilesForRows(rows) {
  const files = new Map();
  for (const row of rows.images || []) addFile(files, imageBucket(row), row.owner_id, row.filename, `orphan images:${row.project_id}`);
  for (const row of rows.video_tasks || []) {
    addFile(files, 'videos', row.owner_id, row.filename, `orphan video_tasks:${row.project_id}`);
    addFile(files, 'videos', row.owner_id, `${row.id}.cover.png`, `orphan video cover:${row.project_id}`);
  }
  for (const row of rows.uploads || []) addFile(files, 'uploads', row.owner_id, row.filename, `orphan uploads:${row.project_id}`);
  for (const row of rows.exports || []) {
    addFile(files, 'exports', row.owner_id, row.filename, `orphan exports:${row.project_id}`);
    addFile(files, 'exports', row.owner_id, `${row.id}.concat.mp4`, `orphan export temp:${row.project_id}`);
    addFile(files, 'exports', row.owner_id, `${row.id}.subbed.mp4`, `orphan export temp:${row.project_id}`);
    addFile(files, 'exports', row.owner_id, `${row.id}.sfx.mp4`, `orphan export temp:${row.project_id}`);
    addFile(files, 'exports', row.owner_id, `${row.id}.srt`, `orphan export temp:${row.project_id}`);
  }
  return files;
}

function collectUnreferencedFiles(db, minAgeHours) {
  const refs = collectReferencedFiles(db);
  const cutoff = Date.now() - minAgeHours * 60 * 60 * 1000;
  const files = new Map();
  for (const bucket of MEDIA_BUCKETS) {
    const bucketDir = path.join(process.cwd(), 'data', bucket);
    if (!fs.existsSync(bucketDir)) continue;
    for (const ownerId of fs.readdirSync(bucketDir)) {
      const ownerDir = path.join(bucketDir, ownerId);
      if (!fs.statSync(ownerDir).isDirectory()) continue;
      for (const filename of fs.readdirSync(ownerDir)) {
        const fullPath = path.join(ownerDir, filename);
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        const key = fileKey(ownerId, filename);
        if (refs[bucket].has(key)) continue;
        if (stat.mtime.getTime() > cutoff) continue;
        addFile(files, bucket, ownerId, filename, 'unreferenced file');
      }
    }
  }
  return files;
}

function summarizeRows(rows) {
  const summary = {};
  for (const [table, list] of Object.entries(rows)) {
    if (!list.length) continue;
    summary[table] = list.reduce((acc, row) => {
      const pid = row.project_id || '(none)';
      acc[pid] = (acc[pid] || 0) + 1;
      return acc;
    }, {});
  }
  return summary;
}

function deleteOrphanRows(db, rows) {
  const batchIds = (rows.batches || []).map((row) => row.id);
  const txn = db.transaction(() => {
    for (const id of batchIds) db.prepare('DELETE FROM batch_tasks WHERE batch_id = ?').run(id);
    for (const table of PROJECT_TABLES) {
      for (const row of rows[table] || []) db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(row.rowid);
    }
  });
  txn.immediate();
}

function rowsWithRowId(db, rows) {
  const out = {};
  for (const table of Object.keys(rows)) {
    if (!rows[table].length) { out[table] = []; continue; }
    out[table] = all(
      db,
      `SELECT rowid, * FROM ${table} WHERE project_id IS NOT NULL AND project_id <> ''`,
    ).filter((row) => rows[table].some((orphan) => orphan.id === row.id && orphan.project_id === row.project_id));
  }
  return out;
}

function deleteFiles(files) {
  const result = { deleted: [], missing: [], failed: [] };
  for (const info of files.values()) {
    const fullPath = safeFilePath(info.bucket, info.ownerId, info.filename);
    if (!fullPath) continue;
    try {
      if (!fs.existsSync(fullPath)) {
        result.missing.push(fullPath);
        continue;
      }
      fs.unlinkSync(fullPath);
      result.deleted.push(fullPath);
    } catch (e) {
      result.failed.push({ path: fullPath, error: e?.message || String(e) });
    }
  }
  return result;
}

function collectUserData(db, userArg) {
  const user = /^\d+$/.test(userArg)
    ? db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userArg))
    : db.prepare('SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)').get(userArg, userArg);
  if (!user) return null;
  const ownerId = user.id;
  const rows = {};
  for (const table of ['projects', 'images', 'video_tasks', 'uploads', 'exports', 'batches', 'continuity_cache', 'script_library_items', 'world_templates', 'sessions', 'user_settings', 'user_profiles', 'user_credits', 'credit_ledger', 'billing_orders']) {
    if (!tableExists(db, table)) continue;
    const column = table === 'projects' || table === 'images' || table === 'video_tasks' || table === 'uploads' || table === 'exports' || table === 'batches' || table === 'continuity_cache' || table === 'script_library_items' || table === 'world_templates'
      ? 'owner_id'
      : 'user_id';
    rows[table] = all(db, `SELECT * FROM ${table} WHERE ${column} = @ownerId`, { ownerId });
  }
  if (tableExists(db, 'otp_codes') && user.email) {
    rows.otp_codes = all(db, 'SELECT * FROM otp_codes WHERE lower(email) = lower(@email)', { email: user.email });
  }
  return { user, rows };
}

function collectFilesForUser(data) {
  const files = new Map();
  for (const row of data.rows.images || []) addFile(files, imageBucket(row), row.owner_id, row.filename, `user:${data.user.username}`);
  for (const row of data.rows.video_tasks || []) {
    addFile(files, 'videos', row.owner_id, row.filename, `user:${data.user.username}`);
    addFile(files, 'videos', row.owner_id, `${row.id}.cover.png`, `user:${data.user.username}`);
  }
  for (const row of data.rows.uploads || []) addFile(files, 'uploads', row.owner_id, row.filename, `user:${data.user.username}`);
  for (const row of data.rows.exports || []) {
    addFile(files, 'exports', row.owner_id, row.filename, `user:${data.user.username}`);
    addFile(files, 'exports', row.owner_id, `${row.id}.concat.mp4`, `user:${data.user.username}`);
    addFile(files, 'exports', row.owner_id, `${row.id}.subbed.mp4`, `user:${data.user.username}`);
    addFile(files, 'exports', row.owner_id, `${row.id}.sfx.mp4`, `user:${data.user.username}`);
    addFile(files, 'exports', row.owner_id, `${row.id}.srt`, `user:${data.user.username}`);
  }
  return files;
}

function deleteUserData(db, data) {
  const ownerId = data.user.id;
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM batch_tasks WHERE batch_id IN (SELECT id FROM batches WHERE owner_id = ?)').run(ownerId);
    for (const table of ['batches', 'continuity_cache', 'script_library_items', 'world_templates', 'images', 'video_tasks', 'uploads', 'exports', 'sessions', 'user_settings', 'user_profiles', 'user_credits', 'credit_ledger', 'billing_orders', 'projects']) {
      if (!tableExists(db, table)) continue;
      const column = table === 'sessions' || table === 'user_settings' || table === 'user_profiles' || table === 'user_credits' || table === 'credit_ledger' || table === 'billing_orders'
        ? 'user_id'
        : 'owner_id';
      db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(ownerId);
    }
    if (tableExists(db, 'otp_codes') && data.user.email) {
      db.prepare('DELETE FROM otp_codes WHERE lower(email) = lower(?)').run(data.user.email);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
  });
  txn.immediate();
}

function countMap(rows) {
  return Object.fromEntries(Object.entries(rows).map(([table, list]) => [table, list.length]).filter(([, count]) => count));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(process.cwd(), args.db);
  if (!fs.existsSync(dbPath)) throw new Error(`DB not found: ${dbPath}`);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  if (args.deleteUser) {
    const data = collectUserData(db, args.deleteUser);
    if (!data) {
      console.log(JSON.stringify({ mode: 'delete-user', db: dbPath, apply: args.apply, found: false, target: args.deleteUser }, null, 2));
      db.close();
      return;
    }
    const files = collectFilesForUser(data);
    const report = {
      mode: 'delete-user',
      db: dbPath,
      apply: args.apply,
      user: { id: data.user.id, username: data.user.username, email: data.user.email },
      rowCounts: countMap(data.rows),
      files: Array.from(files.values()).map((f) => safeFilePath(f.bucket, f.ownerId, f.filename)).filter(Boolean),
    };
    if (args.apply) {
      deleteUserData(db, data);
      report.fileDeleteResult = deleteFiles(files);
    }
    console.log(JSON.stringify(report, null, 2));
    db.close();
    return;
  }

  const orphanRows = rowsWithRowId(db, collectOrphanProjectRows(db));
  const orphanRowFiles = collectFilesForRows(orphanRows);
  const unreferencedFiles = collectUnreferencedFiles(db, args.minAgeHours);
  const files = new Map([...orphanRowFiles, ...unreferencedFiles]);
  const report = {
    mode: 'orphan-cleanup',
    db: dbPath,
    apply: args.apply,
    minAgeHours: args.minAgeHours,
    orphanRows: summarizeRows(orphanRows),
    fileCount: files.size,
    files: Array.from(files.values()).map((f) => ({
      path: safeFilePath(f.bucket, f.ownerId, f.filename),
      reason: f.reason,
    })),
  };
  if (args.apply) {
    deleteOrphanRows(db, orphanRows);
    report.fileDeleteResult = deleteFiles(files);
  }
  console.log(JSON.stringify(report, null, 2));
  db.close();
}

try {
  main();
} catch (e) {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
}
