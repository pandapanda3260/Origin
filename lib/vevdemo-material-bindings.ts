import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from './runtime-paths';

export type VevDemoMaterialResourceType = 'video_task' | 'upload' | 'bgm';

export interface VevDemoMaterialBinding {
  resourceType: VevDemoMaterialResourceType;
  resourceId: string;
  originProjectId?: string | null;
  ownerId?: number;
  vevSource: string;
  vevProjectId?: string;
  vevGroupId?: string;
  vevSpace?: string;
  vevEditMid?: string;
  title?: string;
  uploadedAt?: string;
  registeredAt?: string;
  vid?: string;
  originFilePath?: string;
  uploadWorkflowTemplateId?: string | null;
  playInfo?: {
    mainPlayUrl?: string;
    backupPlayUrl?: string;
    codecs?: string[];
    h264?: boolean;
  };
}

interface BindingFile {
  version?: number;
  materials?: Record<string, VevDemoMaterialBinding>;
}

const BINDINGS_FILE = dataPath('vevdemo-material-bindings.json');

let bindingFileCache: { mtimeMs: number; data: BindingFile } | null = null;

function legacyBindingKey(resourceType: VevDemoMaterialResourceType, resourceId: string) {
  return `${resourceType}:${resourceId}`;
}

function projectBindingKey(resourceType: VevDemoMaterialResourceType, resourceId: string, vevProjectId: string) {
  return `${legacyBindingKey(resourceType, resourceId)}:${vevProjectId}`;
}

function bindingKey(entry: VevDemoMaterialBinding) {
  const vevProjectId = String(entry.vevProjectId || '').trim();
  return vevProjectId
    ? projectBindingKey(entry.resourceType, entry.resourceId, vevProjectId)
    : legacyBindingKey(entry.resourceType, entry.resourceId);
}

function isValidBinding(binding: VevDemoMaterialBinding | undefined | null): binding is VevDemoMaterialBinding {
  return Boolean(binding?.vevSource);
}

function matchesResource(
  binding: VevDemoMaterialBinding,
  resourceType: VevDemoMaterialResourceType,
  resourceId: string,
) {
  return binding.resourceType === resourceType && binding.resourceId === resourceId;
}

function readBindingFile(): BindingFile {
  if (!existsSync(BINDINGS_FILE)) return { version: 1, materials: {} };
  try {
    const stat = statSync(BINDINGS_FILE);
    if (bindingFileCache && bindingFileCache.mtimeMs === stat.mtimeMs) return bindingFileCache.data;
    const parsed = JSON.parse(readFileSync(BINDINGS_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { version: 1, materials: {} };
    const data = {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      materials: parsed.materials && typeof parsed.materials === 'object' ? parsed.materials : {},
    };
    bindingFileCache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch (error) {
    console.warn(`[vevdemo-material-bindings] failed to read ${BINDINGS_FILE}:`, error);
    return { version: 1, materials: {} };
  }
}

export function saveVevDemoMaterialBinding(entry: VevDemoMaterialBinding): void {
  const data = readBindingFile();
  data.version = 1;
  data.materials ||= {};
  data.materials[bindingKey(entry)] = entry;

  mkdirSync(dirname(BINDINGS_FILE), { recursive: true });
  const tmp = `${BINDINGS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, BINDINGS_FILE);
  bindingFileCache = { mtimeMs: statSync(BINDINGS_FILE).mtimeMs, data };
}

export function getVevDemoMaterialBinding(
  resourceType: VevDemoMaterialResourceType,
  resourceId: string,
  vevProjectId?: string | null,
): VevDemoMaterialBinding | null {
  const materials = readBindingFile().materials || {};
  const targetProjectId = String(vevProjectId || '').trim();

  if (targetProjectId) {
    const projectBinding = materials[projectBindingKey(resourceType, resourceId, targetProjectId)];
    if (isValidBinding(projectBinding)) return projectBinding;

    const legacyBinding = materials[legacyBindingKey(resourceType, resourceId)];
    if (
      isValidBinding(legacyBinding) &&
      (!legacyBinding.vevProjectId || legacyBinding.vevProjectId === targetProjectId)
    ) {
      return legacyBinding;
    }

    const matchingBinding = Object.values(materials).find((binding) => (
      isValidBinding(binding) &&
      matchesResource(binding, resourceType, resourceId) &&
      binding.vevProjectId === targetProjectId
    ));
    return matchingBinding || null;
  }

  const legacyBinding = materials[legacyBindingKey(resourceType, resourceId)];
  if (isValidBinding(legacyBinding)) return legacyBinding;

  const firstMatchingBinding = Object.values(materials).find((binding) => (
    isValidBinding(binding) && matchesResource(binding, resourceType, resourceId)
  ));
  return firstMatchingBinding || null;
}
