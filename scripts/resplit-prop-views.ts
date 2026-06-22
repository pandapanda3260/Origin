import { getDb, type UserRow } from '../lib/db';
import { getProjectByIdForUser, patchProjectForUser } from '../lib/projects-db';
import {
  applyPropViewWrite,
  splitPropViews,
  type SplitPropViewsResult,
  type PropViewsMeta,
} from '../lib/prop-views';

type CliArgs = {
  projectId: string;
  idx: number | null;
  apply: boolean;
  help: boolean;
};

type Candidate = {
  projectId: string;
  ownerId: number;
  idx: number;
  name: string;
  sourceImageUrl: string;
  version: number;
  prop: any;
};

function usage(): string {
  return [
    'Usage:',
    '  npx tsx scripts/resplit-prop-views.ts --projectId=<id> [--idx=<propIndex>] [--apply]',
    '',
    'Default mode only finds candidates and does not split or write qd.sqlite.',
    'Use --apply to split the saved sheet and write refreshed prop views.',
  ].join('\n');
}

function argValue(argv: string[], name: string): string {
  const prefix = `${name}=`;
  const direct = argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1] || '';
  return '';
}

function parseArgs(argv: string[]): CliArgs {
  const help = argv.includes('--help') || argv.includes('-h');
  const projectId = argValue(argv, '--projectId') || argValue(argv, '--project-id');
  const rawIdx = argValue(argv, '--idx') || argValue(argv, '--propIdx') || argValue(argv, '--prop-idx');
  const idx = rawIdx === '' ? null : Number(rawIdx);
  if (!help && !projectId) throw new Error('missing --projectId');
  if (idx !== null && (!Number.isInteger(idx) || idx < 0)) throw new Error('invalid --idx');
  return {
    projectId,
    idx,
    apply: argv.includes('--apply'),
    help,
  };
}

function projectOwnerId(projectId: string): number {
  const db = getDb();
  const row = db
    .prepare<{ id: string }, { owner_id: number }>('SELECT owner_id FROM projects WHERE id = @id')
    .get({ id: projectId });
  if (!row) throw new Error(`project not found: ${projectId}`);
  return Number(row.owner_id);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function sourceUrlForProp(prop: any): string {
  return firstText(
    prop?.views?.sourceImageUrl,
    prop?.views?.sheetUrl,
    prop?.views?.sourceUrl,
    prop?.sourceImageUrl,
    prop?.sheetUrl,
  );
}

function nextVersion(prop: any): number {
  const raw = Number(prop?.viewsVersion || prop?.views?.version || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) + 1 : 1;
}

function mergePropForCandidate(assetProp: any, topProp: any): any {
  return {
    ...(topProp || {}),
    ...(assetProp || {}),
    views: {
      ...((topProp && topProp.views) || {}),
      ...((assetProp && assetProp.views) || {}),
    },
  };
}

function collectCandidates(project: any, ownerId: number, idx: number | null): Candidate[] {
  const assetProps = Array.isArray(project?.assets?.props) ? project.assets.props : [];
  const topProps = Array.isArray(project?.props) ? project.props : [];
  const max = Math.max(assetProps.length, topProps.length);
  const indices = idx === null ? Array.from({ length: max }, (_, i) => i) : [idx];
  const candidates: Candidate[] = [];
  for (const propIdx of indices) {
    const prop = mergePropForCandidate(assetProps[propIdx], topProps[propIdx]);
    if (!prop || Object.keys(prop).length === 0) continue;
    const sourceImageUrl = sourceUrlForProp(prop);
    const hasFailure = !!firstText(prop.viewsError, prop.imageLastError, prop.viewsErrorAt, prop.imageFailedAt);
    if (idx === null && !hasFailure) continue;
    candidates.push({
      projectId: project.id,
      ownerId,
      idx: propIdx,
      name: firstText(prop.name, prop.propType, `prop ${propIdx}`),
      sourceImageUrl,
      version: nextVersion(prop),
      prop,
    });
  }
  return candidates;
}

function summarizeViews(views: PropViewsMeta | undefined) {
  const slots = views?.slots && typeof views.slots === 'object' ? views.slots : {};
  const qualities = views?.quality?.slots && typeof views.quality.slots === 'object' ? views.quality.slots : {};
  const roles = ['hero', 'front', 'back', 'side_left', 'side_right', 'top'];
  return roles.map((slot) => {
    const view = (slots as any)[slot];
    const quality = (qualities as any)[slot];
    return {
      slot,
      url: firstText(view?.imageUrl, view?.rawUrl),
      status: firstText(quality?.status),
      reason: firstText(quality?.reason),
      warnings: Array.isArray(quality?.warnings) ? quality.warnings : [],
    };
  });
}

function buildWriteArgs(candidate: Candidate, splitResult: SplitPropViewsResult) {
  return {
    splitResult,
    sourceImageUrl: candidate.sourceImageUrl,
    imagePrompt: candidate.prop?.imagePrompt,
    submittedImagePrompt: candidate.prop?.submittedImagePrompt,
    referenceStatus: candidate.prop?.reference?.status || 'ready',
    generatedAt: new Date().toISOString(),
    imageSafetyAudit: candidate.prop?.imageSafetyAudit,
    effectiveVisualDescription: candidate.prop?.effectiveVisualDescription,
    styleBibleSignature: candidate.prop?.reference?.styleBibleSignature,
    styleLockVersion: candidate.prop?.reference?.styleLockVersion,
    resolvedBackdropColor: candidate.prop?.reference?.resolvedBackdropColor,
  };
}

async function applyCandidate(candidate: Candidate) {
  const user = { id: candidate.ownerId } as UserRow;
  const splitResult = await splitPropViews({
    user,
    projectId: candidate.projectId,
    assetRef: `props[${candidate.idx}]`,
    sourceImageUrl: candidate.sourceImageUrl,
    prompt: candidate.prop?.imagePrompt,
    version: candidate.version,
  });

  if (!splitResult.ok) {
    return {
      ok: false,
      idx: candidate.idx,
      name: candidate.name,
      error: splitResult.error,
      views: summarizeViews(splitResult.views),
    };
  }

  const writeArgs = buildWriteArgs(candidate, splitResult);
  const updated = patchProjectForUser(candidate.projectId, candidate.ownerId, (current) => {
    const nextAssets = {
      ...(current.assets || {}),
      props: Array.isArray(current.assets?.props) ? [...current.assets.props] : [],
    };
    const nextTopProps = Array.isArray(current.props) ? [...current.props] : [];
    nextAssets.props[candidate.idx] = applyPropViewWrite(nextAssets.props[candidate.idx], writeArgs);
    nextTopProps[candidate.idx] = applyPropViewWrite(nextTopProps[candidate.idx], writeArgs);
    return {
      assets: nextAssets,
      props: nextTopProps,
    };
  });

  return {
    ok: !!updated,
    idx: candidate.idx,
    name: candidate.name,
    viewImageIds: splitResult.viewImageIds,
    views: summarizeViews(splitResult.views),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const ownerId = projectOwnerId(args.projectId);
  const project = getProjectByIdForUser(args.projectId, ownerId);
  if (!project) throw new Error(`project not readable: ${args.projectId}`);
  const candidates = collectCandidates(project, ownerId, args.idx);
  const missingSource = candidates.filter((candidate) => !candidate.sourceImageUrl);
  const readyCandidates = candidates.filter((candidate) => candidate.sourceImageUrl);

  if (!args.apply) {
    console.log(JSON.stringify({
      apply: false,
      projectId: args.projectId,
      ownerId,
      candidates: candidates.map((candidate) => ({
        idx: candidate.idx,
        name: candidate.name,
        hasSourceImageUrl: !!candidate.sourceImageUrl,
        sourceImageUrl: candidate.sourceImageUrl,
        nextVersion: candidate.version,
      })),
      missingSource: missingSource.map((candidate) => ({ idx: candidate.idx, name: candidate.name })),
    }, null, 2));
    return;
  }

  const results = [];
  for (const candidate of readyCandidates) {
    results.push(await applyCandidate(candidate));
  }
  console.log(JSON.stringify({
    apply: true,
    projectId: args.projectId,
    ownerId,
    skippedMissingSource: missingSource.map((candidate) => ({ idx: candidate.idx, name: candidate.name })),
    results,
  }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
