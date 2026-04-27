import { NextRequest } from 'next/server';
import { listProjects, createProject } from '@/mocks/projects';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonOk({ items: listProjects(), total: listProjects().length });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const project = createProject(body);
  return jsonOk(project);
}
