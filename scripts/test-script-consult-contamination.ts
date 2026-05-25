import assert from 'node:assert/strict';
import {
  inspectScriptConsultContamination,
  scriptConsultMessageHash,
} from '../lib/script-consult-contamination';

function project(data: any, createdAt = '2026-05-21T00:00:00.000Z', updatedAt = '2026-05-21T00:00:30.000Z') {
  return {
    id: 'p1',
    title: 'P1',
    ownerId: 1,
    createdAt,
    updatedAt,
    data,
  };
}

const oldText = '旧内容'.repeat(120);
const duplicateHashes = new Set([scriptConsultMessageHash(oldText)]);

assert.equal(inspectScriptConsultContamination(project({
  script: '',
  assets: null,
  shots: [],
  storyboards: [],
  videoTasks: [],
  scriptConsult: { messages: [{ role: 'user', content: oldText }], outline: '', ready: false, startedAt: '2026-05-21T00:00:10.000Z' },
}), { duplicateHashes })?.reasons.includes('duplicate_first_message_hash'), true);

assert.equal(inspectScriptConsultContamination(project({
  script: '',
  assets: null,
  shots: [],
  storyboards: [],
  videoTasks: [],
  scriptConsult: { messages: [{ role: 'user', content: oldText }], outline: '', ready: false, startedAt: '2026-05-20T23:59:59.000Z' },
}), { duplicateHashes: new Set() })?.reasons.includes('started_before_created'), true);

assert.equal(inspectScriptConsultContamination(project({
  script: '',
  assets: null,
  shots: [],
  storyboards: [],
  videoTasks: [],
  scriptConsult: { messages: [{ role: 'user', content: oldText }], outline: '', ready: false, startedAt: '2026-05-21T00:00:20.000Z' },
}), { duplicateHashes: new Set(), quickWindowMs: 60_000, largeTextChars: 200 })?.reasons.includes('quick_large_consult_after_create'), true);

assert.equal(inspectScriptConsultContamination(project({
  script: '',
  assets: null,
  shots: [],
  storyboards: [],
  videoTasks: [],
  scriptConsult: { messages: [{ role: 'user', content: '短咨询' }], outline: '', ready: false, startedAt: '2026-05-21T00:10:00.000Z' },
}), { duplicateHashes: new Set() }), null, 'legal abandoned consult should not be strong-signal finding');

assert.equal(inspectScriptConsultContamination(project({
  script: 'has script',
  assets: null,
  shots: [],
  storyboards: [],
  videoTasks: [],
  scriptConsult: { messages: [{ role: 'user', content: oldText }], outline: '', ready: false, startedAt: '2026-05-20T23:59:59.000Z' },
}), { duplicateHashes }), null, 'projects with business content are not cleanup candidates');

assert.equal(inspectScriptConsultContamination(project({
  script: '',
  assets: [{ id: 'asset-1' }],
  shots: [],
  storyboards: [],
  videoTasks: [],
  scriptConsult: { messages: [{ role: 'user', content: oldText }], outline: '', ready: false, startedAt: '2026-05-20T23:59:59.000Z' },
}), { duplicateHashes }), null, 'projects with array assets are not cleanup candidates');

console.log('[test-script-consult-contamination] ok');
