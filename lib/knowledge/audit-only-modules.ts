export const AUDIT_ONLY_MODULES = new Set<string>(['provider_runtime']);

export function isAuditOnlyKnowledgeModule(module: unknown): boolean {
  return AUDIT_ONLY_MODULES.has(String(module || ''));
}
