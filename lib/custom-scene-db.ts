import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db';
import { resolveSceneImageUrl } from './scene-views';
import type { ToolboxInputRef } from './toolbox-modes';

export type CustomSceneGenerationStatus = 'running' | 'completed' | 'failed';
export type CustomSceneSourceType = 'prompt' | 'image' | 'image_prompt';
export type CustomSceneLifecycleStatus = 'draft' | 'confirmed';

export type CustomSceneRow = {
  id: string;
  owner_id: number;
  project_id: string | null;
  current_version_id: string | null;
  title: string;
  lifecycle_status: CustomSceneLifecycleStatus;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CustomSceneVersionRow = {
  id: string;
  scene_id: string;
  owner_id: number;
  project_id: string | null;
  version_no: number;
  generation_status: CustomSceneGenerationStatus;
  source_type: CustomSceneSourceType;
  prompt: string;
  params_json: string;
  input_refs_json: string;
  scene_data_json: string;
  result_image_id: string | null;
  source_hash: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertCustomSceneVersionInput = {
  ownerId: number;
  projectId?: string | null;
  sceneId?: string | null;
  title?: string | null;
  generationStatus?: CustomSceneGenerationStatus;
  sourceType: CustomSceneSourceType;
  prompt?: string;
  params?: Record<string, any>;
  inputRefs?: ToolboxInputRef[];
  sceneData?: Record<string, any>;
  resultImageId?: string | null;
  errorMessage?: string | null;
  makeCurrent?: boolean;
  lifecycleStatus?: CustomSceneLifecycleStatus;
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
  return title ? title.slice(0, 80) : '未命名场景';
}

function sceneTitle(sceneData: any, fallback?: string | null) {
  return cleanTitle(sceneData?.name || sceneData?.title || sceneData?.location || fallback);
}

function isDisplayableConfirmedScene(item: any) {
  if (!item || item.lifecycleStatus !== 'confirmed') return true;
  if (item.currentVersion?.generationStatus !== 'completed' && item.currentVersion?.status !== 'completed') return false;
  return !!resolveSceneImageUrl(item.current, { viewRole: 'establishing', gate: true });
}

export function computeCustomSceneSourceHash(input: {
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

export function getCustomSceneForUser(id: string, ownerId: number) {
  return getDb()
    .prepare<{ id: string; ownerId: number }, CustomSceneRow>(
      `SELECT * FROM custom_scenes
        WHERE id = @id AND owner_id = @ownerId
        LIMIT 1`,
    )
    .get({ id, ownerId }) || null;
}

export function getCustomSceneVersionForUser(id: string, ownerId: number) {
  return getDb()
    .prepare<{ id: string; ownerId: number }, CustomSceneVersionRow>(
      `SELECT * FROM custom_scene_versions
        WHERE id = @id AND owner_id = @ownerId
        LIMIT 1`,
    )
    .get({ id, ownerId }) || null;
}

export function listCustomScenes(opts: {
  ownerId: number;
  projectId?: string | null;
  limit?: number;
  lifecycleStatus?: CustomSceneLifecycleStatus;
}) {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(opts.limit || 60))));
  const params: any = { ownerId: opts.ownerId, limit, lifecycleStatus: opts.lifecycleStatus || 'confirmed' };
  const rows = getDb()
    .prepare<any, CustomSceneRow & { version_json: string | null }>(
      `SELECT s.*,
              v.id AS version_id,
              v.version_no AS version_no,
              v.generation_status AS version_generation_status,
              v.source_type AS version_source_type,
              v.prompt AS version_prompt,
              v.params_json AS version_params_json,
              v.input_refs_json AS version_input_refs_json,
              v.scene_data_json AS version_json,
              v.result_image_id AS version_result_image_id,
              v.source_hash AS version_source_hash,
              v.error_message AS version_error_message,
              v.created_at AS version_created_at,
              v.updated_at AS version_updated_at
         FROM custom_scenes s
         LEFT JOIN custom_scene_versions v
           ON v.id = s.current_version_id AND v.owner_id = s.owner_id
        WHERE s.owner_id = @ownerId AND s.lifecycle_status = @lifecycleStatus
        ORDER BY s.updated_at DESC
        LIMIT @limit`,
    )
    .all(params);
  const items = rows.map((row: any) => serializeCustomScene(row, row.version_json, row.version_id ? {
    id: row.version_id,
    scene_id: row.id,
    owner_id: row.owner_id,
    project_id: row.project_id,
    version_no: row.version_no,
    generation_status: row.version_generation_status,
    source_type: row.version_source_type,
    prompt: row.version_prompt,
    params_json: row.version_params_json,
    input_refs_json: row.version_input_refs_json,
    scene_data_json: row.version_json,
    result_image_id: row.version_result_image_id,
    source_hash: row.version_source_hash,
    error_message: row.version_error_message,
    created_at: row.version_created_at,
    updated_at: row.version_updated_at,
  } : null));
  return (params.lifecycleStatus === 'confirmed')
    ? items.filter(isDisplayableConfirmedScene)
    : items;
}

export function listCustomSceneVersions(sceneId: string, ownerId: number) {
  const rows = getDb()
    .prepare<{ sceneId: string; ownerId: number }, CustomSceneVersionRow>(
      `SELECT * FROM custom_scene_versions
        WHERE scene_id = @sceneId AND owner_id = @ownerId
        ORDER BY version_no DESC`,
    )
    .all({ sceneId, ownerId });
  return rows.map(serializeCustomSceneVersion);
}

export function getCurrentCustomSceneVersion(scene: CustomSceneRow | null | undefined) {
  if (!scene?.current_version_id) return null;
  return getCustomSceneVersionForUser(scene.current_version_id, scene.owner_id);
}

export function getNextCustomSceneVersionNo(sceneId: string, ownerId: number) {
  const row = getDb()
    .prepare<{ sceneId: string; ownerId: number }, { n: number }>(
      `SELECT COALESCE(MAX(version_no), 0) + 1 AS n
        FROM custom_scene_versions
        WHERE scene_id = @sceneId AND owner_id = @ownerId`,
    )
    .get({ sceneId, ownerId });
  return Number(row?.n || 1);
}

export function createCustomSceneVersion(input: UpsertCustomSceneVersionInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const sceneId = input.sceneId || randomUUID();
  const existing = getCustomSceneForUser(sceneId, input.ownerId);
  const sceneData = input.sceneData || {};
  const title = cleanTitle(input.title || sceneTitle(sceneData));
  const lifecycleStatus: CustomSceneLifecycleStatus = input.lifecycleStatus || existing?.lifecycle_status || 'confirmed';
  const versionNo = existing ? getNextCustomSceneVersionNo(sceneId, input.ownerId) : 1;
  const versionId = randomUUID();
  const prompt = String(input.prompt || '').slice(0, 8000);
  const params = input.params || {};
  const inputRefs = input.inputRefs || [];
  const sourceHash = computeCustomSceneSourceHash({ prompt, params, inputRefs });
  const shouldMakeCurrent = input.makeCurrent !== false || !existing?.current_version_id;

  const tx = db.transaction(() => {
    if (!existing) {
      db.prepare(
        `INSERT INTO custom_scenes
          (id, owner_id, project_id, current_version_id, title, lifecycle_status, confirmed_at, created_at, updated_at)
         VALUES
          (@id, @ownerId, @projectId, @versionId, @title, @lifecycleStatus, @confirmedAt, @now, @now)`,
      ).run({
        id: sceneId,
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
      `INSERT INTO custom_scene_versions
        (id, scene_id, owner_id, project_id, version_no, generation_status, source_type,
         prompt, params_json, input_refs_json, scene_data_json, result_image_id,
         source_hash, error_message, created_at, updated_at)
       VALUES
        (@id, @sceneId, @ownerId, @projectId, @versionNo, @generationStatus, @sourceType,
         @prompt, @paramsJson, @inputRefsJson, @sceneDataJson, @resultImageId,
         @sourceHash, @errorMessage, @now, @now)`,
    ).run({
      id: versionId,
      sceneId,
      ownerId: input.ownerId,
      projectId: input.projectId || existing?.project_id || null,
      versionNo,
      generationStatus: input.generationStatus || 'completed',
      sourceType: input.sourceType,
      prompt,
      paramsJson: JSON.stringify(params),
      inputRefsJson: JSON.stringify(inputRefs),
      sceneDataJson: JSON.stringify(sceneData),
      resultImageId: input.resultImageId || null,
      sourceHash,
      errorMessage: input.errorMessage || null,
      now,
    });

    if (shouldMakeCurrent) {
      db.prepare(
        `UPDATE custom_scenes
            SET current_version_id = @versionId,
                title = @title,
                updated_at = @now
          WHERE id = @sceneId AND owner_id = @ownerId`,
      ).run({
        versionId,
        title: cleanTitle(input.title || sceneTitle(sceneData, existing?.title)),
        now,
        sceneId,
        ownerId: input.ownerId,
      });
    } else {
      db.prepare(
        `UPDATE custom_scenes
            SET updated_at = @now
          WHERE id = @sceneId AND owner_id = @ownerId`,
      ).run({ now, sceneId, ownerId: input.ownerId });
    }
  });
  tx();

  return getCustomSceneVersionForUser(versionId, input.ownerId)!;
}

export function finalizeCustomSceneVersion(input: {
  versionId: string;
  ownerId: number;
  generationStatus: CustomSceneGenerationStatus;
  sceneData: Record<string, any>;
  resultImageId?: string | null;
  errorMessage?: string | null;
  title?: string | null;
}) {
  const version = getCustomSceneVersionForUser(input.versionId, input.ownerId);
  if (!version) throw new Error('场景草稿版本不存在');
  const now = new Date().toISOString();
  const sceneData = input.sceneData || {};
  const title = sceneTitle(sceneData, input.title);
  const tx = getDb().transaction(() => {
    getDb().prepare(
      `UPDATE custom_scene_versions
          SET generation_status = @generationStatus,
              scene_data_json = @sceneDataJson,
              result_image_id = @resultImageId,
              error_message = @errorMessage,
              updated_at = @now
        WHERE id = @versionId AND owner_id = @ownerId`,
    ).run({
      generationStatus: input.generationStatus,
      sceneDataJson: JSON.stringify(sceneData),
      resultImageId: input.resultImageId || null,
      errorMessage: input.errorMessage || null,
      now,
      versionId: input.versionId,
      ownerId: input.ownerId,
    });
    getDb().prepare(
      `UPDATE custom_scenes
          SET title = CASE WHEN current_version_id = @versionId THEN @title ELSE title END,
              updated_at = @now
        WHERE id = @sceneId AND owner_id = @ownerId`,
    ).run({ title, now, versionId: input.versionId, sceneId: version.scene_id, ownerId: input.ownerId });
  });
  tx();
  return getCustomSceneVersionForUser(input.versionId, input.ownerId)!;
}

export function promoteCustomSceneVersion(ownerId: number, sceneId: string, versionId: string, title?: string | null) {
  const version = getCustomSceneVersionForUser(versionId, ownerId);
  if (!version || version.scene_id !== sceneId) throw new Error('场景版本不存在');
  const sceneData = safeJson(version.scene_data_json, {});
  const now = new Date().toISOString();
  getDb().prepare(
    `UPDATE custom_scenes
        SET current_version_id = @versionId,
            title = @title,
            updated_at = @now
      WHERE id = @sceneId AND owner_id = @ownerId`,
  ).run({ versionId, title: sceneTitle(sceneData, title), now, sceneId, ownerId });
  return getCustomSceneForUser(sceneId, ownerId)!;
}

export function updateCurrentCustomSceneVersionData(input: {
  ownerId: number;
  sceneId: string;
  sceneData: Record<string, any>;
  resultImageId?: string | null;
  errorMessage?: string | null;
  title?: string | null;
}) {
  const scene = getCustomSceneForUser(input.sceneId, input.ownerId);
  if (!scene?.current_version_id) throw new Error('场景当前版本不存在');
  const version = getCustomSceneVersionForUser(scene.current_version_id, input.ownerId);
  if (!version || version.scene_id !== scene.id) throw new Error('场景当前版本不存在');
  const now = new Date().toISOString();
  const title = sceneTitle(input.sceneData, input.title || scene.title);
  const tx = getDb().transaction(() => {
    getDb().prepare(
      `UPDATE custom_scene_versions
          SET scene_data_json = @sceneDataJson,
              result_image_id = COALESCE(@resultImageId, result_image_id),
              error_message = @errorMessage,
              updated_at = @now
        WHERE id = @versionId AND owner_id = @ownerId`,
    ).run({
      sceneDataJson: JSON.stringify(input.sceneData || {}),
      resultImageId: input.resultImageId || null,
      errorMessage: input.errorMessage || null,
      now,
      versionId: version.id,
      ownerId: input.ownerId,
    });
    getDb().prepare(
      `UPDATE custom_scenes
          SET title = @title,
              updated_at = @now
        WHERE id = @sceneId AND owner_id = @ownerId`,
    ).run({ title, now, sceneId: scene.id, ownerId: input.ownerId });
  });
  tx();
  return getCustomSceneVersionForUser(version.id, input.ownerId)!;
}

function assertConfirmableVersion(version: CustomSceneVersionRow) {
  if (version.generation_status !== 'completed') throw new Error('只有生成完成的场景版本才能确认添加');
  const sceneData = safeJson(version.scene_data_json, {});
  if (!resolveSceneImageUrl(sceneData, { viewRole: 'establishing', gate: true })) {
    throw new Error('这个版本没有可用场景主视图，不能确认添加');
  }
  return sceneData;
}

export function confirmCustomSceneDraft(ownerId: number, sceneId: string, versionId: string, titleOverride?: string) {
  const scene = getCustomSceneForUser(sceneId, ownerId);
  if (!scene) throw new Error('场景草稿不存在，请刷新页面后再试');
  if (scene.lifecycle_status !== 'draft') throw new Error('这个场景已经添加过了');
  const version = getCustomSceneVersionForUser(versionId, ownerId);
  if (!version || version.scene_id !== scene.id) throw new Error('没有找到要确认的场景版本');
  const sceneData = assertConfirmableVersion(version);
  const overrideTitle = String(titleOverride || '').trim().slice(0, 80);
  if (overrideTitle) sceneData.name = overrideTitle;
  const title = sceneTitle(sceneData, overrideTitle || scene.title);
  const now = new Date().toISOString();

  const tx = getDb().transaction(() => {
    getDb().prepare(
      `DELETE FROM custom_scene_versions
        WHERE scene_id = @sceneId AND owner_id = @ownerId AND id <> @versionId`,
    ).run({ sceneId, ownerId, versionId });

    getDb().prepare(
      `UPDATE custom_scene_versions
          SET version_no = 1,
              prompt = '',
              params_json = '{}',
              input_refs_json = '[]',
              source_hash = NULL,
              scene_data_json = @sceneDataJson,
              updated_at = @now
        WHERE id = @versionId AND scene_id = @sceneId AND owner_id = @ownerId`,
    ).run({ sceneDataJson: JSON.stringify(sceneData), now, versionId, sceneId, ownerId });

    getDb().prepare(
      `UPDATE custom_scenes
          SET current_version_id = @versionId,
              title = @title,
              lifecycle_status = 'confirmed',
              confirmed_at = @now,
              updated_at = @now
        WHERE id = @sceneId AND owner_id = @ownerId AND lifecycle_status = 'draft'`,
    ).run({ versionId, title, now, sceneId, ownerId });
  });
  tx();
  return getCustomSceneForUser(sceneId, ownerId)!;
}

export function deleteCustomSceneDraft(ownerId: number, sceneId: string) {
  const result = getDb()
    .prepare<{ ownerId: number; sceneId: string }>(
      `DELETE FROM custom_scenes
        WHERE id = @sceneId AND owner_id = @ownerId AND lifecycle_status = 'draft'`,
    )
    .run({ ownerId, sceneId });
  return result.changes > 0;
}

export function deleteCustomSceneForUser(ownerId: number, sceneId: string) {
  const result = getDb()
    .prepare<{ ownerId: number; sceneId: string }>(
      `DELETE FROM custom_scenes
        WHERE id = @sceneId AND owner_id = @ownerId`,
    )
    .run({ ownerId, sceneId });
  return result.changes > 0;
}

export function cleanupStaleCustomSceneDrafts(ownerId: number, olderThanHours = 48) {
  const cutoff = new Date(Date.now() - Math.max(1, olderThanHours) * 60 * 60 * 1000).toISOString();
  const result = getDb()
    .prepare<{ ownerId: number; cutoff: string }>(
      `DELETE FROM custom_scenes
        WHERE owner_id = @ownerId
          AND lifecycle_status = 'draft'
          AND updated_at < @cutoff`,
    )
    .run({ ownerId, cutoff });
  return result.changes;
}

export function updateCustomSceneVersionData(
  versionId: string,
  ownerId: number,
  sceneData: Record<string, any>,
  title?: string | null,
) {
  const version = getCustomSceneVersionForUser(versionId, ownerId);
  if (!version) throw new Error('场景版本不存在');
  const now = new Date().toISOString();
  const nextTitle = sceneTitle(sceneData, title);
  const tx = getDb().transaction(() => {
    getDb().prepare(
      `UPDATE custom_scene_versions
          SET scene_data_json = @sceneDataJson,
              updated_at = @now
        WHERE id = @versionId AND owner_id = @ownerId`,
    ).run({ sceneDataJson: JSON.stringify(sceneData || {}), now, versionId, ownerId });

    getDb().prepare(
      `UPDATE custom_scenes
          SET title = CASE WHEN current_version_id = @versionId THEN @title ELSE title END,
              updated_at = @now
        WHERE id = @sceneId AND owner_id = @ownerId`,
    ).run({ title: nextTitle, now, versionId, sceneId: version.scene_id, ownerId });
  });
  tx();
  return getCustomSceneVersionForUser(versionId, ownerId)!;
}

export function serializeCustomScene(row: CustomSceneRow, currentSceneJson?: string | null, currentVersion?: CustomSceneVersionRow | null) {
  return {
    id: row.id,
    projectId: row.project_id,
    currentVersionId: row.current_version_id,
    title: row.title,
    lifecycleStatus: row.lifecycle_status || 'confirmed',
    confirmedAt: row.confirmed_at || null,
    current: safeJson(currentSceneJson, null),
    currentVersion: currentVersion ? serializeCustomSceneVersion(currentVersion) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeCustomSceneVersion(row: CustomSceneVersionRow) {
  const generationStatus = row.generation_status;
  return {
    id: row.id,
    sceneId: row.scene_id,
    projectId: row.project_id,
    versionNo: row.version_no,
    generationStatus,
    status: generationStatus,
    sourceType: row.source_type,
    prompt: row.prompt,
    params: safeJson(row.params_json, {}),
    inputRefs: safeJson(row.input_refs_json, []),
    sceneData: safeJson(row.scene_data_json, {}),
    fields: safeJson(row.scene_data_json, {}),
    resultImageId: row.result_image_id,
    sourceHash: row.source_hash,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
