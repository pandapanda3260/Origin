import { existsSync, readFileSync, statSync } from 'node:fs';

const DEFAULT_EXTERNAL_ENV_FILES = [
  '/Users/mark/Documents/key/origin.env.local',
  '/Users/mark/Documents/key/openai.env.local',
];

let loaded = false;
let loadResult: {
  path: string;
  paths: string[];
  loaded: boolean;
  keys: string[];
  loadedAt: string;
  files: ExternalEnvFileSnapshot[];
  error?: string;
} | null = null;

export type ExternalEnvFileSnapshot = {
  path: string;
  exists: boolean;
  mtime?: string;
  mtimeMs?: number;
  size?: number;
  keys: string[];
  error?: string;
};

export type ExternalEnvSnapshot = {
  path: string;
  paths: string[];
  loaded: boolean;
  keys: string[];
  values: Record<string, string>;
  files: ExternalEnvFileSnapshot[];
  fileMaxModifiedAt: string | null;
  fileMaxModifiedMs: number | null;
  readAt: string;
  error?: string;
};

let snapshotCache: { signature: string; snapshot: ExternalEnvSnapshot } | null = null;

export function loadExternalEnv() {
  if (loaded && loadResult) return loadResult;
  loaded = true;

  const paths = getExternalEnvPaths();
  const protectedKeys = new Set(Object.keys(process.env));
  const result = {
    path: paths.join(','),
    paths,
    loaded: false,
    keys: [] as string[],
    loadedAt: new Date().toISOString(),
    files: [] as ExternalEnvFileSnapshot[],
    error: undefined as string | undefined,
  };

  for (const path of paths) {
    if (!path || !existsSync(path)) {
      result.files.push({ path, exists: false, keys: [] });
      continue;
    }

    try {
      const stat = statSync(path);
      const parsed = parseDotEnv(readFileSync(path, 'utf8'));
      result.files.push({
        path,
        exists: true,
        mtime: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        keys: Object.keys(parsed),
      });
      for (const [key, value] of Object.entries(parsed)) {
        if (protectedKeys.has(key)) continue;
        process.env[key] = value;
        if (!result.keys.includes(key)) result.keys.push(key);
      }
      result.loaded = true;
    } catch (e: any) {
      const message = `${path}: ${e?.message || String(e)}`;
      result.files.push({ path, exists: true, keys: [], error: e?.message || String(e) });
      result.error = result.error ? `${result.error}; ${message}` : message;
    }
  }

  loadResult = result;
  return result;
}

export function getExternalEnvLoadResult() {
  return loadResult || loadExternalEnv();
}

export function readExternalEnvSnapshot(): ExternalEnvSnapshot {
  const paths = getExternalEnvPaths();
  const fileStats = paths.map((path) => safeFileStat(path));
  const signature = fileStats
    .map((file) => `${file.path}:${file.exists ? `${file.mtimeMs || 0}:${file.size || 0}` : 'missing'}`)
    .join('|');

  if (snapshotCache && snapshotCache.signature === signature) return snapshotCache.snapshot;

  const values: Record<string, string> = {};
  const keys: string[] = [];
  const files: ExternalEnvFileSnapshot[] = [];
  let loadedAny = false;
  let error: string | undefined;

  for (const stat of fileStats) {
    if (!stat.exists) {
      files.push({ ...stat, keys: [] });
      continue;
    }

    try {
      const parsed = parseDotEnv(readFileSync(stat.path, 'utf8'));
      const parsedKeys = Object.keys(parsed);
      for (const [key, value] of Object.entries(parsed)) {
        values[key] = value;
        if (!keys.includes(key)) keys.push(key);
      }
      files.push({ ...stat, keys: parsedKeys });
      loadedAny = true;
    } catch (e: any) {
      const message = `${stat.path}: ${e?.message || String(e)}`;
      files.push({ ...stat, keys: [], error: e?.message || String(e) });
      error = error ? `${error}; ${message}` : message;
    }
  }

  const mtimes = files
    .map((file) => Number(file.mtimeMs || 0))
    .filter((mtimeMs) => Number.isFinite(mtimeMs) && mtimeMs > 0);
  const fileMaxModifiedMs = mtimes.length ? Math.max(...mtimes) : null;
  const snapshot: ExternalEnvSnapshot = {
    path: paths.join(','),
    paths,
    loaded: loadedAny,
    keys,
    values,
    files,
    fileMaxModifiedAt: fileMaxModifiedMs ? new Date(fileMaxModifiedMs).toISOString() : null,
    fileMaxModifiedMs,
    readAt: new Date().toISOString(),
    error,
  };
  snapshotCache = { signature, snapshot };
  return snapshot;
}

export function getExternalEnvValue(key: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
  const snapshot = readExternalEnvSnapshot();
  return Object.prototype.hasOwnProperty.call(snapshot.values, key) ? snapshot.values[key] : undefined;
}

function getExternalEnvPaths(): string[] {
  const single = (process.env.ORIGIN_ENV_FILE || '').trim();
  if (single) return [single];

  const list = (process.env.ORIGIN_ENV_FILES || '').trim();
  if (list) {
    return list
      .split(/[,;]/)
      .map((path) => path.trim())
      .filter(Boolean);
  }

  return DEFAULT_EXTERNAL_ENV_FILES;
}

function safeFileStat(path: string): ExternalEnvFileSnapshot {
  if (!path || !existsSync(path)) return { path, exists: false, keys: [] };
  try {
    const stat = statSync(path);
    return {
      path,
      exists: true,
      mtime: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      keys: [],
    };
  } catch (e: any) {
    return { path, exists: true, keys: [], error: e?.message || String(e) };
  }
}

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    value = stripInlineComment(value);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    }
    out[key] = value;
  }
  return out;
}

function stripInlineComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && value[i - 1] !== '\\') {
      quote = quote === ch ? null : quote || ch;
      continue;
    }
    if (ch === '#' && !quote && (i === 0 || /\s/.test(value[i - 1] || ''))) {
      return value.slice(0, i).trim();
    }
  }
  return value;
}
