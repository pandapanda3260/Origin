type ExportNameInput = {
  projectId?: unknown;
  projectTitle?: unknown;
  episodeIndex?: unknown;
  episodeTitle?: unknown;
};

const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001F]/g;

function cleanText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
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

function normalizeEpisodeIndex(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

export function buildEditExportEpisodeLabel(input: Pick<ExportNameInput, 'episodeIndex' | 'episodeTitle'>): string {
  const title = cleanText(input.episodeTitle);
  const matched = title.match(/第\s*([0-9０-９一二三四五六七八九十百千万]+)\s*集/);
  if (matched) return `第${matched[1]}集`;
  return `第${normalizeEpisodeIndex(input.episodeIndex) + 1}集`;
}

export function buildEditExportDownloadFilename(input: ExportNameInput): string {
  const projectName = cleanFilenamePart(
    input.projectTitle,
    cleanFilenamePart(input.projectId, '未命名项目', 80),
    80,
  );
  const episodeLabel = cleanFilenamePart(buildEditExportEpisodeLabel(input), '第1集', 24);
  return `${projectName}-${episodeLabel}.mp4`;
}

export function editExportNameInputFromProject(project: any, fallbackProjectId?: unknown): ExportNameInput {
  const episodeIndex = normalizeEpisodeIndex(project?.currentEpisodeIdx);
  const episodes = Array.isArray(project?.episodes) ? project.episodes : [];
  const episode = episodes[episodeIndex] || null;
  return {
    projectId: project?.id || fallbackProjectId,
    projectTitle: project?.title || project?.name,
    episodeIndex,
    episodeTitle: episode?.title,
  };
}

export function sanitizeEditExportDownloadFilename(value: unknown, fallback: string): string {
  const raw = cleanText(value);
  const withoutExt = raw.replace(/\.mp4$/i, '');
  const safe = cleanFilenamePart(withoutExt, fallback.replace(/\.mp4$/i, '') || '未命名项目-第1集', 120);
  return `${safe}.mp4`;
}

export function buildEditExportContentDisposition(filename: string, disposition = 'inline'): string {
  const safeDisposition = disposition === 'attachment' ? 'attachment' : 'inline';
  const fallback = filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/[";\\]/g, '_')
    .replace(/^\.+$/, 'export.mp4')
    .slice(0, 140) || 'export.mp4';
  return `${safeDisposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
