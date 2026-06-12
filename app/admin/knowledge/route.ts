import { NextRequest } from 'next/server';
import { renderKnowledgeAdminPage } from '@/lib/admin-knowledge-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 知识库单页三 tab（知识卡 / 审计 / 注入预演）。原 /admin/knowledge/{audits,dry-run} 子路由已删除，
// 通过 ?tab=audits|dry_run 直达对应 tab。
export async function GET(req: NextRequest) {
  const tab = new URL(req.url).searchParams.get('tab');
  const initialTab = tab === 'audits' ? 'audits' : tab === 'dry_run' ? 'dry_run' : 'cards';
  return renderKnowledgeAdminPage(req, initialTab);
}
