import { createHmac } from 'node:crypto';
import { getDb } from './db';
import { getExternalEnvValue, loadExternalEnv } from './env';
import {
  getVevDemoProjectBinding,
  saveVevDemoProjectBinding,
  type VevDemoProjectBinding,
} from './vevdemo-project-bindings';

type ProjectRow = {
  id: string;
  owner_id: number;
  title: string;
};

const projectLocks = new Map<string, Promise<VevDemoProjectBinding>>();

function envValue(key: string): string {
  return (getExternalEnvValue(key) || process.env[key] || '').trim();
}

function getRequiredEnv(key: string): string {
  const value = envValue(key);
  if (!value) throw new Error(`Missing required env: ${key}`);
  return value;
}

function loadOpenapi(): any {
  const modulePath = `${process.cwd()}/vevdemo-1.0.6/nodejs/node_modules/@volcengine/openapi`;
  const nodeRequire = eval('require') as NodeRequire;
  return nodeRequire(modulePath);
}

function apiError(data: any): any {
  return data?.ResponseMetadata?.Error || null;
}

function sanitizeProjectName(title: string, originProjectId: string) {
  const base = String(title || originProjectId || 'origin-project')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'origin-project';
  const suffix = createHmac('sha1', 'vevdemo-project').update(originProjectId).digest('hex').slice(0, 8);
  return `${base}-${suffix}`;
}

function buildInitialEditParam(projectName: string, space: string) {
  const now = Date.now();
  return {
    Project: {
      Version: '1.0.0',
      Name: projectName,
      CreateTime: now,
      UpdateTime: now,
      Tag: 'TrackEditor',
    },
    Upload: {
      SpaceName: space,
      VideoName: projectName,
    },
    Output: {
      Alpha: false,
      Fps: 25,
      Codec: {
        VideoCodec: 'h264',
        Preset: 'slow',
        Crf: 23,
        AudioCodec: 'aac',
        AudioBitrate: 128,
      },
      DisableVideo: false,
      DisableAudio: false,
      Cover: {
        DisableCover: false,
        CoverTime: [0],
      },
    },
    Canvas: {
      Width: 1080,
      Height: 1920,
      BackgroundColor: '#000000FF',
    },
  };
}

async function signedVodRequest(action: string, body: Record<string, unknown>) {
  const { Signer } = loadOpenapi();
  const region = envValue('VITE_VEV_REGION') || 'cn-north-1';
  const params = {
    Action: action,
    Version: '2018-01-01',
  };
  const requestData = {
    method: 'POST',
    region,
    params,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  };
  const signer = new Signer(requestData, 'vod');
  signer.addAuthorization({
    accessKeyId: getRequiredEnv('VOLC_ACCESS_KEY'),
    secretKey: getRequiredEnv('VOLC_SECRET_KEY'),
  });
  const res = await fetch(`https://vod.volcengineapi.com/?${new URLSearchParams(params).toString()}`, {
    method: 'POST',
    headers: requestData.headers,
    body: requestData.body,
  });
  return res.json();
}

function getOriginProject(projectId: string, ownerId: number): ProjectRow {
  const row = getDb()
    .prepare<{ id: string; owner_id: number }, ProjectRow>(
      'SELECT id, owner_id, title FROM projects WHERE id = @id AND owner_id = @owner_id',
    )
    .get({ id: projectId, owner_id: ownerId });
  if (!row) throw new Error(`Origin project not found or not owned by user: ${projectId}`);
  return row;
}

async function createVevDemoProjectForOrigin(project: ProjectRow): Promise<VevDemoProjectBinding> {
  const space = envValue('VITE_VEV_SPACE') || 'origin';
  const projectName = sanitizeProjectName(project.title, project.id);
  const data = await signedVodRequest('CreateProject', {
    ProjectName: projectName,
    Space: space,
    ProjectType: 'track',
    EditParam: buildInitialEditParam(projectName, space),
  });
  const error = apiError(data);
  if (error) {
    throw new Error(`CreateProject failed: ${error.Code || ''} ${error.Message || ''}`.trim());
  }
  const vevProjectId = data?.Result?.ProjectId;
  const vevGroupId = data?.Result?.GroupId || envValue('VITE_VEV_GROUP_ID');
  if (!vevProjectId || !vevGroupId) {
    throw new Error(`CreateProject did not return ProjectId/GroupId: ${JSON.stringify(data).slice(0, 500)}`);
  }
  const now = new Date().toISOString();
  const binding: VevDemoProjectBinding = {
    originProjectId: project.id,
    ownerId: Number(project.owner_id),
    originTitle: project.title,
    vevProjectId,
    vevGroupId,
    vevSpace: space,
    createdAt: now,
    updatedAt: now,
  };
  saveVevDemoProjectBinding(binding);
  return binding;
}

async function ensureVevDemoProjectBindingInner(originProjectId: string, ownerId: number): Promise<VevDemoProjectBinding> {
  loadExternalEnv();
  const existing = getVevDemoProjectBinding(originProjectId);
  if (existing) {
    if (Number(existing.ownerId) !== Number(ownerId)) {
      throw new Error(`VevDemo project binding owner mismatch for ${originProjectId}`);
    }
    return existing;
  }
  const project = getOriginProject(originProjectId, ownerId);
  return createVevDemoProjectForOrigin(project);
}

export function ensureVevDemoProjectBinding(
  originProjectId: string,
  ownerId: number,
): Promise<VevDemoProjectBinding> {
  const key = `${ownerId}:${originProjectId}`;
  const existing = projectLocks.get(key);
  if (existing) return existing;
  const promise = ensureVevDemoProjectBindingInner(originProjectId, ownerId)
    .finally(() => projectLocks.delete(key));
  projectLocks.set(key, promise);
  return promise;
}
