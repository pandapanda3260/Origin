#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODEL_HOST_RE = /(api\.openai\.com|gateway\.zerail\.com|zerail\.com|ark\.cn-[\w.-]*volces\.com|volces\.com|volcengine\.com)/i;
const DIRECT_REQUEST_RE = /\b(fetch|httpRequest|httpsRequest)\s*\(/;
const DIRECT_FETCH_RE = /\bfetch\s*\(/;

const API_DIR = path.join(ROOT, 'app', 'api');
const CORE_MODEL_FILES = [
  'lib/llm.ts',
  'lib/image-gen.ts',
  'lib/video-gen.ts',
];

const findings = [];

for (const file of walk(API_DIR)) {
  if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (MODEL_HOST_RE.test(text) && DIRECT_REQUEST_RE.test(text)) {
    findings.push({
      file,
      reason: 'app/api route mixes a model host with direct fetch/httpRequest; use lib/proxy-fetch or the model wrapper instead.',
    });
  }
}

for (const rel of CORE_MODEL_FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (DIRECT_FETCH_RE.test(text)) {
    findings.push({
      file,
      reason: 'core model wrapper contains bare fetch(); use fetchViaProxy/postJsonStreamRequest instead.',
    });
  }
}

if (findings.length) {
  console.error('FAIL: direct model fetch guard found unsafe call sites.');
  for (const item of findings) {
    console.error(`- ${path.relative(ROOT, item.file)}: ${item.reason}`);
  }
  process.exit(1);
}

console.log('OK: no direct model fetch call sites found.');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
