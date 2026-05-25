#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

function argValue(name) {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const projectId = argValue('--projectId');
const dataDir = process.env.ORIGIN_DATA_DIR || process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dbPath = process.env.DB_PATH || path.join(dataDir, 'qd.sqlite');

function normalizeEntityType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'non-human' || text === 'nonhuman' || text.includes('非人')) return 'non-human';
  if (text === 'human' || text.includes('人物') || text.includes('人类')) return 'human';
  return text;
}

function panelSchemaEntityType(value) {
  const schema = String(value?.schema || '').trim().toLowerCase();
  if (!schema) return '';
  if (schema.includes('non-human') || schema.includes('nonhuman')) return 'non-human';
  if (schema.includes('human-character')) return 'human';
  return '';
}

function idFromUrl(url) {
  const m = String(url || '').match(/\/api\/images\/file\/([^?&#/\s]+)/);
  return m ? m[1] : '';
}

function firstUrl(item) {
  const reference = item?.reference || {};
  const panels = item?.panels || {};
  return [
    item?.imageUrl,
    item?.rawUrl,
    item?.realPhotoUrl,
    item?.pencilUrl,
    item?.originalUrl,
    reference.currentUrl,
    reference.lastKnownGoodUrl,
    panels.sheetUrl,
  ].map((value) => String(value || '').trim()).find(Boolean) || '';
}

function imageLooksHuman(prompt) {
  const text = String(prompt || '').toLowerCase();
  return /\b(man|woman|person|human|groom|bride|suit|shirt|bow tie)\b/.test(text)
    || /新郎|新娘|西装|衬衫|领结|人物|男人|女人/.test(text);
}

function imagePrompt(db, imageId) {
  if (!imageId) return '';
  const row = db.prepare('SELECT prompt FROM images WHERE id=?').get(imageId);
  return String(row?.prompt || '');
}

function cleanGeneratedFields(item, staleIds) {
  if (!item || typeof item !== 'object') return false;
  const ids = staleIds.filter(Boolean);
  if (!ids.length) return false;
  let changed = false;
  function hasStale(value) {
    const text = String(value || '');
    return ids.some((id) => text.includes(id));
  }
  [
    'imageUrl',
    'rawUrl',
    'realPhotoUrl',
    'pencilUrl',
    'originalUrl',
    'displayUrl',
    'thumbUrl',
    'pencilOriginalUrl',
    'pencilDisplayUrl',
    'pencilThumbUrl',
  ].forEach((key) => {
    if (hasStale(item[key])) {
      delete item[key];
      changed = true;
    }
  });
  if (item.panels && hasStale(JSON.stringify(item.panels))) {
    delete item.panels;
    changed = true;
  }
  if (item.reference) {
    ['currentUrl', 'lastKnownGoodUrl'].forEach((key) => {
      if (hasStale(item.reference[key])) {
        delete item.reference[key];
        changed = true;
      }
    });
    if ((item.reference.status === 'ready' || item.reference.status === 'degraded') && !item.reference.currentUrl && !item.reference.lastKnownGoodUrl) {
      item.reference.status = item.reference.lastAttemptUrl ? 'failed' : 'missing';
      changed = true;
    }
  }
  return changed;
}

function diagnoseProject(db, row) {
  let project;
  try {
    project = JSON.parse(row.data_json || '{}');
  } catch {
    return { project: null, issues: [], changed: false };
  }
  const assetCharacters = Array.isArray(project.assets?.characters) ? project.assets.characters : [];
  const topCharacters = Array.isArray(project.characters) ? project.characters : [];
  const locks = Array.isArray(project.consistency?.characters) ? project.consistency.characters : [];
  const issues = [];
  let changed = false;
  const max = Math.max(assetCharacters.length, topCharacters.length, locks.length);

  for (let idx = 0; idx < max; idx += 1) {
    const asset = assetCharacters[idx] || {};
    const top = topCharacters[idx] || {};
    const lock = locks[idx] || {};
    const entityType = normalizeEntityType(asset.entityType || lock.identityLock?.entityType);
    const topSchemaEntity = panelSchemaEntityType(top.panels);
    const assetSchemaEntity = panelSchemaEntityType(asset.panels);
    const topImageId = idFromUrl(firstUrl(top));
    const assetImageId = idFromUrl(firstUrl(asset));
    const lockImageId = idFromUrl(lock.referenceLock?.sheetUrl) || lock.referenceLock?.sourceImageId || '';
    const topPrompt = imagePrompt(db, topImageId);
    const assetPrompt = imagePrompt(db, assetImageId);
    const lockPrompt = imagePrompt(db, lockImageId);
    const staleIds = new Set();

    function addIssue(code, detail) {
      issues.push({
        projectId: row.id,
        title: row.title,
        idx,
        name: asset.name || top.name || lock.canonicalName || `characters[${idx}]`,
        entityType,
        code,
        detail,
      });
    }

    if (entityType === 'non-human' && topSchemaEntity === 'human') {
      addIssue('top_schema_entity_mismatch', { schema: top.panels?.schema, imageId: topImageId });
      staleIds.add(topImageId);
    }
    if (entityType === 'non-human' && assetSchemaEntity === 'human') {
      addIssue('asset_schema_entity_mismatch', { schema: asset.panels?.schema, imageId: assetImageId });
      staleIds.add(assetImageId);
    }
    if (entityType === 'non-human' && topImageId && imageLooksHuman(topPrompt)) {
      addIssue('top_image_prompt_mismatch', { imageId: topImageId, promptPreview: topPrompt.slice(0, 180) });
      staleIds.add(topImageId);
    }
    if (entityType === 'non-human' && lockImageId && imageLooksHuman(lockPrompt)) {
      addIssue('lock_image_prompt_mismatch', { imageId: lockImageId, promptPreview: lockPrompt.slice(0, 180) });
      staleIds.add(lockImageId);
    }
    if (top.imageSafetyAudit?.generatedImageId && topImageId && top.imageSafetyAudit.generatedImageId !== topImageId) {
      addIssue('top_audit_image_mismatch', { displayedImageId: topImageId, auditGeneratedImageId: top.imageSafetyAudit.generatedImageId });
      staleIds.add(topImageId);
    }

    if (apply && staleIds.size) {
      const staleList = Array.from(staleIds);
      changed = cleanGeneratedFields(asset, staleList) || changed;
      changed = cleanGeneratedFields(top, staleList) || changed;
      if (lock.referenceLock && staleList.some((id) => JSON.stringify(lock.referenceLock).includes(id))) {
        lock.referenceLock = { referenceStatus: 'failed' };
        changed = true;
      }
    }
  }
  return { project, issues, changed };
}

const db = new Database(dbPath);
const rows = db.prepare(
  `SELECT id, title, updated_at, data_json
     FROM projects
    WHERE (@projectId = '' OR id = @projectId)
    ORDER BY updated_at DESC`,
).all({ projectId });

const reports = [];
const updates = [];
for (const row of rows) {
  const result = diagnoseProject(db, row);
  reports.push(...result.issues);
  if (apply && result.changed && result.project) {
    updates.push({ id: row.id, title: row.title, data: JSON.stringify(result.project) });
  }
}

let backupPath = '';
if (apply && updates.length) {
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  backupPath = path.join(backupDir, `character-reference-contamination-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), reports, updates: updates.map((item) => ({ id: item.id, title: item.title })) }, null, 2));
  const stmt = db.prepare("UPDATE projects SET data_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?");
  const tx = db.transaction(() => {
    updates.forEach((item) => stmt.run(item.data, item.id));
  });
  tx();
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  scannedProjects: rows.length,
  issueCount: reports.length,
  updatedProjects: updates.length,
  backupPath: backupPath || undefined,
  reports,
}, null, 2));

db.close();
