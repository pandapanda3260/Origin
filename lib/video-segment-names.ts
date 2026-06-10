type VideoSegmentNameInput = {
  taskId?: unknown;
  filename?: unknown;
  projectId?: unknown;
  projectTitle?: unknown;
  episodeIndex?: unknown;
  episodeTitle?: unknown;
  groupIdx?: unknown;
  copyIndex?: unknown;
};

export type VideoSegmentNamePayload = {
  displayName: string;
  filename: string;
  downloadFilename: string;
};

const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001F]/g;

function cleanText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawCleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanFilenamePart(value: unknown, fallback: string, maxLength: number): string {
  const cleaned = cleanText(value)
    .replace(INVALID_FILENAME_CHARS, '')
    .replace(/^\.+$/, '')
    .trim()
    .slice(0, maxLength)
    .trim();
  return cleaned || fallback;
}

function cleanStoredFilename(value: unknown, fallback: string, maxLength: number): string {
  const cleaned = rawCleanText(value)
    .replace(INVALID_FILENAME_CHARS, '')
    .replace(/^\.+$/, '')
    .trim()
    .slice(0, maxLength)
    .trim();
  return cleaned || fallback;
}

function normalizeIndex(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function normalizeGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= 0 ? rounded : null;
}

function stripMp4Ext(value: string): string {
  return value.replace(/\.mp4$/i, '');
}

function normalizeCopyIndex(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.round(n));
}

function looksLikeCurrentSegmentFilename(value: unknown): boolean {
  const raw = rawCleanText(value);
  return /^片段[0-9]+(?:(?:（[0-9]+）)|(?:\([0-9]+\)))?_第.+集_.+\.mp4$/u.test(raw);
}

export function buildVideoSegmentEpisodeLabel(input: Pick<VideoSegmentNameInput, 'episodeIndex' | 'episodeTitle'>): string {
  const title = cleanText(input.episodeTitle);
  const matched = title.match(/第\s*([0-9一二三四五六七八九十百千万]+)\s*集/);
  if (matched) return `第${matched[1]}集`;
  return `第${normalizeIndex(input.episodeIndex) + 1}集`;
}

export function videoSegmentNameInputFromProject(project: any, fallbackProjectId?: unknown) {
  const episodeIndex = normalizeIndex(project?.currentEpisodeIdx);
  const episodes = Array.isArray(project?.episodes) ? project.episodes : [];
  const episode = episodes[episodeIndex] || null;
  return {
    projectId: project?.id || fallbackProjectId,
    projectTitle: project?.title || project?.name,
    episodeIndex,
    episodeTitle: episode?.title,
  };
}

export function projectFromVideoSegmentDbRow(row: any) {
  let data: any = {};
  try {
    data = row?.project_data_json ? JSON.parse(String(row.project_data_json)) : {};
  } catch {
    data = {};
  }
  return {
    ...data,
    id: row?.project_id || row?.projectId,
    title: row?.project_title || row?.projectTitle || data?.title,
  };
}

export function buildVideoSegmentNames(input: VideoSegmentNameInput): VideoSegmentNamePayload {
  const taskId = cleanFilenamePart(input.taskId, '', 80);
  const groupIdx = normalizeGroupIdx(input.groupIdx);
  if (groupIdx != null && cleanText(input.projectId || input.projectTitle)) {
    const projectFallback = cleanFilenamePart(input.projectId, '未命名项目', 80);
    const projectName = cleanFilenamePart(input.projectTitle, projectFallback, 80);
    const episodeLabel = cleanFilenamePart(buildVideoSegmentEpisodeLabel(input), '第1集', 24);
    const copyIndex = normalizeCopyIndex(input.copyIndex);
    const copySuffix = copyIndex > 1 ? `（${copyIndex}）` : '';
    const displayName = [
      `片段${groupIdx + 1}${copySuffix}`,
      episodeLabel,
      projectName,
    ].join('_');
    const filename = `${displayName}.mp4`;
    return { displayName, filename, downloadFilename: filename };
  }

  const fallbackBase = taskId || stripMp4Ext(cleanFilenamePart(input.filename, 'video', 120));
  const filename = `${cleanFilenamePart(stripMp4Ext(cleanText(input.filename)) || fallbackBase, fallbackBase, 160)}.mp4`;
  return {
    displayName: stripMp4Ext(filename),
    filename,
    downloadFilename: filename,
  };
}

export function buildVideoSegmentNamesForRow(
  row: any,
  project?: any,
  options: { copyIndex?: unknown; preferStoredFilename?: boolean } = {},
): VideoSegmentNamePayload {
  if (options.preferStoredFilename !== false && looksLikeCurrentSegmentFilename(row?.filename)) {
    const filename = cleanStoredFilename(row.filename, 'video.mp4', 180);
    return {
      displayName: stripMp4Ext(filename),
      filename,
      downloadFilename: filename,
    };
  }
  const projectInput = videoSegmentNameInputFromProject(
    project || projectFromVideoSegmentDbRow(row),
    row?.project_id || row?.projectId,
  );
  return buildVideoSegmentNames({
    ...projectInput,
    taskId: row?.id || row?.taskId || row?.task_id,
    filename: row?.filename,
    groupIdx: row?.group_idx ?? row?.groupIdx,
    copyIndex: options.copyIndex,
  });
}

export function buildVideoSegmentContentDisposition(filename: string, disposition = 'inline'): string {
  const safeDisposition = disposition === 'attachment' ? 'attachment' : 'inline';
  const fallback = filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/[";\\]/g, '_')
    .replace(/^\.+$/, 'video.mp4')
    .slice(0, 160) || 'video.mp4';
  return `${safeDisposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
