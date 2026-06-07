import assert from 'node:assert/strict';
import { getDb } from '../lib/db';
import {
  createProjectForUser,
  deleteProjectForUser,
  getProjectByIdForUser,
  patchProjectForUser,
  updateProjectForUser,
} from '../lib/projects-db';

const db = getDb();
const ownerId = 990052;
const projectId = 'project-title-update-guard-smoke';

function cleanup() {
  db.prepare('DELETE FROM projects WHERE owner_id = ? AND id = ?').run(ownerId, projectId);
  db.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
}

cleanup();

db.prepare(
  `INSERT INTO users (id, username, display_name, password_hash)
   VALUES (?, ?, ?, ?)`,
).run(ownerId, 'project-title-update-guard-user', 'project-title-update-guard-user', 'x');

const created = createProjectForUser(ownerId, {
  id: projectId,
  name: 'Original Title',
  script: 'initial script',
});

assert.equal(created.name, 'Original Title');

const staleFullSave = updateProjectForUser(
  projectId,
  ownerId,
  {
    name: 'Stale Full Save Title',
    title: 'Stale Full Save Title',
    script: 'updated by ordinary save',
  },
  { expectedVersion: created.version },
)!;

assert.equal(staleFullSave.name, 'Original Title');
assert.equal(staleFullSave.title, 'Original Title');
assert.equal(staleFullSave.script, 'updated by ordinary save');

const afterImplicitPatch = patchProjectForUser(projectId, ownerId, () => ({
  title: 'Stale Patch Title',
  oneSentence: 'ordinary patch body',
}))!;

assert.equal(afterImplicitPatch.name, 'Original Title');
assert.equal(afterImplicitPatch.title, 'Original Title');
assert.equal(afterImplicitPatch.oneSentence, 'ordinary patch body');

const renamed = updateProjectForUser(
  projectId,
  ownerId,
  {
    name: 'Explicit Rename Title',
    title: 'Explicit Rename Title',
  },
  { expectedVersion: afterImplicitPatch.version, allowTitleUpdate: true },
)!;

assert.equal(renamed.name, 'Explicit Rename Title');
assert.equal(renamed.title, 'Explicit Rename Title');

const raw = db.prepare<{ id: string }, any>('SELECT title, data_json FROM projects WHERE id = @id').get({ id: projectId });
const data = JSON.parse(raw.data_json || '{}');
assert.equal(raw.title, 'Explicit Rename Title');
assert.equal(Object.prototype.hasOwnProperty.call(data, 'name'), false);
assert.equal(Object.prototype.hasOwnProperty.call(data, 'title'), false);

const reloaded = getProjectByIdForUser(projectId, ownerId)!;
assert.equal(reloaded.name, 'Explicit Rename Title');

assert.equal(deleteProjectForUser(projectId, ownerId), true);
cleanup();

console.log('[test-project-title-update-guard] ok');
