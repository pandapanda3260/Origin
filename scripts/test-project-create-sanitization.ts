import assert from 'node:assert/strict';
import { getDb } from '../lib/db';
import { createProjectForUser, deleteProjectForUser, getProjectByIdForUser } from '../lib/projects-db';
import { isEmptyScriptConsultState } from '../lib/script-consult-state';
import { writeSystemConfig } from '../lib/system-config';

const db = getDb();
const ownerId = 990041;
const projectId = 'project-create-sanitize-smoke';

function cleanup() {
  db.prepare('DELETE FROM projects WHERE owner_id = ? AND id = ?').run(ownerId, projectId);
  db.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
}

cleanup();
writeSystemConfig('project_create_payload_whitelist_enabled', true);

db.prepare(
  `INSERT INTO users (id, username, display_name, password_hash)
   VALUES (?, ?, ?, ?)`,
).run(ownerId, 'project-create-sanitize-user', 'project-create-sanitize-user', 'x');

const project = createProjectForUser(ownerId, {
  id: projectId,
  name: 'Sanitized Project',
  description: 'kept description',
  script: 'must be dropped',
  scriptDraft: 'must be dropped',
  assets: { characters: [{ name: 'must drop' }] },
  shots: [{ visual: 'must drop' }],
  storyboards: [{ prompt: 'must drop' }],
  videoTasks: [{ status: 'done' }],
  scriptConsult: {
    messages: [{ role: 'user', content: 'must drop consult' }],
    outline: 'must drop outline',
    ready: true,
    startedAt: '2026-01-01T00:00:00Z',
  },
  styleOptions: { aspectRatio: '1:1' },
  selectedStyleTemplateId: 'tpl-safe',
  scriptTargetDurationSec: 90,
  clientRequestId: 'client-request-safe',
  episodes: [{ id: 'ep_safe', title: '第 1 集' }],
});

assert.equal(project.id, projectId);
assert.equal(project.name, 'Sanitized Project');
assert.equal(project.description, 'kept description');
assert.equal(project.script, '');
assert.equal(project.scriptDraft, '');
assert.equal(project.assets, null);
assert.deepEqual(project.shots, []);
assert.deepEqual(project.storyboards, []);
assert.deepEqual(project.videoTasks, []);
assert.equal(project.styleOptions.aspectRatio, '1:1');
assert.equal(project.selectedStyleTemplateId, 'tpl-safe');
assert.equal(project.scriptTargetDurationSec, 90);
assert.equal(project.clientRequestId, 'client-request-safe');
assert.equal(project.episodes.length, 1);
assert.equal(project.episodes[0].id, 'ep_safe');
assert.equal(isEmptyScriptConsultState(project.scriptConsult), true);

const raw = db.prepare<{ id: string }, any>('SELECT data_json FROM projects WHERE id = @id').get({ id: projectId });
const data = JSON.parse(raw.data_json || '{}');
assert.equal(data.script, '');
assert.equal(data.scriptDraft, '');
assert.equal(data.assets, null);
assert.equal(data.scriptConsult.messages.length, 0);
assert.equal(data.scriptConsult.outline, '');
assert.equal(data.scriptConsult.ready, false);
assert.equal(data.clientRequestId, 'client-request-safe');

const reloaded = getProjectByIdForUser(projectId, ownerId)!;
assert.equal(isEmptyScriptConsultState(reloaded.scriptConsult), true);

assert.equal(deleteProjectForUser(projectId, ownerId), true);
cleanup();

console.log('[test-project-create-sanitization] ok');
