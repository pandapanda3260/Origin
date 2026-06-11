import { randomBytes } from 'node:crypto';
import { loadExternalEnv } from '../lib/env';
import { getDb, type UserRow } from '../lib/db';
import { normalizePhone } from '../lib/otp';
import { createProjectForUser } from '../lib/projects-db';

function requiredEnv(name: string) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  loadExternalEnv();
  const phone = normalizePhone(requiredEnv('ORIGIN_WORKSPACE_SMOKE_PHONE'));
  if (!phone) throw new Error('ORIGIN_WORKSPACE_SMOKE_PHONE must be a valid mainland China mobile number');
  const password = requiredEnv('ORIGIN_WORKSPACE_SMOKE_PASSWORD');
  if (password.length < 12) throw new Error('ORIGIN_WORKSPACE_SMOKE_PASSWORD must be at least 12 characters');

  const { createUser, hashPassword } = await import('../lib/auth');
  const db = getDb();
  let user = db.prepare<{ phone: string }, UserRow>('SELECT * FROM users WHERE phone = @phone LIMIT 1').get({ phone });

  if (!user) {
    user = await createUser({
      phone,
      password,
      displayName: 'Origin Smoke Check',
    });
    console.log(`[smoke-user] created user id=${user.id} phone=${phone}`);
  } else {
    const passwordHash = await hashPassword(password);
    db.prepare(
      `UPDATE users
          SET display_name = ?,
              password_hash = ?,
              disabled_at = NULL,
              token_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run('Origin Smoke Check', passwordHash, user.id);
    user = db.prepare<{ id: number }, UserRow>('SELECT * FROM users WHERE id = @id').get({ id: user.id })!;
    console.log(`[smoke-user] updated user id=${user.id} phone=${phone}`);
  }

  const existingProject = db
    .prepare<{ ownerId: number }, { id: string }>(
      `SELECT id FROM projects
        WHERE owner_id = @ownerId AND id LIKE 'smoke_workspace_health_%'
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get({ ownerId: user.id });
  if (existingProject) {
    console.log(`[smoke-user] project exists id=${existingProject.id}`);
  } else {
    const id = `smoke_workspace_health_${randomBytes(4).toString('hex')}`;
    createProjectForUser(user.id, {
      id,
      name: 'Smoke Workspace Health',
      oneSentence: 'Synthetic project for production workspace health checks.',
    });
    console.log(`[smoke-user] created project id=${id}`);
  }
}

main().catch((error) => {
  console.error(`[smoke-user] failed: ${error?.message || String(error)}`);
  process.exit(1);
});
