import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db';
import type { ToolboxInputRef } from './toolbox-modes';

export type CustomCharacterStatus = 'running' | 'completed' | 'failed';
export type CustomCharacterSourceType = 'prompt' | 'image' | 'image_prompt';
export type CustomCharacterLifecycleStatus = 'draft' | 'confirmed';

export type CustomCharacterRow = {
  id: string;
  owner_id: number;
  project_id: string | null;
  current_version_id: string | null;
  title: string;
  lifecycle_status: CustomCharacterLifecycleStatus;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CustomCharacterVersionRow = {
  id: string;
  character_id: string;
  owner_id: number;
  project_id: string | null;
  version_no: number;
  status: CustomCharacterStatus;
  source_type: CustomCharacterSourceType;
  prompt: string;
  params_json: string;
  input_refs_json: string;
  fields_json: string;
  result_image_id: string | null;
  source_hash: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertCustomCharacterVersionInput = {
  ownerId: number;
  projectId?: string | null;
  characterId?: string | null;
  title?: string | null;
  status?: CustomCharacterStatus;
  sourceType: CustomCharacterSourceType;
  prompt?: string;
  params?: Record<string, any>;
  inputRefs?: ToolboxInputRef[];
  fields?: Record<string, any>;
  resultImageId?: string | null;
  errorMessage?: string | null;
  makeCurrent?: boolean;
  lifecycleStatus?: CustomCharacterLifecycleStatus;
};

function safeJson(value: string | null | undefined, fallback: any) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanTitle(value: string | null | undefined) {
  const title = String(value || '').trim();
  return title ? title.slice(0, 80) : '未命名角色';
}

function currentImageUrl(fields: any) {
  return String(fields?.imageUrl || fields?.rawUrl || fields?.realPhotoUrl || '').trim();
}

function isDisplayableConfirmedCharacter(item: any) {
  if (!item || item.lifecycleStatus !== 'confirmed') return true;
  if (item.currentVersion?.status !== 'completed') return false;
  if (!currentImageUrl(item.current)) return false;
  const referenceStatus = String(item.current?.reference?.status || '');
  return referenceStatus === 'ready' || referenceStatus === 'degraded';
}

export function computeCustomCharacterSourceHash(input: {
  prompt?: string;
  params?: Record<string, any>;
  inputRefs?: ToolboxInputRef[];
}) {
  return createHash('sha256')
    .update(JSON.stringify({
      prompt: input.prompt || '',
      params: input.params || {},
      inputRefs: input.inputRefs || [],
    }))
    .digest('hex');
}

export function getCustomCharacterForUser(id: string, ownerId: number) {
  return getDb()
    .prepare<{ id: string; ownerId: number }, CustomCharacterRow>(
      `SELECT * FROM custom_characters
        WHERE id = @id AND owner_id = @ownerId
        LIMIT 1`,
    )
    .get({ id, ownerId }) || null;
}

export function getCustomCharacterVersionForUser(id: string, ownerId: number) {
  return getDb()
    .prepare<{ id: string; ownerId: number }, CustomCharacterVersionRow>(
      `SELECT * FROM custom_character_versions
        WHERE id = @id AND owner_id = @ownerId
        LIMIT 1`,
    )
    .get({ id, ownerId }) || null;
}

export function listCustomCharacters(opts: {
  ownerId: number;
  projectId?: string | null;
  limit?: number;
  lifecycleStatus?: CustomCharacterLifecycleStatus;
}) {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(opts.limit || 60))));
  const params: any = { ownerId: opts.ownerId, limit, lifecycleStatus: opts.lifecycleStatus || 'confirmed' };
  // 定制角色是「用户级全局资产库」：列表、草稿箱、项目调用环节都不按项目过滤，
  // 否则在别的项目里就看不到自己在其它项目建的角色（历史角色会"消失"）。
  // project_id 仅作为创建来源记录保留，不参与列表过滤。
  const where = ['c.owner_id = @ownerId', 'c.lifecycle_status = @lifecycleStatus'];
  const rows = getDb()
    .prepare<any, CustomCharacterRow & { version_json: string | null }>(
      `SELECT c.*,
              v.id AS version_id,
              v.version_no AS version_no,
              v.status AS version_status,
              v.source_type AS version_source_type,
              v.prompt AS version_prompt,
              v.params_json AS version_params_json,
              v.input_refs_json AS version_input_refs_json,
              v.fields_json AS version_json,
              v.result_image_id AS version_result_image_id,
              v.source_hash AS version_source_hash,
              v.error_message AS version_error_message,
              v.created_at AS version_created_at,
              v.updated_at AS version_updated_at
         FROM custom_characters c
         LEFT JOIN custom_character_versions v
           ON v.id = c.current_version_id AND v.owner_id = c.owner_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.updated_at DESC
        LIMIT @limit`,
    )
    .all(params);
  const items = rows.map((row: any) => serializeCustomCharacter(row, row.version_json, row.version_id ? {
    id: row.version_id,
    character_id: row.id,
    owner_id: row.owner_id,
    project_id: row.project_id,
    version_no: row.version_no,
    status: row.version_status,
    source_type: row.version_source_type,
    prompt: row.version_prompt,
    params_json: row.version_params_json,
    input_refs_json: row.version_input_refs_json,
    fields_json: row.version_json,
    result_image_id: row.version_result_image_id,
    source_hash: row.version_source_hash,
    error_message: row.version_error_message,
    created_at: row.version_created_at,
    updated_at: row.version_updated_at,
  } : null));
  return (params.lifecycleStatus === 'confirmed')
    ? items.filter(isDisplayableConfirmedCharacter)
    : items;
}

export function listCustomCharacterVersions(characterId: string, ownerId: number) {
  const rows = getDb()
    .prepare<{ characterId: string; ownerId: number }, CustomCharacterVersionRow>(
      `SELECT * FROM custom_character_versions
        WHERE character_id = @characterId AND owner_id = @ownerId
        ORDER BY version_no DESC`,
    )
    .all({ characterId, ownerId });
  return rows.map(serializeCustomCharacterVersion);
}

export function getCurrentCustomCharacterVersion(character: CustomCharacterRow | null | undefined) {
  if (!character?.current_version_id) return null;
  return getCustomCharacterVersionForUser(character.current_version_id, character.owner_id);
}

export function createCustomCharacterVersion(input: UpsertCustomCharacterVersionInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const characterId = input.characterId || randomUUID();
  const existing = getCustomCharacterForUser(characterId, input.ownerId);
  const title = cleanTitle(input.title);
  const lifecycleStatus: CustomCharacterLifecycleStatus = input.lifecycleStatus || existing?.lifecycle_status || 'confirmed';
  const versionNo = existing ? getNextCustomCharacterVersionNo(characterId, input.ownerId) : 1;
  const versionId = randomUUID();
  const prompt = String(input.prompt || '').slice(0, 8000);
  const params = input.params || {};
  const inputRefs = input.inputRefs || [];
  const fields = input.fields || {};
  const sourceHash = computeCustomCharacterSourceHash({ prompt, params, inputRefs });
  const shouldMakeCurrent = input.makeCurrent !== false || !existing?.current_version_id;

  const tx = db.transaction(() => {
    if (!existing) {
      db.prepare(
        `INSERT INTO custom_characters
          (id, owner_id, project_id, current_version_id, title, lifecycle_status, confirmed_at, created_at, updated_at)
         VALUES
          (@id, @ownerId, @projectId, @versionId, @title, @lifecycleStatus, @confirmedAt, @now, @now)`,
      ).run({
        id: characterId,
        ownerId: input.ownerId,
        projectId: input.projectId || null,
        versionId,
        title,
        lifecycleStatus,
        confirmedAt: lifecycleStatus === 'confirmed' ? now : null,
        now,
      });
    }

    db.prepare(
      `INSERT INTO custom_character_versions
        (id, character_id, owner_id, project_id, version_no, status, source_type,
         prompt, params_json, input_refs_json, fields_json, result_image_id,
         source_hash, error_message, created_at, updated_at)
       VALUES
        (@id, @characterId, @ownerId, @projectId, @versionNo, @status, @sourceType,
         @prompt, @paramsJson, @inputRefsJson, @fieldsJson, @resultImageId,
         @sourceHash, @errorMessage, @now, @now)`,
    ).run({
      id: versionId,
      characterId,
      ownerId: input.ownerId,
      projectId: input.projectId || existing?.project_id || null,
      versionNo,
      status: input.status || 'completed',
      sourceType: input.sourceType,
      prompt,
      paramsJson: JSON.stringify(params),
      inputRefsJson: JSON.stringify(inputRefs),
      fieldsJson: JSON.stringify(fields),
      resultImageId: input.resultImageId || null,
      sourceHash,
      errorMessage: input.errorMessage || null,
      now,
    });

    if (shouldMakeCurrent) {
      db.prepare(
        `UPDATE custom_characters
            SET current_version_id = @versionId,
                title = @title,
                updated_at = @now
          WHERE id = @characterId AND owner_id = @ownerId`,
      ).run({
        versionId,
        title: cleanTitle(input.title || fields.name || existing?.title),
        now,
        characterId,
        ownerId: input.ownerId,
      });
    } else {
      db.prepare(
        `UPDATE custom_characters
            SET updated_at = @now
          WHERE id = @characterId AND owner_id = @ownerId`,
      ).run({ now, characterId, ownerId: input.ownerId });
    }
  });
  tx();

  return getCustomCharacterVersionForUser(versionId, input.ownerId)!;
}

/**
 * 把一条已存在的版本（通常是生成开始时落的 running 占位）原地更新为最终状态。
 * 用于"点了生成就先存草稿、跑完再回填"的两段式流程，避免重复建版本。
 */
export function finalizeCustomCharacterVersion(input: {
  versionId: string;
  ownerId: number;
  status: CustomCharacterStatus;
  fields: Record<string, any>;
  resultImageId?: string | null;
  errorMessage?: string | null;
  title?: string | null;
}) {
  const db = getDb();
  const version = getCustomCharacterVersionForUser(input.versionId, input.ownerId);
  if (!version) throw new Error('角色草稿版本不存在');
  const now = new Date().toISOString();
  const fields = input.fields || {};
  const title = cleanTitle(input.title || (fields as any)?.name || '');
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE custom_character_versions
          SET status = @status,
              fields_json = @fieldsJson,
              result_image_id = @resultImageId,
              error_message = @errorMessage,
              updated_at = @now
        WHERE id = @versionId AND owner_id = @ownerId`,
    ).run({
      status: input.status,
      fieldsJson: JSON.stringify(fields),
      resultImageId: input.resultImageId || null,
      errorMessage: input.errorMessage || null,
      now,
      versionId: input.versionId,
      ownerId: input.ownerId,
    });
    db.prepare(
      `UPDATE custom_characters
          SET title = CASE WHEN current_version_id = @versionId THEN @title ELSE title END,
              updated_at = @now
        WHERE id = @characterId AND owner_id = @ownerId`,
    ).run({ title, now, versionId: input.versionId, characterId: version.character_id, ownerId: input.ownerId });
  });
  tx();
  return getCustomCharacterVersionForUser(input.versionId, input.ownerId)!;
}

function assertConfirmableVersion(version: CustomCharacterVersionRow) {
  if (version.status !== 'completed') throw new Error('只有生成完成的角色版本才能确认添加');
  const fields = safeJson(version.fields_json, {});
  const referenceStatus = String(fields?.reference?.status || '');
  if (!currentImageUrl(fields)) throw new Error('这个版本没有可用角色图，不能确认添加');
  if (referenceStatus !== 'ready' && referenceStatus !== 'degraded') {
    throw new Error('这个版本的角色设定图不可用，请重新生成后再确认添加');
  }
  return fields;
}

export function confirmCustomCharacterDraft(ownerId: number, characterId: string, versionId: string, nameOverride?: string) {
  const db = getDb();
  const character = getCustomCharacterForUser(characterId, ownerId);
  if (!character) throw new Error('角色草稿不存在，请刷新页面后再试');
  if (character.lifecycle_status !== 'draft') throw new Error('这个角色已经添加过了');
  const version = getCustomCharacterVersionForUser(versionId, ownerId);
  if (!version || version.character_id !== character.id) throw new Error('没有找到要确认的角色版本');
  const fields = assertConfirmableVersion(version);
  const overrideName = String(nameOverride || '').trim().slice(0, 80);
  if (overrideName) fields.name = overrideName;
  const title = cleanTitle(overrideName || fields?.name || character.title);
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM custom_character_versions
        WHERE character_id = @characterId AND owner_id = @ownerId AND id <> @versionId`,
    ).run({ characterId, ownerId, versionId });

    db.prepare(
      `UPDATE custom_character_versions
          SET version_no = 1,
              prompt = '',
              params_json = '{}',
              input_refs_json = '[]',
              source_hash = NULL,
              updated_at = @now
        WHERE id = @versionId AND character_id = @characterId AND owner_id = @ownerId`,
    ).run({ versionId, characterId, ownerId, now });

    if (overrideName) {
      db.prepare(
        `UPDATE custom_character_versions
            SET fields_json = @fieldsJson,
                updated_at = @now
          WHERE id = @versionId AND character_id = @characterId AND owner_id = @ownerId`,
      ).run({ fieldsJson: JSON.stringify(fields), now, versionId, characterId, ownerId });
    }

    db.prepare(
      `UPDATE custom_characters
          SET current_version_id = @versionId,
              title = @title,
              lifecycle_status = 'confirmed',
              confirmed_at = @now,
              updated_at = @now
        WHERE id = @characterId AND owner_id = @ownerId AND lifecycle_status = 'draft'`,
    ).run({ versionId, title, now, characterId, ownerId });
  });
  tx();
  return getCustomCharacterForUser(characterId, ownerId)!;
}

export function deleteCustomCharacterDraft(ownerId: number, characterId: string) {
  const result = getDb()
    .prepare<{ ownerId: number; characterId: string }>(
      `DELETE FROM custom_characters
        WHERE id = @characterId AND owner_id = @ownerId AND lifecycle_status = 'draft'`,
    )
    .run({ ownerId, characterId });
  return result.changes > 0;
}

export function deleteCustomCharacterForUser(ownerId: number, characterId: string) {
  const result = getDb()
    .prepare<{ ownerId: number; characterId: string }>(
      `DELETE FROM custom_characters
        WHERE id = @characterId AND owner_id = @ownerId`,
    )
    .run({ ownerId, characterId });
  return result.changes > 0;
}

export function cleanupStaleCustomCharacterDrafts(ownerId: number, olderThanHours = 48) {
  const cutoff = new Date(Date.now() - Math.max(1, olderThanHours) * 60 * 60 * 1000).toISOString();
  const result = getDb()
    .prepare<{ ownerId: number; cutoff: string }>(
      `DELETE FROM custom_characters
        WHERE owner_id = @ownerId
          AND lifecycle_status = 'draft'
          AND updated_at < @cutoff`,
    )
    .run({ ownerId, cutoff });
  return result.changes;
}

export function updateCustomCharacterVersionFields(
  versionId: string,
  ownerId: number,
  fields: Record<string, any>,
  title?: string | null,
) {
  const version = getCustomCharacterVersionForUser(versionId, ownerId);
  if (!version) throw new Error('角色版本不存在');
  const now = new Date().toISOString();
  const nextTitle = cleanTitle(title || fields?.name || '');
  const tx = getDb().transaction(() => {
    getDb().prepare(
      `UPDATE custom_character_versions
          SET fields_json = @fieldsJson,
              updated_at = @now
        WHERE id = @versionId AND owner_id = @ownerId`,
    ).run({ fieldsJson: JSON.stringify(fields || {}), now, versionId, ownerId });

    getDb().prepare(
      `UPDATE custom_characters
          SET title = CASE WHEN current_version_id = @versionId THEN @title ELSE title END,
              updated_at = @now
        WHERE id = @characterId AND owner_id = @ownerId`,
    ).run({ title: nextTitle, now, versionId, characterId: version.character_id, ownerId });
  });
  tx();
  return getCustomCharacterVersionForUser(versionId, ownerId)!;
}

export function getNextCustomCharacterVersionNo(characterId: string, ownerId: number) {
  const row = getDb()
    .prepare<{ characterId: string; ownerId: number }, { n: number }>(
      `SELECT COALESCE(MAX(version_no), 0) + 1 AS n
        FROM custom_character_versions
        WHERE character_id = @characterId AND owner_id = @ownerId`,
    )
    .get({ characterId, ownerId });
  return Number(row?.n || 1);
}

export function serializeCustomCharacter(row: CustomCharacterRow, currentFieldsJson?: string | null, currentVersion?: CustomCharacterVersionRow | null) {
  return {
    id: row.id,
    projectId: row.project_id,
    currentVersionId: row.current_version_id,
    title: row.title,
    lifecycleStatus: row.lifecycle_status || 'confirmed',
    confirmedAt: row.confirmed_at || null,
    current: safeJson(currentFieldsJson, null),
    currentVersion: currentVersion ? serializeCustomCharacterVersion(currentVersion) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeCustomCharacterVersion(row: CustomCharacterVersionRow) {
  return {
    id: row.id,
    characterId: row.character_id,
    projectId: row.project_id,
    versionNo: row.version_no,
    status: row.status,
    sourceType: row.source_type,
    prompt: row.prompt,
    params: safeJson(row.params_json, {}),
    inputRefs: safeJson(row.input_refs_json, []),
    fields: safeJson(row.fields_json, {}),
    resultImageId: row.result_image_id,
    sourceHash: row.source_hash,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
