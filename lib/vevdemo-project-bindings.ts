import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from './runtime-paths';

export interface VevDemoProjectBinding {
  originProjectId: string;
  ownerId: number;
  originTitle?: string | null;
  vevProjectId: string;
  vevGroupId: string;
  vevSpace: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectBindingFile {
  version?: number;
  projects?: Record<string, VevDemoProjectBinding>;
}

const BINDINGS_FILE = dataPath('vevdemo-project-bindings.json');

let bindingFileCache: { mtimeMs: number; data: ProjectBindingFile } | null = null;

function readBindingFile(): ProjectBindingFile {
  if (!existsSync(BINDINGS_FILE)) return { version: 1, projects: {} };
  try {
    const stat = statSync(BINDINGS_FILE);
    if (bindingFileCache && bindingFileCache.mtimeMs === stat.mtimeMs) return bindingFileCache.data;
    const parsed = JSON.parse(readFileSync(BINDINGS_FILE, 'utf8'));
    const data = {
      version: typeof parsed?.version === 'number' ? parsed.version : 1,
      projects: parsed?.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
    };
    bindingFileCache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch (error) {
    console.warn(`[vevdemo-project-bindings] failed to read ${BINDINGS_FILE}:`, error);
    return { version: 1, projects: {} };
  }
}

export function getVevDemoProjectBinding(originProjectId: string): VevDemoProjectBinding | null {
  const binding = readBindingFile().projects?.[originProjectId];
  if (!binding?.vevProjectId || !binding?.vevGroupId) return null;
  return binding;
}

export function saveVevDemoProjectBinding(binding: VevDemoProjectBinding): void {
  const data = readBindingFile();
  data.version = 1;
  data.projects ||= {};
  data.projects[binding.originProjectId] = binding;

  mkdirSync(dirname(BINDINGS_FILE), { recursive: true });
  const tmp = `${BINDINGS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, BINDINGS_FILE);
  bindingFileCache = { mtimeMs: statSync(BINDINGS_FILE).mtimeMs, data };
}
