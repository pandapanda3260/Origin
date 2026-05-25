import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(new URL('../app/api/frames/material-panels/route.ts', import.meta.url), 'utf8');

assert.match(
  routeSource,
  /buildFirstFramePlanPreview[\s\S]*?buildFirstFrameMaterialPanel/,
  'material panels route must reuse the same first-frame material panel builder as the editor plan route',
);

assert.match(
  routeSource,
  /function groupIndicesForProject[\s\S]*?project\.shots[\s\S]*?requestedGroupIdx/,
  'material panels route must support all shot groups and optional single group fetches',
);

assert.match(
  routeSource,
  /firstFrameMaterialPanel[\s\S]*?return jsonOk\(\{[\s\S]*?panels/,
  'material panels route must return lightweight panel entries',
);

assert.doesNotMatch(
  routeSource,
  /finalPrompt|referenceManifest|effectiveReferenceManifest|availableAssets|preflight/,
  'material panels route must not return full editor plan payload fields',
);

console.log('test-first-frame-material-panels-route passed');
