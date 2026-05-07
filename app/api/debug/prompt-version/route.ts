import { NextRequest, NextResponse } from 'next/server';
import {
  PROMPT_MODULES,
  resolvePromptVersion,
  type PromptModuleId,
} from '@/lib/prompt-governance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isPromptModuleId(value: string): value is PromptModuleId {
  return Object.prototype.hasOwnProperty.call(PROMPT_MODULES, value);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const moduleId = url.searchParams.get('moduleId') || '';
  const userId = url.searchParams.get('userId');
  const projectId = url.searchParams.get('projectId');

  if (!moduleId) {
    return NextResponse.json({
      ok: true,
      modules: Object.keys(PROMPT_MODULES),
    });
  }

  if (!isPromptModuleId(moduleId)) {
    return NextResponse.json({
      ok: false,
      detail: `Unknown moduleId: ${moduleId}`,
      modules: Object.keys(PROMPT_MODULES),
    }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    resolution: resolvePromptVersion(moduleId, { userId, projectId }),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const moduleId = String(body.moduleId || '');
  if (!isPromptModuleId(moduleId)) {
    return NextResponse.json({
      ok: false,
      detail: `Unknown moduleId: ${moduleId}`,
      modules: Object.keys(PROMPT_MODULES),
    }, { status: 400 });
  }

  const env = body.env && typeof body.env === 'object'
    ? Object.fromEntries(
        Object.entries(body.env)
          .filter(([key, value]) => key.startsWith('PROMPT_VERSION_') && typeof value === 'string'),
      ) as NodeJS.ProcessEnv
    : process.env;

  return NextResponse.json({
    ok: true,
    resolution: resolvePromptVersion(moduleId, {
      userId: body.userId == null ? null : String(body.userId),
      projectId: body.projectId == null ? null : String(body.projectId),
    }, env),
  });
}
