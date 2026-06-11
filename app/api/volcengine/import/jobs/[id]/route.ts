import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk, noStoreHeaders } from '@/lib/api-helpers';
import {
  getVevDemoMaterialImportJob,
  serializeVevDemoMaterialImportJob,
} from '@/lib/vevdemo-material-import-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const user = await getCurrentUser(_req);
  if (!user) return jsonError('unauthorized', 401);

  const job = getVevDemoMaterialImportJob(ctx.params.id);
  if (!job || job.ownerId !== user.id) return jsonError('job_not_found', 404);

  return jsonOk(serializeVevDemoMaterialImportJob(job), {
    headers: noStoreHeaders,
  });
}
