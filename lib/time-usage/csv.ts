import type { TimeUsageDetailRow } from './types';

export function timeUsageCsvStream(rows: TimeUsageDetailRow[], meta: { generatedAt: string; timezone: string }) {
  const encoder = new TextEncoder();
  const header = [
    `# generated_at=${meta.generatedAt}`,
    `# timezone=${meta.timezone}`,
    '# time_fields=UTC ISO 8601',
    [
      'created_at',
      'started_at',
      'ended_at',
      'wait_ms',
      'status',
      'status_group',
      'owner_id',
      'username',
      'project_id',
      'project',
      'module_key',
      'module',
      'feature_key',
      'feature',
      'call_item_type',
      'call_item_id',
      'call_item_label',
      'source_table',
      'source_id',
      'provider',
      'error',
    ].join(','),
  ];

  let index = -header.length;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < 0) {
        controller.enqueue(encoder.encode(`${header[header.length + index]}\n`));
        index++;
        return;
      }
      if (index >= rows.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${rowToCsv(rows[index])}\n`));
      index++;
    },
  });
}

function rowToCsv(row: TimeUsageDetailRow) {
  return [
    row.createdAt,
    row.startedAt,
    row.endedAt || '',
    row.waitMs ?? '',
    row.status,
    row.statusGroup,
    row.ownerId ?? '',
    row.username || '',
    row.projectId || '',
    row.projectDisplay || '',
    row.moduleKey,
    row.moduleLabel,
    row.featureKey,
    row.featureLabel,
    row.callItemType,
    row.callItemId,
    row.callItemLabel || '',
    row.sourceTable,
    row.sourceId,
    row.provider || '',
    sanitizeCsvError(row.errorMessage),
  ].map(csvCell).join(',');
}

function sanitizeCsvError(value: unknown) {
  let text = String(value || '');
  if (!text) return '';
  text = text
    .replace(/("(?:prompt|input|messages|request|response|body)"\s*:\s*)("[^"]*"|\[[\s\S]*?\]|\{[\s\S]*?\})/gi, '$1"[redacted]"')
    .replace(/((?:prompt|input|messages|request|response|body)\s*[:=]\s*)(.{20,400})/gi, '$1[redacted]');
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
