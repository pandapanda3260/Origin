/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createCanvas } = require('@napi-rs/canvas');

const root = process.cwd();

function compileTs(relPath) {
  const sourcePath = path.join(root, relPath);
  return {
    sourcePath,
    code: ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: sourcePath,
    }).outputText,
  };
}

function loadVideoGen() {
  const compiled = compileTs('lib/video-gen.ts');
  const moduleObj = { exports: {} };

  function localRequire(id) {
    if (id.startsWith('node:')) return require(id);
    if (id === '@napi-rs/canvas') return require(id);
    if (id === './llm') return { resolveLLMConfig: () => ({}) };
    if (id === './db') return { getDb: () => ({ prepare: () => ({ run() {}, get() {} }) }) };
    if (id === './ffmpeg') return { makeBlackVideo: async () => {}, extractCover: async () => {} };
    if (id === './image-gen') return { generateImage: async () => ({}) };
    if (id === './signed-asset-url') return { buildSignedVideoUrl: () => ({ url: '/video' }) };
    if (id === './projects-db') return { patchProjectForUser: () => null };
    if (id === './panel-selection') return {};
    if (id === './proxy-fetch') return { fetchViaProxy: async () => ({ ok: true, json: async () => ({}) }) };
    if (id === './video-prompt-runtime') {
      return {
        buildSeedancePromptParts: () => ({
          finalPrompt: '',
          independentReferenceImages: [],
          hasIndependentImageRefs: false,
          hasFirstFrameRef: false,
          hasColorRefs: false,
          hasAnyRef: false,
        }),
        buildSeedanceFirstLastFramePromptParts: () => ({ finalPrompt: '' }),
      };
    }
    if (id === './video-provider-capabilities') {
      return { resolveVideoModelCapability: () => ({ supportsReturnLastFrame: false }) };
    }
    if (id === './video-reference-manifest') {
      return { hashString: (s) => String(s).length.toString(16), resolveGenerationDurationSec: (opts) => opts.plannedDurationSec || 5 };
    }
    if (id === './video-prompt-state') return {};
    if (id === './frame-workflow-state') {
      return {
        maybeAssertStoryboardsAlignedWithShots: () => {},
        storyboardShotIndices: () => [0],
      };
    }
    if (id === './system-config') {
      return {
        getGlobalVideoConcurrencyLimit: () => 2,
        isVideoGenerationEnabled: () => true,
      };
    }
    if (id === './runtime-paths') {
      return { getDataDir: () => path.join(root, 'data') };
    }
    if (id === './provider-recovery') return {};
    return require(id);
  }

  vm.runInNewContext(
    compiled.code,
    { require: localRequire, module: moduleObj, exports: moduleObj.exports, console, process, Buffer, setTimeout, clearTimeout },
    { filename: compiled.sourcePath },
  );
  return moduleObj.exports;
}

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}

function makeNoisyPng(filePath) {
  const width = 1600;
  const height = 1200;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  let seed = 0x12345678;
  const nextByte = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed & 0xff;
  };
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = nextByte();
    image.data[i + 1] = nextByte();
    image.data[i + 2] = nextByte();
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
}

function makeSolidPng(filePath, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#123456';
  ctx.fillRect(0, 0, width, height);
  fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
}

async function run() {
  const prevMaxEdge = process.env.VIDEO_SUBMIT_IMAGE_MAX_EDGE;
  const prevQuality = process.env.VIDEO_SUBMIT_IMAGE_JPEG_QUALITY;
  process.env.VIDEO_SUBMIT_IMAGE_MAX_EDGE = '640';
  process.env.VIDEO_SUBMIT_IMAGE_JPEG_QUALITY = '82';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-video-submit-image-'));
  const sourcePath = path.join(tmpDir, 'large.png');
  try {
    makeNoisyPng(sourcePath);
    const originalBytes = fs.statSync(sourcePath).size;
    assert(originalBytes > 1_000_000, 'fixture image should be large enough');

    const mod = loadVideoGen();
    assert(mod.normalizeSeedanceResolution() === '720p', 'missing quality defaults to 720p');
    assert(mod.normalizeSeedanceResolution('1080p') === '1080p', '1080p is accepted');
    assert(mod.normalizeSeedanceResolution('720p') === '720p', '720p is accepted');
    let badResolutionRejected = false;
    try {
      mod.normalizeSeedanceResolution('4k');
    } catch (_) {
      badResolutionRejected = true;
    }
    assert(badResolutionRejected, 'unsupported resolution is rejected');

    const result = await mod.buildVideoSubmitImageDataUrl(sourcePath);
    assert(result.dataUrl.startsWith('data:image/jpeg;base64,'), 'data url is jpeg');
    assert(result.originalWidth === 1600 && result.originalHeight === 1200, 'records original dimensions');
    assert(result.width === 640 && result.height === 480, 'downscales to max edge');
    assert(result.originalBytes === originalBytes, 'records original bytes');
    assert(result.submittedBytes < result.originalBytes, 'submitted bytes are smaller than original');
    assert(result.submittedBytes / (result.width * result.height) >= 0.08, 'jpeg quality is not the near-zero quality path');
    mod.assertSeedanceSubmitImage(result, 'valid fixture');

    const narrowPath = path.join(tmpDir, 'too-narrow.png');
    makeSolidPng(narrowPath, 998, 3328);
    let narrowRejected = false;
    try {
      await mod.buildVideoSubmitImageDataUrl(narrowPath);
    } catch (err) {
      narrowRejected = /宽高比/.test(String(err && err.message || err));
    }
    assert(narrowRejected, '998x3328 image is rejected by aspect ratio validation');

    let tinyRejected = false;
    try {
      mod.assertSeedanceSubmitImage({
        dataUrl: 'data:image/jpeg;base64,',
        mime: 'image/jpeg',
        width: 1280,
        height: 853,
        originalWidth: 1280,
        originalHeight: 853,
        originalBytes: 12_000,
        submittedBytes: 12_000,
      }, 'near-zero jpeg');
    } catch (err) {
      tinyRejected = /过低|低质量/.test(String(err && err.message || err));
    }
    assert(tinyRejected, 'near-zero jpeg is rejected');

    let bodyRejected = false;
    try {
      mod.stringifySeedanceRequestBody({ content: 'x'.repeat(61 * 1024 * 1024) });
    } catch (err) {
      bodyRejected = /请求体校验失败/.test(String(err && err.message || err));
    }
    assert(bodyRejected, 'oversized serialized request body is rejected');

    const body = await mod.buildSeedanceFirstLastFrameBody({
      model: 'doubao-seedance-2-0-260128',
      prompt: 'test prompt',
      firstFramePath: sourcePath,
      lastFramePath: sourcePath,
      ratio: '16:9',
      durationSec: 5,
      resolution: '1080p',
    });
    assert(body.resolution === '1080p', 'first-last body uses requested 1080p resolution');
    assert(body.content[1].image_url.url.startsWith('data:image/jpeg;base64,'), 'first frame body image is compressed jpeg');
    assert(body.content[2].image_url.url.startsWith('data:image/jpeg;base64,'), 'last frame body image is compressed jpeg');
    assert(body.__submittedImages.first.width === 640, 'first frame audit metadata is attached');
    assert(body.__submittedImages.last.submittedBytes < body.__submittedImages.last.originalBytes, 'last frame metadata records compression');
    console.log('✓ video submit image compression');
  } finally {
    if (prevMaxEdge == null) delete process.env.VIDEO_SUBMIT_IMAGE_MAX_EDGE;
    else process.env.VIDEO_SUBMIT_IMAGE_MAX_EDGE = prevMaxEdge;
    if (prevQuality == null) delete process.env.VIDEO_SUBMIT_IMAGE_JPEG_QUALITY;
    else process.env.VIDEO_SUBMIT_IMAGE_JPEG_QUALITY = prevQuality;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
