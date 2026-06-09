import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-knowledge-snapshot-'));
process.env.ORIGIN_DATA_DIR = tempDir;
process.env.DB_PATH = join(tempDir, 'qd.sqlite');
process.env.JWT_SECRET = 'origin-knowledge-snapshot-jwt-secret-000000000000';

async function main() {
  const [{ createUser, signToken }, { createProjectForUser }, route] = await Promise.all([
    import('../lib/auth'),
    import('../lib/projects-db'),
    import('../app/api/projects/[id]/knowledge-snapshot/route'),
  ]);

  const user = await createUser({
    phone: '13900000001',
    password: 'test-password',
    displayName: 'Knowledge Snapshot Test',
  });

  const project = createProjectForUser(user.id, {
    id: 'knowledge-snapshot-world-count',
    name: 'Knowledge Snapshot World Count',
    selectedWorldTemplateId: 'world-candidate-only',
    worldTemplateSnapshot: {
      id: 'world-candidate-only',
      name: '候选角色世界观',
      characters: [],
      characterCandidates: [
        { id: 'c1', name: '林舟' },
        { id: 'c1', name: '林舟重复项' },
        { title: '许棠' },
      ],
      locations: [],
      props: [],
    },
  });

  const token = await signToken(user);
  const res = await route.GET(
    new NextRequest(`http://localhost:3000/api/projects/${project.id}/knowledge-snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: { id: project.id } },
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.world.template.characterCount, 2);

  console.log('[test-knowledge-snapshot-world-count] all assertions passed');
}

main()
  .catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(tempDir, { recursive: true, force: true }));
