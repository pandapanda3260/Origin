const fs = require('fs');
const path = require('path');

const root = process.cwd();
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.next-dev',
  'data',
  'node_modules',
  'reference-site',
  'vevdemo-1.0.6',
]);
const legacyMarkerTerms = [
  ['is', 'admin'].join('_'),
  ['admin', 'role'].join('_'),
  ['is', 'Admin'].join(''),
];
const legacyMarkerPattern = new RegExp(`\\b(?:${legacyMarkerTerms.join('|')})\\b`);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function rel(file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const failures = [];

function fail(file, message) {
  failures.push(`${rel(file)}: ${message}`);
}

const adminRouteFiles = walk(path.join(root, 'app/api/admin'));
const mutationMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
const unauditedMutationAllowlist = new Set([
  'app/api/admin/auth/login/route.ts',
]);

for (const file of adminRouteFiles) {
  const source = read(file);
  const fileRel = rel(file);
  if (/from\s+['"][^'"]*\/?lib\/auth['"]|from\s+['"]@\/lib\/auth['"]/.test(source)) {
    fail(file, 'admin API routes must not import lib/auth; use lib/admin-auth or lib/admin-audit.');
  }
  if (/x-admin-token/i.test(source)) {
    fail(file, 'x-admin-token fallback is forbidden for admin API routes.');
  }
  if (/JWT_SECRET/.test(source)) {
    fail(file, 'admin API routes must not reference JWT_SECRET.');
  }
  const hasAdminGuard = /from\s+['"]@\/lib\/admin-auth['"]/.test(source)
    || /from\s+['"]@\/lib\/admin-audit['"]/.test(source)
    || /from\s+['"][^'"]*\/lib\/admin-auth['"]/.test(source)
    || /from\s+['"][^'"]*\/lib\/admin-audit['"]/.test(source);
  if (!hasAdminGuard) {
    fail(file, 'admin API routes must use lib/admin-auth or lib/admin-audit.');
  }
  const exportsMutation = mutationMethods.some((method) => new RegExp(`export\\s+(?:async\\s+function|const)\\s+${method}\\b`).test(source));
  if (exportsMutation && !/withAdminAudit/.test(source) && !unauditedMutationAllowlist.has(fileRel)) {
    fail(file, 'admin API mutation handlers must be wrapped with withAdminAudit.');
  }
}

const sourceFiles = walk(root);
for (const file of sourceFiles) {
  const source = read(file);
  if (legacyMarkerPattern.test(source)) {
    fail(file, 'source code must not reference legacy user admin markers.');
  }
}

const adminStyleFiles = [
  ...walk(path.join(root, 'app/admin')),
  path.join(root, 'lib/admin-knowledge-page.ts'),
].filter((file) => fs.existsSync(file));
const adminStyleAllowlist = new Set([
  'app/admin/login/route.ts',
]);
const literalFontSizePattern = /font-size:\s*\d+(?:\.\d+)?px/;
const literalHexColorPattern = /#[0-9a-fA-F]{6}\b/;
for (const file of adminStyleFiles) {
  const fileRel = rel(file);
  if (adminStyleAllowlist.has(fileRel)) continue;
  const source = read(file);
  if (literalFontSizePattern.test(source)) {
    fail(file, 'admin pages must use shared typography tokens instead of literal px font-size declarations.');
  }
  if (literalHexColorPattern.test(source)) {
    fail(file, 'admin pages must use shared color tokens instead of literal hex colors.');
  }
}

const authMePath = path.join(root, 'app/api/auth/me/route.ts');
if (fs.existsSync(authMePath) && legacyMarkerPattern.test(read(authMePath))) {
  fail(authMePath, '/api/auth/me must not expose admin identity.');
}

for (const legacyPath of [
  'app/api/auth/admin/stats/route.ts',
  'app/api/auth/admin/logs/route.ts',
]) {
  const file = path.join(root, legacyPath);
  if (!fs.existsSync(file)) {
    failures.push(`${legacyPath}: legacy admin route should exist and return 410 Gone until callers are migrated.`);
    continue;
  }
  const source = read(file);
  if (!/410/.test(source) || !/Gone/i.test(source)) {
    fail(file, 'legacy admin routes must return 410 Gone.');
  }
}

for (const protectedPath of [
  'app/api/maintenance/banner/route.ts',
  'app/api/world-style-mappings/default/route.ts',
]) {
  const file = path.join(root, protectedPath);
  if (!fs.existsSync(file)) continue;
  const source = read(file);
  if (/from\s+['"][^'"]*\/?lib\/auth['"]|from\s+['"]@\/lib\/auth['"]/.test(source)) {
    fail(file, 'admin-protected legacy route must not import lib/auth.');
  }
  if (!/withAdminAudit/.test(source)) {
    fail(file, 'admin-protected legacy mutation route must use withAdminAudit.');
  }
}

if (failures.length) {
  console.error('admin governance check failed:');
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}

console.log(`admin governance check ok (${adminRouteFiles.length} admin route files scanned)`);
