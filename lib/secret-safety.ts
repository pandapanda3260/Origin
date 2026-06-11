const PLACEHOLDER_PREFIXES = [
  'replace-with',
  'your-',
  'origin-release-local-',
  'dev-jwt-secret',
  'dev-admin-jwt-secret',
  '填入',
  '请填',
  'todo',
  'xxx',
];

const PLACEHOLDER_FRAGMENTS = [
  'please-change',
  'change-me',
];

export function secretByteLength(value: string) {
  return Buffer.byteLength(value || '', 'utf8');
}

export function isPlaceholderSecret(value: string) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return PLACEHOLDER_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    || PLACEHOLDER_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function isProductionSecretUsable(value: string, minBytes = 32) {
  return secretByteLength(value) >= minBytes && !isPlaceholderSecret(value);
}

export function isProductionBuildPhase() {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

export function isSecretUsableForCurrentPhase(value: string, minBytes = 32) {
  if (isProductionBuildPhase()) return secretByteLength(value) >= minBytes;
  return isProductionSecretUsable(value, minBytes);
}
