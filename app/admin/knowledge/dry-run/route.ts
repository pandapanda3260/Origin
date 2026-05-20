import { NextRequest } from 'next/server';
import { renderKnowledgeAdminPage } from '@/lib/admin-knowledge-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderKnowledgeAdminPage(req, 'dry_run');
}
