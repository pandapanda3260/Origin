import { createHash } from 'node:crypto';

export function normalizeScriptForHash(script: any): string {
  return String(script || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/[ \t]+/g, ' '))
    .join('\n')
    .trim();
}

export function hashNormalizedScript(script: any): string {
  return createHash('sha256').update(normalizeScriptForHash(script), 'utf8').digest('hex');
}

function hasMeaningfulStyleBible(project: any): boolean {
  const sb = project?.styleBible;
  if (!sb || typeof sb !== 'object') return false;
  return Object.values(sb).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return String(value || '').trim().length > 0;
  });
}

export function maybeMarkStyleBibleStale(project: any, nextScript: any, reason = 'script_changed'): boolean {
  if (!project || !hasMeaningfulStyleBible(project)) return false;

  const current = normalizeScriptForHash(project.script || '');
  const next = normalizeScriptForHash(nextScript || '');
  if (current === next) return false;

  if (project.styleBibleSourceHash) {
    const nextHash = hashNormalizedScript(next);
    if (nextHash === project.styleBibleSourceHash) return false;
  }

  project.styleBibleStaleReason = reason;
  project.styleBibleStaleSince = new Date().toISOString();
  return true;
}
