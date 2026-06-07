import assert from 'node:assert/strict';
import { computeEditExportSignatureFromParts } from '../lib/edit-export-signature';

const format = { ratio: '9:16', size: '1080x1920', width: 1080, height: 1920 };
const baseItems = [
  { clipId: 'clip-a', groupIdx: 0, inSec: 0, outSec: 5, transitionInType: 'cut' },
  { clipId: 'clip-b', groupIdx: 1, inSec: 0.25, outSec: 4.75, transitionInType: 'fade' },
];

const base = computeEditExportSignatureFromParts({
  items: baseItems,
  bgmId: 'calm_seed.mp3',
  bgmEnabled: true,
  bgmOffsetTime: 0,
  exportFormat: format,
});

assert.match(base, /^edit-export-v1:[0-9a-f]{64}$/);

const autoBgm = computeEditExportSignatureFromParts({
  items: baseItems,
  bgmId: 'epic_seed.mp3',
  bgmEnabled: true,
  bgmOffsetTime: 0,
  exportFormat: format,
});

const noBgm = computeEditExportSignatureFromParts({
  items: baseItems,
  bgmId: null,
  bgmEnabled: true,
  bgmOffsetTime: 0,
  exportFormat: format,
});

assert.notEqual(
  noBgm,
  autoBgm,
  'auto-selected BGM must be part of the export signature',
);

assert.equal(
  computeEditExportSignatureFromParts({
    items: JSON.parse(JSON.stringify(baseItems)),
    bgmId: 'epic_seed.mp3',
    bgmEnabled: true,
    bgmOffsetTime: 0,
    exportFormat: { ...format },
  }),
  autoBgm,
  'resolved auto-BGM metadata should reproduce the export signature',
);

assert.equal(
  computeEditExportSignatureFromParts({
    items: JSON.parse(JSON.stringify(baseItems)),
    bgmId: 'calm_seed.mp3',
    bgmEnabled: true,
    bgmOffsetTime: 0,
    exportFormat: { ...format },
  }),
  base,
  'same export content should keep the same signature',
);

assert.notEqual(
  computeEditExportSignatureFromParts({
    items: [
      baseItems[0],
      { ...baseItems[1], outSec: 4.5 },
    ],
    bgmId: 'calm_seed.mp3',
    bgmEnabled: true,
    bgmOffsetTime: 0,
    exportFormat: format,
  }),
  base,
  'trim changes should invalidate the signature',
);

assert.notEqual(
  computeEditExportSignatureFromParts({
    items: baseItems,
    bgmId: 'calm_seed.mp3',
    bgmEnabled: true,
    bgmOffsetTime: 1.5,
    exportFormat: format,
  }),
  base,
  'BGM offset changes should invalidate the signature',
);

assert.notEqual(
  computeEditExportSignatureFromParts({
    items: baseItems,
    bgmId: 'calm_seed.mp3',
    bgmEnabled: false,
    bgmOffsetTime: 0,
    exportFormat: format,
  }),
  base,
  'BGM off should differ from BGM on',
);

const explicitOff = computeEditExportSignatureFromParts({
  items: baseItems,
  bgmId: 'calm_seed.mp3',
  bgmEnabled: false,
  bgmOffsetTime: 1.5,
  exportFormat: format,
});

const defaultOff = computeEditExportSignatureFromParts({
  items: baseItems,
  bgmId: 'calm_seed.mp3',
  exportFormat: format,
});

const noBgmOff = computeEditExportSignatureFromParts({
  items: baseItems,
  bgmId: null,
  bgmEnabled: false,
  bgmOffsetTime: 0,
  exportFormat: format,
});

assert.equal(
  defaultOff,
  explicitOff,
  'BGM must default to off even when a trackId is present',
);

assert.equal(
  explicitOff,
  noBgmOff,
  'disabled BGM should be signed the same as no BGM',
);

console.log('edit export signature tests passed');
