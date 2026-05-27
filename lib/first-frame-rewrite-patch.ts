import { z } from 'zod';
import { parseJsonLoose } from './llm';
import type { FirstFrameDraftWarning } from './first-frame-edit-draft';

const ReferenceSelectorSchema = z.object({
  role: z.enum(['character', 'scene', 'prop']),
  assetId: z.string().trim().min(1).optional(),
  assetName: z.string().trim().min(1).optional(),
}).strict();

const ReferenceAddPatchSchema = z.object({
  role: z.enum(['character', 'scene', 'prop']),
  assetId: z.string().trim().min(1).optional(),
  assetName: z.string().trim().min(1).optional(),
}).strict();

const PromptPatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('keep') }).strict(),
  z.object({ op: z.literal('set'), value: z.string() }).strict(),
  z.object({ op: z.literal('clear') }).strict(),
]);

const NegativePromptPatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('keep') }).strict(),
  z.object({ op: z.literal('set'), value: z.union([z.string(), z.array(z.string())]) }).strict(),
  z.object({ op: z.literal('append'), value: z.array(z.string()) }).strict(),
  z.object({ op: z.literal('remove'), value: z.array(z.string()) }).strict(),
  z.object({ op: z.literal('clear') }).strict(),
]);

const ReferencePatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('keep') }).strict(),
  z.object({
    op: z.literal('update'),
    add: z.array(ReferenceAddPatchSchema).optional(),
    exclude: z.array(ReferenceSelectorSchema).optional(),
    removeAdded: z.array(ReferenceSelectorSchema).optional(),
  }).strict(),
  z.object({ op: z.literal('clear') }).strict(),
]);

export const RewriteDraftOperationsSchema = z.object({
  content: PromptPatchSchema.optional(),
  negativePromptOverride: NegativePromptPatchSchema.optional(),
  referenceOverrides: ReferencePatchSchema.optional(),
}).strict();

export const RewriteDraftResultSchema = z.object({
  assistantMessage: z.string().optional().nullable(),
  intentSummary: z.string().optional().nullable(),
  draftPatch: RewriteDraftOperationsSchema.optional().nullable(),
}).strict();

export type FirstFrameRewriteOperations = z.infer<typeof RewriteDraftOperationsSchema>;
export type FirstFrameRewriteResult = z.infer<typeof RewriteDraftResultSchema> & {
  parserWarnings?: FirstFrameDraftWarning[];
};

function warning(code: string, message: string): FirstFrameDraftWarning {
  return { code, message, severity: 'warn', scope: 'global' };
}

function removeForbiddenPatchKeys(value: any): FirstFrameDraftWarning[] {
  const warnings: FirstFrameDraftWarning[] = [];
  const forbidden = ['styleRuleOverrides', 'quality', 'size', 'model', 'provider', 'style', 'sourceHash', 'updatedAt', 'updatedBy'];
  if (!value || typeof value !== 'object') return warnings;
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      delete value[key];
      warnings.push(warning(
        key === 'styleRuleOverrides' ? 'style_rules_ignored' : 'forbidden_field_ignored',
        key === 'styleRuleOverrides'
          ? '风格规则不能通过首帧对话修改，已忽略该项。'
          : `${key} 不能通过首帧对话修改，已忽略该项。`,
      ));
    }
  }
  return warnings;
}

function legacyDraftPatchToOperations(input: any) {
  const source = input && typeof input === 'object' ? input : {};
  const operations: Record<string, any> = {};
  const hasContent = Object.prototype.hasOwnProperty.call(source, 'content');
  if (hasContent || Object.prototype.hasOwnProperty.call(source, 'promptOverride')) {
    const promptSource = hasContent ? source.content : source.promptOverride;
    operations.content = promptSource == null
      ? { op: 'clear' }
      : { op: 'set', value: String(promptSource || '') };
  }
  if (Object.prototype.hasOwnProperty.call(source, 'negativePromptOverride')) {
    operations.negativePromptOverride = source.negativePromptOverride == null
      ? { op: 'clear' }
      : { op: 'set', value: String(source.negativePromptOverride || '') };
  }
  if (Object.prototype.hasOwnProperty.call(source, 'referenceOverrides')) {
    if (source.referenceOverrides == null) {
      operations.referenceOverrides = { op: 'clear' };
    } else {
      const refs = source.referenceOverrides || {};
      operations.referenceOverrides = {
        op: 'update',
        ...(Array.isArray(refs.added) ? { add: refs.added } : {}),
        ...(Array.isArray(refs.excluded) ? { exclude: refs.excluded.map((item: any) => ({
          role: item?.role === 'scene' || item?.role === 'prop' ? item.role : 'character',
          ...(item?.assetId ? { assetId: String(item.assetId) } : {}),
          ...(item?.assetName ? { assetName: String(item.assetName) } : {}),
        })) } : {}),
      };
    }
  }
  return operations;
}

export function normalizeFirstFrameRewriteOperations(input: any) {
  const source = input && typeof input === 'object' ? { ...input } : {};
  const out: Record<string, any> = {};

  const prompt = Object.prototype.hasOwnProperty.call(source, 'content') ? source.content : source.promptOverride;
  if (prompt && typeof prompt === 'object' && prompt.op) {
    out.content = prompt.op === 'set' && Array.isArray(prompt.value)
      ? { op: 'set', value: prompt.value.join(' ') }
      : prompt;
  } else if (typeof prompt === 'string') {
    out.content = { op: 'set', value: prompt };
  } else if (prompt === null) {
    out.content = { op: 'clear' };
  }

  const negative = source.negativePromptOverride;
  if (negative && typeof negative === 'object' && negative.op) {
    out.negativePromptOverride = {
      ...negative,
      op: negative.op === 'add' ? 'append' : negative.op,
    };
  } else if (typeof negative === 'string' || Array.isArray(negative)) {
    out.negativePromptOverride = { op: 'set', value: negative };
  } else if (negative === null) {
    out.negativePromptOverride = { op: 'clear' };
  }

  const refs = source.referenceOverrides;
  if (refs && typeof refs === 'object' && refs.op) {
    if (refs.op === 'update') {
      const add = refs.add || refs.added;
      const exclude = refs.exclude || refs.excluded;
      const removeAdded = refs.removeAdded;
      out.referenceOverrides = {
        op: 'update',
        ...(add ? { add } : {}),
        ...(exclude ? { exclude } : {}),
        ...(removeAdded ? { removeAdded } : {}),
      };
    } else {
      out.referenceOverrides = { op: refs.op };
    }
  } else if (refs && typeof refs === 'object') {
    const add = refs.add || refs.added;
    const exclude = refs.exclude || refs.excluded;
    const removeAdded = refs.removeAdded;
    out.referenceOverrides = {
      op: 'update',
      ...(add ? { add } : {}),
      ...(exclude ? { exclude } : {}),
      ...(removeAdded ? { removeAdded } : {}),
    };
  } else if (refs === null) {
    out.referenceOverrides = { op: 'clear' };
  }

  return out;
}

export function parseFirstFrameRewriteResult(raw: string): FirstFrameRewriteResult {
  const parsed = parseJsonLoose(raw) as any;
  const hasModernPatch = !!(parsed?.draftPatch || parsed?.operations);
  const legacyWarnings = !hasModernPatch && parsed?.nextDraft && typeof parsed.nextDraft === 'object'
    ? removeForbiddenPatchKeys(parsed.nextDraft)
    : [];
  const rawPatch = parsed?.draftPatch || parsed?.operations || legacyDraftPatchToOperations(parsed?.nextDraft);
  const parserWarnings = legacyWarnings.concat(removeForbiddenPatchKeys(rawPatch));
  const patch = normalizeFirstFrameRewriteOperations(rawPatch);
  return {
    ...RewriteDraftResultSchema.parse({
      assistantMessage: parsed?.assistantMessage,
      intentSummary: parsed?.intentSummary,
      draftPatch: patch,
    }),
    parserWarnings,
  };
}
