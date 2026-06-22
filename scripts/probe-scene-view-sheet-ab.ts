import { resolveSlotModelConfig } from '../lib/model-routing';

type ProbeResult = {
  ok: boolean;
  realImageProvider: boolean;
  provider: string;
  model: string;
  multiRefCap: number;
  transport: string;
  multiRefEffective: boolean;
  requestedCanvas: { width: number; height: number };
  estimatedCell: { width: number; height: number };
  warnings: string[];
  nextStep: string;
};

function parseSize(size: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (!match) return { width: 1536, height: 1024 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

function resolveRequestedCanvas(): { width: number; height: number } {
  return parseSize(process.env.SCENE_VIEW_SHEET_PROBE_SIZE || '1536x1024');
}

function main() {
  const cfg = resolveSlotModelConfig(null, 'image');
  const cap = cfg.capabilities?.image;
  const multiRefCap = Math.max(0, Math.floor(Number(cap?.multiRefImage || 0)));
  const transport = cap?.transport || 'single_image';
  const requestedCanvas = resolveRequestedCanvas();
  const estimatedCell = {
    width: Math.floor(requestedCanvas.width / 2),
    height: Math.floor(requestedCanvas.height / 2),
  };
  const warnings: string[] = [];
  const realImageProvider = cfg.mode === 'real' && !!cfg.apiKey;
  const multiRefEffective = multiRefCap >= 2 && transport !== 'single_image';

  if (!realImageProvider) {
    warnings.push('image provider is not configured for real calls; real A/B generation cannot run in this environment');
  }
  if (!multiRefEffective) {
    warnings.push(`multi-reference repair would degrade: cap=${multiRefCap}, transport=${transport}`);
  }
  if (estimatedCell.width < 1024 || estimatedCell.height < 768) {
    warnings.push(
      `sheet cell is only ${estimatedCell.width}x${estimatedCell.height}; establishing crop may be weaker than the current full 1536x1024 scene reference`,
    );
  }

  const ok = realImageProvider && multiRefEffective && warnings.length === 0;
  const result: ProbeResult = {
    ok,
    realImageProvider,
    provider: cfg.provider,
    model: cfg.model,
    multiRefCap,
    transport,
    multiRefEffective,
    requestedCanvas,
    estimatedCell,
    warnings,
    nextStep: ok
      ? 'ready for real A/B probe with matched scene prompts before enabling sheet-first'
      : 'keep sheet-first disabled; fix provider capability/size or run A/B on the actual production-like image channel',
  };

  console.log(JSON.stringify(result, null, 2));
  if (process.env.SCENE_VIEW_SHEET_PROBE_REQUIRE_READY === '1' && !ok) process.exit(1);
}

main();
