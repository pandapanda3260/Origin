import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({ ok: true, mediaId: 'mock-media-' + Date.now(), url: '/showcase-asset-1.jpg' });
}
