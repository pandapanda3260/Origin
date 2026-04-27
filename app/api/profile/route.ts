import { NextRequest } from 'next/server';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const PROFILE = {
  visualStyle: '',
  narrativeStyle: '',
  cameraStyle: '',
  moodStyle: '',
  promptHabits: '',
  rawDialog: [] as { role: string; content: string }[],
  updatedAt: null as string | null,
};

export async function GET() {
  return jsonOk(PROFILE);
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  Object.assign(PROFILE, body, { updatedAt: new Date().toISOString() });
  return jsonOk(PROFILE);
}
