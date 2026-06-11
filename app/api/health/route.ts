import { jsonOk } from '@/lib/api-helpers';
import { getRuntimeHealth } from '@/lib/runtime-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const health = getRuntimeHealth();
  const exposeDetails = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.ORIGIN_HEALTH_EXPOSE_DETAILS || '').trim().toLowerCase(),
  );
  const body = exposeDetails
    ? health
    : {
        ok: health.ok,
        status: health.status,
        role: health.role,
        release: health.release,
        checks: health.checks.map((check) => ({
          name: check.name,
          status: check.status,
          message: check.message,
        })),
      };
  return jsonOk(body, { status: health.ok ? 200 : 503 });
}
