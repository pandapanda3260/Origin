import { randomUUID } from 'node:crypto';

type Project = {
  id: string;
  ownerId: number;
  title: string;
  description: string;
  coverUrl: string | null;
  oneSentence: string;
  scriptDraft: string;
  styleBible: { vision: string; narrative: string; camera: string; mood: string; promptHabits: string };
  characters: any[];
  environments: any[];
  props: any[];
  shots: any[];
  storyboards: any[];
  videoPrompts: any[];
  videoTasks: any[];
  episodes: any[];
  preferences: any;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'in_progress' | 'completed';
};

const now = () => new Date().toISOString();

const PROJECTS_STORE: Project[] = [];

export function listProjects() {
  return PROJECTS_STORE.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    coverUrl: p.coverUrl,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

export function getProject(id: string) {
  return PROJECTS_STORE.find((p) => p.id === id) || null;
}

export function createProject(payload: Partial<Project>) {
  const id = randomUUID();
  const project: Project = {
    id,
    ownerId: 1,
    title: payload.title || '未命名项目',
    description: payload.description || '',
    coverUrl: null,
    oneSentence: payload.oneSentence || '',
    scriptDraft: '',
    styleBible: { vision: '', narrative: '', camera: '', mood: '', promptHabits: '' },
    characters: [],
    environments: [],
    props: [],
    shots: [],
    storyboards: [],
    videoPrompts: [],
    videoTasks: [],
    episodes: [],
    preferences: null,
    createdAt: now(),
    updatedAt: now(),
    status: 'draft',
  };
  PROJECTS_STORE.unshift(project);
  return project;
}

export function updateProject(id: string, patch: Partial<Project>) {
  const idx = PROJECTS_STORE.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  PROJECTS_STORE[idx] = { ...PROJECTS_STORE[idx], ...patch, updatedAt: now() };
  return PROJECTS_STORE[idx];
}

export function deleteProject(id: string) {
  const idx = PROJECTS_STORE.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  PROJECTS_STORE.splice(idx, 1);
  return true;
}
