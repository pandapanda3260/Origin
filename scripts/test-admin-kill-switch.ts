import { NextRequest } from 'next/server';
import { POST as registerPost } from '../app/api/auth/register/verify/route';
import { POST as videoSubmitPost } from '../app/api/video/submit/route';
import { POST as editExportPost } from '../app/api/edit/export/route';
import { startEditExport } from '../lib/edit-export';
import { generateVideo } from '../lib/video-gen';
import { readSystemConfig, writeSystemConfig } from '../lib/system-config';

const KEYS = ['registration_enabled', 'video_generation_enabled', 'export_enabled'] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function req(path: string, body: unknown = {}) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify(body),
  });
}

async function expectRejects503(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error: any) {
    assert(Number(error?.status) === 503, `${label} should throw status=503, got ${error?.status || error?.message}`);
    return;
  }
  throw new Error(`${label} should throw status=503`);
}

async function main() {
  const originals = new Map(KEYS.map((key) => [key, readSystemConfig<boolean>(key, true)]));
  try {
    for (const key of KEYS) writeSystemConfig(key, false);

    const register = await registerPost(req('/api/auth/register/verify'));
    assert(register.status === 503, `registration switch should return 503, got ${register.status}`);

    const video = await videoSubmitPost(req('/api/video/submit'));
    assert(video.status === 503, `video switch should return 503 before auth, got ${video.status}`);

    const editExport = await editExportPost(req('/api/edit/export'));
    assert(editExport.status === 503, `export switch should return 503 before auth, got ${editExport.status}`);

    await expectRejects503('generateVideo library gate', () => generateVideo({ id: 1 } as any, { prompt: 'smoke' }));
    await expectRejects503('startEditExport library gate', () => startEditExport({} as any));
  } finally {
    for (const key of KEYS) writeSystemConfig(key, originals.get(key));
  }

  console.log('admin kill-switch smoke ok: registration, video generation, and export gates return 503 when disabled');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
