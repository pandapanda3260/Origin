/**
 * Frontend module cache-busting contract.
 *
 * Source files must import local browser modules through canonical import-map
 * keys only. workspace.html owns cache-busting versions for those keys.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUB = join(ROOT, 'public');
const MODULES = join(PUB, 'modules');
const failures = [];

function publicPath(file) {
  return relative(ROOT, file).replace(/\\/g, '/');
}

function lineOf(text, pos) {
  const start = text.lastIndexOf('\n', pos) + 1;
  const end = text.indexOf('\n', pos);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

function canonicalModuleKey(spec, file) {
  const noQuery = spec.replace(/\?v=\d+$/, '');
  if (noQuery.startsWith('/modules/')) return noQuery;
  if (noQuery.startsWith('./modules/')) return '/modules/' + noQuery.slice('./modules/'.length);
  if (noQuery.startsWith('modules/')) return '/modules/' + noQuery.slice('modules/'.length);
  if (noQuery.startsWith('./') && publicPath(file).startsWith('public/modules/')) {
    return '/modules/' + noQuery.slice(2);
  }
  return null;
}

for (const [spec, expected] of [
  ['modules/store.js?v=1', '/modules/store.js'],
  ['/modules/store.js?v=1', '/modules/store.js'],
]) {
  const actual = canonicalModuleKey(spec, join(PUB, 'workspace.html'));
  if (actual !== expected) {
    failures.push(`[html-module-key-normalization] ${spec} -> ${actual}, expected ${expected}`);
  }
}

function collectJsImports(file) {
  const src = readFileSync(file, 'utf8');
  const refs = [];
  const patterns = [
    /(?:\bfrom\s*['"]|\bimport\s*['"])([^'"]+?\.js(?:\?v=\d+)?)(['"])/g,
    /\bimport\s*\(\s*['"]([^'"]+?\.js(?:\?v=\d+)?)(['"]\s*\))/g,
  ];
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) {
      const spec = match[1];
      const key = canonicalModuleKey(spec, file);
      if (!key) continue;
      refs.push({ spec, key, line: lineOf(src, match.index) });
    }
  }
  return refs;
}

const jsFiles = [
  join(PUB, 'main.js'),
  ...readdirSync(MODULES)
    .filter((file) => file.endsWith('.js'))
    .map((file) => join(MODULES, file)),
];

const importedKeys = new Map();
for (const file of jsFiles) {
  for (const ref of collectJsImports(file)) {
    const loc = `${publicPath(file)}: ${ref.line.slice(0, 140)}`;
    if (/\?v=\d+$/.test(ref.spec)) {
      failures.push(`[versioned-import] ${loc}`);
    }
    if (ref.spec !== ref.key) {
      failures.push(`[non-canonical-import] ${publicPath(file)} imports "${ref.spec}", expected "${ref.key}"`);
    }
    if (!importedKeys.has(ref.key)) importedKeys.set(ref.key, []);
    importedKeys.get(ref.key).push(publicPath(file));
  }
}

const workspacePath = join(PUB, 'workspace.html');
const workspace = readFileSync(workspacePath, 'utf8');
const importMapMatch = workspace.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/);
if (!importMapMatch) failures.push('[missing-importmap] public/workspace.html');

let importMap = {};
if (importMapMatch) {
  try {
    importMap = JSON.parse(importMapMatch[1]).imports || {};
  } catch (error) {
    failures.push(`[invalid-importmap-json] ${error.message}`);
  }
}

for (const [key, files] of importedKeys.entries()) {
  if (!importMap[key]) {
    failures.push(`[missing-importmap-entry] ${key} imported by ${[...new Set(files)].join(', ')}`);
  }
}

for (const [key, target] of Object.entries(importMap)) {
  if (!key.startsWith('/modules/') || !key.endsWith('.js')) {
    failures.push(`[invalid-importmap-key] ${key}`);
    continue;
  }
  const expectedPrefix = `${key}?v=`;
  if (!String(target).startsWith(expectedPrefix) || !/\?v=\d+$/.test(String(target))) {
    failures.push(`[invalid-importmap-target] ${key}: ${target}`);
  }
}

for (const match of workspace.matchAll(/<(script|link)\b[^>]+(?:src|href)="([^"]+\.(?:js|css)(?:\?v=\d+)?)"/g)) {
  const tag = match[1];
  const spec = match[2];
  if (/^https?:\/\//.test(spec)) continue;
  if (!/\?v=\d+$/.test(spec)) {
    failures.push(`[unversioned-html-${tag}] ${spec}`);
    continue;
  }
  if (tag !== 'script') continue;
  const key = canonicalModuleKey(spec, workspacePath);
  if (!key || !importMap[key]) continue;
  const tagVersion = spec.match(/\?v=(\d+)$/)?.[1];
  const mapVersion = String(importMap[key]).match(/\?v=(\d+)$/)?.[1];
  if (tagVersion !== mapVersion) {
    failures.push(`[html-importmap-version-split] ${spec} vs ${importMap[key]}`);
  }
}

if (failures.length) {
  console.error(`✗ frontend cache-busting contract failed (${failures.length})`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `✓ frontend cache-busting contract passed: ${importedKeys.size} imported modules, ${Object.keys(importMap).length} import-map entries`,
);
