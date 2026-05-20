import { getExternalEnvValue } from './env';

type ConfigReader = (key: string) => string | undefined;

export type VevDemoUrlConfig = {
  editorUrl: string;
  apiUrl: string;
  editorProjectUrl: string;
  missingKeys: string[];
  legacyKeysUsed: string[];
};

const OLD_EDITOR_URL_KEY = 'VEVDEMO_FRONTEND_URL';
const OLD_API_URL_KEY = 'VEVDEMO_BACKEND_URL';
const OLD_PROJECT_URL_KEY = 'VEVDEMO_IFRAME_PROJECT_URL';

const NEW_EDITOR_URL_KEY = 'VEVDEMO_EDITOR_URL';
const NEW_API_URL_KEY = 'VEVDEMO_API_URL';
const NEW_PROJECT_URL_KEY = 'VEVDEMO_EDITOR_PROJECT_URL';

function defaultConfigReader(key: string): string | undefined {
  return getExternalEnvValue(key) || process.env[key];
}

function normalizeConfigUrl(value: string | undefined): string {
  return (value || '').trim().replace(/\/+$/, '');
}

function readConfigValue(key: string, reader: ConfigReader): string {
  return normalizeConfigUrl(reader(key));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function readVevDemoEditorUrl(reader: ConfigReader = defaultConfigReader): string {
  return readConfigValue(NEW_EDITOR_URL_KEY, reader) || readConfigValue(OLD_EDITOR_URL_KEY, reader);
}

export function readVevDemoApiUrl(reader: ConfigReader = defaultConfigReader): string {
  return readConfigValue(NEW_API_URL_KEY, reader) || readConfigValue(OLD_API_URL_KEY, reader);
}

export function readVevDemoEditorProjectUrl(reader: ConfigReader = defaultConfigReader): string {
  return (
    readConfigValue(NEW_PROJECT_URL_KEY, reader) ||
    readConfigValue(OLD_PROJECT_URL_KEY, reader) ||
    readVevDemoEditorUrl(reader)
  );
}

export function readVevDemoUrlConfig(reader: ConfigReader = defaultConfigReader): VevDemoUrlConfig {
  const newEditorUrl = readConfigValue(NEW_EDITOR_URL_KEY, reader);
  const oldEditorUrl = readConfigValue(OLD_EDITOR_URL_KEY, reader);
  const newApiUrl = readConfigValue(NEW_API_URL_KEY, reader);
  const oldApiUrl = readConfigValue(OLD_API_URL_KEY, reader);
  const newProjectUrl = readConfigValue(NEW_PROJECT_URL_KEY, reader);
  const oldProjectUrl = readConfigValue(OLD_PROJECT_URL_KEY, reader);

  const editorUrl = newEditorUrl || oldEditorUrl;
  const apiUrl = newApiUrl || oldApiUrl;
  const editorProjectUrl = newProjectUrl || oldProjectUrl || editorUrl;
  const missingKeys: string[] = [];
  const legacyKeysUsed: string[] = [];

  if (!editorUrl) missingKeys.push(NEW_EDITOR_URL_KEY);
  if (!apiUrl) missingKeys.push(NEW_API_URL_KEY);

  if (!newEditorUrl && oldEditorUrl) legacyKeysUsed.push(OLD_EDITOR_URL_KEY);
  if (!newApiUrl && oldApiUrl) legacyKeysUsed.push(OLD_API_URL_KEY);
  if (!newProjectUrl && oldProjectUrl) legacyKeysUsed.push(OLD_PROJECT_URL_KEY);

  return {
    editorUrl,
    apiUrl,
    editorProjectUrl,
    missingKeys,
    legacyKeysUsed: unique(legacyKeysUsed),
  };
}

export const VEVDEMO_LEGACY_ENV_KEYS = [
  OLD_EDITOR_URL_KEY,
  OLD_API_URL_KEY,
  OLD_PROJECT_URL_KEY,
] as const;
