import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_DATA_DIR = join(process.cwd(), 'data');

function normalizeStorageDriver(value: string | undefined) {
  const driver = (value || 'local').trim().toLowerCase();
  return driver || 'local';
}

export function getDataDir() {
  const raw = (process.env.ORIGIN_DATA_DIR || process.env.DATA_DIR || DEFAULT_DATA_DIR).trim();
  return resolve(raw || DEFAULT_DATA_DIR);
}

export function dataPath(...parts: string[]) {
  return join(getDataDir(), ...parts);
}

export function getObjectStorageDriver() {
  return normalizeStorageDriver(process.env.ORIGIN_OBJECT_STORAGE_DRIVER || process.env.ORIGIN_STORAGE_DRIVER);
}

export function describeRuntimeStorage() {
  const dataDir = getDataDir();
  const driver = getObjectStorageDriver();
  return {
    driver,
    dataDir,
    durableLocalVolume: driver === 'local' && dataDir !== resolve(DEFAULT_DATA_DIR),
    exists: existsSync(dataDir),
  };
}
