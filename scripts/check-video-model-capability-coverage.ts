import { listKnownVideoModelIds } from '../lib/model-routing';
import { listRegisteredVideoModelIds, resolveVideoModelCapability } from '../lib/video-provider-capabilities';

const STALE_VERIFICATION_DAYS = 180;

function verificationAgeDays(verifiedAt: string): number | null {
  const time = Date.parse(verifiedAt);
  if (!Number.isFinite(time)) return null;
  return Math.floor((Date.now() - time) / (24 * 60 * 60 * 1000));
}

const registered = new Set(listRegisteredVideoModelIds());
const required = new Set(listKnownVideoModelIds());
const missing = [...required].filter((model) => !registered.has(model)).sort();
const invalid = [...required].filter((model) => {
  const capability = resolveVideoModelCapability(model);
  return !capability.verifiedBy || !capability.bodyShape || !capability.verifiedAt;
});

if (missing.length || invalid.length) {
  if (missing.length) console.error(`Missing video capability entries: ${missing.join(', ')}`);
  if (invalid.length) console.error(`Invalid video capability entries: ${invalid.join(', ')}`);
  process.exit(1);
}

const stale = [...registered].filter((model) => {
  const age = verificationAgeDays(resolveVideoModelCapability(model).verifiedAt);
  return age != null && age > STALE_VERIFICATION_DAYS;
});

if (stale.length) {
  console.warn(
    `Stale video capability verification (> ${STALE_VERIFICATION_DAYS} days): ${stale.sort().join(', ')}`,
  );
}

console.log(`check-video-model-capability-coverage: ok (${required.size} required, ${registered.size} registered)`);
