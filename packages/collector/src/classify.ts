/**
 * Classification of stored videos with @vti/core (rule classifier + sponsorship detector).
 * OWNER: collector-pipeline.
 *
 * A video is (re)classified when it has no classification yet, when CLASSIFIER_VERSION or SPONSORSHIP_VERSION
 * changed, when its text inputs changed (title, description, tags, source category, language — tracked by
 * `videos.text_hash`) or when its account's seed category changed.
 */
import { CLASSIFIER_VERSION, SPONSORSHIP_VERSION, classifyVideo, detectSponsorship } from '@vti/core';
import type { CollectLogger } from './types.ts';
import type { Store, StoredVideo } from './store.ts';

export interface ClassifyStoredOptions {
  now?: number;
  /** Reclassify every video regardless of versions/hashes. */
  force?: boolean;
  log?: CollectLogger;
  /** Injected for tests; defaults to the core versions. */
  classifierVersion?: string;
  sponsorshipVersion?: string;
}

export interface ClassifyStoredResult {
  classified: number;
  failed: number;
  errors: string[];
  classifierVersion: string;
  sponsorshipVersion: string;
}

/** Classify one stored video (pure: no store access). */
export function classifyStoredVideo(
  v: Pick<StoredVideo, 'title' | 'description' | 'tags' | 'sourceCategory' | 'language'>,
  accountSeedCategory: string | null,
  account: { name?: string | null; handle?: string | null } = {},
) {
  const accountName = account.name ?? null;
  const accountHandle = account.handle ?? null;
  const { categories, topics } = classifyVideo({
    title: v.title,
    description: v.description,
    tags: v.tags,
    sourceCategory: v.sourceCategory,
    accountSeedCategory,
    language: v.language,
    accountName,
    accountHandle,
  });
  // The uploader's own name is neither a topic nor a sponsor.
  const sponsorship = detectSponsorship({ title: v.title, description: v.description, tags: v.tags, accountName, accountHandle });
  return { categories, topics, sponsorship };
}

export function classifyStoredVideos(store: Store, opts: ClassifyStoredOptions = {}): ClassifyStoredResult {
  const now = opts.now ?? Date.now();
  const classifierVersion = opts.classifierVersion ?? CLASSIFIER_VERSION;
  const sponsorshipVersion = opts.sponsorshipVersion ?? SPONSORSHIP_VERSION;
  // With `force`, passing impossible versions makes every video "stale".
  const pending = store.listVideosNeedingClassification(opts.force ? '(force)' : classifierVersion, opts.force ? '(force)' : sponsorshipVersion);
  const result: ClassifyStoredResult = { classified: 0, failed: 0, errors: [], classifierVersion, sponsorshipVersion };
  if (!pending.length) return result;

  store.transaction(() => {
    for (const v of pending) {
      try {
        const c = classifyStoredVideo(v, v.accountSeedCategory, { name: v.accountName, handle: v.accountHandle });
        store.setClassification(
          v.id,
          {
            categories: c.categories,
            topics: c.topics,
            sponsorship: c.sponsorship,
            classifierVersion,
            sponsorshipVersion,
            textHash: v.textHash,
            accountSeed: v.accountSeedCategory,
          },
          now,
        );
        result.classified++;
      } catch (err) {
        result.failed++;
        if (result.errors.length < 20) result.errors.push(`분류 실패 ${v.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  if (result.failed > result.errors.length) result.errors.push(`… 외 분류 실패 ${result.failed - result.errors.length}건`);
  opts.log?.info(`classify: ${result.classified} video(s) classified (${classifierVersion}, ${sponsorshipVersion})${result.failed ? `, ${result.failed} failed` : ''}`);
  return result;
}
