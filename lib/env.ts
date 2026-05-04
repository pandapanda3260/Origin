import { existsSync, readFileSync } from 'node:fs';

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
  error?: string;
} | null = null;

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
    error: undefined as string | undefined,
  };

  for (const path of paths) {
    if (!path || !existsSync(path)) continue;

    try {
      const parsed = parseDotEnv(readFileSync(path, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) {
        if (protectedKeys.has(key)) continue;
        process.env[key] = value;
        if (!result.keys.includes(key)) result.keys.push(key);
      }
      result.loaded = true;
    } catch (e: any) {
      const message = `${path}: ${e?.message || String(e)}`;
      result.error = result.error ? `${result.error}; ${message}` : message;
    }
  }

  loadResult = result;
  return result;
}

export function getExternalEnvLoadResult() {
  return loadResult || loadExternalEnv();
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
