export type CharacterAssetMode = 'identity' | 'anonymous_crowd';

const CROWD_TEXT_RE = /群像|人群|群众|群演|路人|背景人|crowd|extras|background people|group/i;

function hasOwn(obj: any, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function cleanText(value: any): string {
  return String(value ?? '').trim();
}

function textFromValues(values: any[]): string {
  return values.flat().map(cleanText).filter(Boolean).join(' ');
}

export function normalizeCrowdFlag(value: any): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = cleanText(value).toLowerCase();
  if (!text) return false;
  if (/^(1|true|yes|on|crowd|group|群体|群像|人群)$/.test(text)) return true;
  if (/^(0|false|no|off|single|identity|person|单人|个体|普通)$/.test(text)) return false;
  return undefined;
}

export function normalizeCrowdFlagForCompare(value: any): 'true' | 'false' {
  return normalizeCrowdFlag(value) === true ? 'true' : 'false';
}

export function normalizeCrowdSize(value: any): string {
  return cleanText(value).slice(0, 40);
}

export function isLegacyCrowdText(value: any): boolean {
  return CROWD_TEXT_RE.test(cleanText(value));
}

export function isAnonymousCrowdAsset(asset: any): boolean {
  if (!asset || typeof asset !== 'object') return false;
  if (hasOwn(asset, 'isCrowd')) {
    return normalizeCrowdFlag(asset.isCrowd) === true;
  }
  const text = textFromValues([
    asset.name,
    asset.role,
    asset.identity,
    asset.description,
    asset.appearance,
    asset.category,
    asset.tags,
    asset.crowdSize,
  ]);
  return isLegacyCrowdText(text);
}

export function characterAssetModeFor(asset: any): CharacterAssetMode {
  return isAnonymousCrowdAsset(asset) ? 'anonymous_crowd' : 'identity';
}
