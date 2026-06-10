/**
 * 配额绑会员档 + 部—集字段契约测试（docs/series-episode-continue-plan.md §6.5 / §6.1）
 *
 * 运行（务必用临时 DB，别碰 data/qd.sqlite）：
 *   DB_PATH=/tmp/qd-test-quota.sqlite npx tsx scripts/test-project-quota.ts
 */
import assert from 'node:assert/strict';
import { getPlan } from '../lib/billing-config';
import { getDb } from '../lib/db';
import {
  countProjectsForUser,
  createProjectForUser,
  deleteProjectForUser,
  listProjectsByUser,
} from '../lib/projects-db';
import { writeSystemConfig } from '../lib/system-config';

// —— 三档配额数值锁（2026-06-10 拍板：Free 100 / Plus 1000 / Pro 5000）——
assert.equal(getPlan('free')?.limits.projects, 100);
assert.equal(getPlan('plus')?.limits.projects, 1000);
assert.equal(getPlan('pro')?.limits.projects, 5000);

const db = getDb();
const ownerId = 990042;

function cleanup() {
  db.prepare('DELETE FROM projects WHERE owner_id = ?').run(ownerId);
  db.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
}

cleanup();
writeSystemConfig('project_create_payload_whitelist_enabled', true);
db.prepare(
  `INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)`,
).run(ownerId, 'series-quota-user', 'series-quota-user', 'x');

// —— countProjectsForUser：配额权威拦截的计数口径 ——
assert.equal(countProjectsForUser(ownerId), 0);
createProjectForUser(ownerId, { id: 'series-quota-ep1', name: '测试部 第1集' });
assert.equal(countProjectsForUser(ownerId), 1);

// —— 部—集三字段：创建即写入 + 项目读回 ——
const ep2 = createProjectForUser(ownerId, {
  id: 'series-quota-ep2',
  name: '测试部 第2集',
  seriesId: 'series-quota-ep1',
  episodeNumber: 2,
  prevProjectId: 'series-quota-ep1',
});
assert.equal(ep2.seriesId, 'series-quota-ep1');
assert.equal(ep2.episodeNumber, 2);
assert.equal(ep2.prevProjectId, 'series-quota-ep1');

// —— rowToSummary：列表摘要带三字段（前端分组/集数计算依赖）——
const summaries = listProjectsByUser(ownerId);
const ep2sum = summaries.find((s: any) => s.id === 'series-quota-ep2') as any;
assert.ok(ep2sum, 'ep2 应出现在列表');
assert.equal(ep2sum.seriesId, 'series-quota-ep1');
assert.equal(ep2sum.episodeNumber, 2);
assert.equal(ep2sum.prevProjectId, 'series-quota-ep1');
const ep1sum = summaries.find((s: any) => s.id === 'series-quota-ep1') as any;
assert.equal(ep1sum.seriesId, null);
assert.equal(ep1sum.episodeNumber, null);

// —— 脏值清洗：负数/空白丢弃为 null ——
const ep3 = createProjectForUser(ownerId, {
  id: 'series-quota-ep3',
  name: '脏值集',
  seriesId: '   ',
  episodeNumber: -5,
  prevProjectId: '',
});
assert.equal(ep3.seriesId, null);
assert.equal(ep3.episodeNumber, null);
assert.equal(ep3.prevProjectId, null);

assert.equal(countProjectsForUser(ownerId), 3);
assert.equal(deleteProjectForUser('series-quota-ep1', ownerId), true);
assert.equal(countProjectsForUser(ownerId), 2);

cleanup();
console.log('[test-project-quota] all assertions passed');
