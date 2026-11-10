import { fileURLToPath } from 'node:url';
import { Repository } from '../src/db/repository.ts';
import { fetchReelMetadata } from '../src/services/reelMetadataResolver.ts';
import type { ExtractedReelMetadata } from '../src/services/reelMetadataResolver.ts';
import { classifySavedMediaType, formatCanonicalInstagramUrl } from '../src/utils/mediaType.ts';

export interface LegacyPostRecoveryOptions {
  limit?: number;
  pageSize?: number;
  delayMs?: number;
  dryRun?: boolean;
  resolver?: (shortcode: string) => Promise<ExtractedReelMetadata>;
}

export interface LegacyPostRecoveryReport {
  scanned: number;
  recoveredPosts: number;
  confirmedReels: number;
  unresolved: number;
  updated: number;
}

/**
 * Resolves legacy `/reel/` rows whose underlying Instagram media is actually a `/p/` post
 * (saved through the pre-isolation DM intake path) and updates both `media_type` and canonical
 * `/p/` URL via `Repository`. Unresolved rows are left unchanged so reruns can retry safely.
 */
export async function recoverLegacyPosts(
  options?: LegacyPostRecoveryOptions
): Promise<LegacyPostRecoveryReport> {
  const maxItems = Math.max(1, Math.floor(options?.limit ?? 250));
  const pageSize = Math.min(Math.max(1, Math.floor(options?.pageSize ?? 50)), maxItems, 250);
  const delayMs = Math.max(0, Math.floor(options?.delayMs ?? 150));
  const dryRun = Boolean(options?.dryRun);
  const resolveMeta =
    options?.resolver ??
    ((shortcode: string) => fetchReelMetadata(shortcode, undefined, 'reel'));

  const report: LegacyPostRecoveryReport = {
    scanned: 0,
    recoveredPosts: 0,
    confirmedReels: 0,
    unresolved: 0,
    updated: 0,
  };

  let offset = 0;
  while (report.scanned < maxItems) {
    const batchLimit = Math.min(pageSize, maxItems - report.scanned);
    const candidates = await Repository.getLegacyReelUrlCandidates({ limit: batchLimit, offset });
    if (candidates.length === 0) {
      break;
    }

    let updatedInBatch = 0;

    for (const item of candidates) {
      if (report.scanned >= maxItems) break;
      report.scanned++;

      const meta = await resolveMeta(item.shortcode);
      const hasClassification =
        typeof meta.isClips === 'boolean' ||
        (typeof meta.mediaKind === 'string' && meta.mediaKind !== 'UNKNOWN');

      if (!hasClassification) {
        report.unresolved++;
      } else {
        const resolvedType = classifySavedMediaType({
          isClips: meta.isClips,
          mediaKind: meta.mediaKind,
        });

        if (resolvedType === 'post') {
          report.recoveredPosts++;
          const canonicalUrl = formatCanonicalInstagramUrl(item.shortcode, 'post');
          if (!dryRun) {
            const didUpdate = await Repository.repairRecoveredMediaClassification(
              item.id,
              'post',
              canonicalUrl
            );
            if (didUpdate) {
              report.updated++;
              updatedInBatch++;
            }
          }
        } else {
          report.confirmedReels++;
        }
      }

      if (delayMs > 0 && report.scanned < maxItems) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // Updated rows drop out of the `media_type = 'reel' AND reel_url LIKE '%/reel/%'` filter,
    // so only advance `offset` by rows that stayed in the candidate set.
    offset += Math.max(0, candidates.length - updatedInBatch);
    if (candidates.length < batchLimit) {
      break;
    }
  }

  return report;
}

/**
 * Parses CLI flags (`--limit`, `--dry-run`, `--delay-ms`) and runs the one-off legacy post recovery.
 */
async function main() {
  const args = process.argv.slice(2);
  let limit = 250;
  let delayMs = 200;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--limit' && args[i + 1]) {
      const parsed = Number(args[++i]);
      if (Number.isFinite(parsed) && parsed > 0) limit = Math.floor(parsed);
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.slice('--limit='.length));
      if (Number.isFinite(parsed) && parsed > 0) limit = Math.floor(parsed);
    } else if (arg === '--delay-ms' && args[i + 1]) {
      const parsed = Number(args[++i]);
      if (Number.isFinite(parsed) && parsed >= 0) delayMs = Math.floor(parsed);
    } else if (arg.startsWith('--delay-ms=')) {
      const parsed = Number(arg.slice('--delay-ms='.length));
      if (Number.isFinite(parsed) && parsed >= 0) delayMs = Math.floor(parsed);
    }
  }

  console.log(
    `[RecoverLegacyPosts] Starting legacy /reel/ classification scan (limit=${limit}, dryRun=${dryRun})...`
  );
  const summary = await recoverLegacyPosts({ limit, delayMs, dryRun });
  console.log('[RecoverLegacyPosts] Completed:', JSON.stringify(summary));
}

const isDirectEntry =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  main().catch((err) => {
    console.error('[RecoverLegacyPosts] Fatal error:', err);
    process.exit(1);
  });
}
