/**
 * Seed file loading + validation (packages/collector/seeds/*.json). OWNER: collector-pipeline.
 *
 * - A missing file is an empty list (seed files are optional).
 * - A file that is not valid JSON or not an array is reported and treated as empty (strict mode throws).
 * - Entries with a wrong shape are dropped and reported; valid entries keep any extra fields so adapters can
 *   start using new optional fields without a loader change.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, taxonomyById } from '@vti/core';
import type {
  CreatorSeed,
  DailymotionQuerySeed,
  KeywordSeed,
  NiconicoQuerySeed,
  PeertubeQuerySeed,
  Seeds,
  YoutubeChannelSeed,
} from './types.ts';

export const DEFAULT_SEEDS_DIR = fileURLToPath(new URL('../seeds/', import.meta.url));

export const SEED_FILES = {
  youtubeChannels: 'youtube-channels.json',
  keywords: 'keywords.json',
  dailymotion: 'dailymotion.json',
  niconico: 'niconico.json',
  peertube: 'peertube.json',
  creators: 'creators.json',
} as const satisfies Record<keyof Seeds, string>;

export function emptySeeds(): Seeds {
  return { youtubeChannels: [], keywords: [], dailymotion: [], niconico: [], peertube: [], creators: [] };
}

export interface SeedLoadResult {
  seeds: Seeds;
  /** Human-readable problems (file-level and entry-level). */
  warnings: string[];
  /** Files that did not exist (treated as empty). */
  missing: string[];
}

export interface LoadSeedsOptions {
  /** Throw on unreadable files or invalid entries instead of skipping them. */
  strict?: boolean;
  /** Receives each warning (in addition to the returned list). */
  log?: { warn(msg: string): void };
}

/* ------------------------------------------------------------------ primitive checks */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isOptStrOrNull = (v: unknown) => v === undefined || isStrOrNull(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export const YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const ACCOUNT_ID_RE = new RegExp(`^(${PLATFORMS.join('|')}):.+$`);

const DM_SORTS = new Set(['visited-today', 'visited-week', 'visited-month', 'trending', 'recent', 'relevance']);
const NN_TARGETS = new Set(['tagsExact', 'title,description,tags']);
const NN_SORTS = new Set(['-viewCounter', '-startTime', '-likeCounter', '-commentCounter']);
const PT_SORTS = new Set(['-publishedAt', '-views', '-likes', '-match']);


/** Returns an error string, or null when the entry is valid. */
function checkYoutubeChannel(e: Obj): string | null {
  if (!isStr(e.channelId) || !YOUTUBE_CHANNEL_ID_RE.test(e.channelId)) return 'channelId must be a UC… channel id';
  if (!isOptStrOrNull(e.handle)) return 'handle must be a string or null';
  if (!isStr(e.name)) return 'name must be a non-empty string';
  if (!isStr(e.category)) return 'category must be a taxonomy id';
  if (!isOptStrOrNull(e.country)) return 'country must be a string or null';
  if (!isOptStrOrNull(e.language)) return 'language must be a string or null';
  if (!isOptStrOrNull(e.creatorId)) return 'creatorId must be a string or null';
  return null;
}

function checkKeyword(e: Obj): string | null {
  if (!isStr(e.keyword)) return 'keyword must be a non-empty string';
  if (!isStr(e.category)) return 'category must be a taxonomy id';
  if (!isStr(e.language)) return 'language must be a string';
  return null;
}

function checkDailymotion(e: Obj): string | null {
  if (!isStrOrNull(e.channel)) return 'channel must be a string or null';
  if (!isStrOrNull(e.country)) return 'country must be a string or null';
  if (!isStrOrNull(e.language)) return 'language must be a string or null';
  if (typeof e.sort !== 'string' || !DM_SORTS.has(e.sort)) return `sort must be one of ${[...DM_SORTS].join(', ')}`;
  if (!isStrOrNull(e.search)) return 'search must be a string or null';
  if (!isPosInt(e.limit)) return 'limit must be a positive integer';
  return null;
}

function checkNiconico(e: Obj): string | null {
  if (!isStr(e.q)) return 'q must be a non-empty string';
  if (typeof e.targets !== 'string' || !NN_TARGETS.has(e.targets)) return `targets must be one of ${[...NN_TARGETS].join(' | ')}`;
  if (!isStr(e.category)) return 'category must be a taxonomy id';
  if (typeof e.sort !== 'string' || !NN_SORTS.has(e.sort)) return `sort must be one of ${[...NN_SORTS].join(', ')}`;
  if (!(e.sinceDays === null || isPosInt(e.sinceDays))) return 'sinceDays must be a positive integer or null';
  if (!isPosInt(e.limit)) return 'limit must be a positive integer';
  return null;
}

function checkPeertube(e: Obj): string | null {
  if (!isStrOrNull(e.search)) return 'search must be a string or null';
  if (!(e.languageOneOf === null || (Array.isArray(e.languageOneOf) && e.languageOneOf.every(isStr)))) {
    return 'languageOneOf must be a string array or null';
  }
  if (typeof e.sort !== 'string' || !PT_SORTS.has(e.sort)) return `sort must be one of ${[...PT_SORTS].join(', ')}`;
  if (!isPosInt(e.limit)) return 'limit must be a positive integer';
  return null;
}

function checkCreator(e: Obj): string | null {
  if (!isStr(e.id)) return 'id must be a non-empty string';
  if (!isStr(e.name)) return 'name must be a non-empty string';
  if (!Array.isArray(e.accountIds) || e.accountIds.length === 0) return 'accountIds must be a non-empty array';
  for (const a of e.accountIds) if (typeof a !== 'string' || !ACCOUNT_ID_RE.test(a)) return `invalid account id ${JSON.stringify(a)} (expected "<platform>:<id>")`;
  if (!isOptStrOrNull(e.note)) return 'note must be a string or null';
  return null;
}

/* ------------------------------------------------------------------ loading */

function readArray(path: string, file: string, res: SeedLoadResult, warn: (m: string) => void, strict: boolean): unknown[] {
  if (!existsSync(path)) {
    res.missing.push(file);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    const msg = `seeds/${file}: invalid JSON (${err instanceof Error ? err.message : String(err)}); treated as empty`;
    if (strict) throw new Error(msg);
    warn(msg);
    return [];
  }
  if (!Array.isArray(parsed)) {
    const msg = `seeds/${file}: expected a JSON array; treated as empty`;
    if (strict) throw new Error(msg);
    warn(msg);
    return [];
  }
  return parsed;
}

function validateList<T>(
  items: unknown[],
  file: string,
  check: (e: Obj) => string | null,
  warn: (m: string) => void,
  strict: boolean,
  normalize: (e: Obj) => T = (e) => e as T,
): T[] {
  const out: T[] = [];
  items.forEach((raw, i) => {
    const err = isObj(raw) ? check(raw) : 'entry must be an object';
    if (err) {
      const msg = `seeds/${file}[${i}]: ${err}; entry skipped`;
      if (strict) throw new Error(msg);
      warn(msg);
      return;
    }
    out.push(normalize(raw as Obj));
  });
  return out;
}

/** Load and validate all seed files; never throws unless `strict`. */
export function loadSeedsDetailed(dir: string = DEFAULT_SEEDS_DIR, opts: LoadSeedsOptions = {}): SeedLoadResult {
  const strict = opts.strict ?? false;
  const res: SeedLoadResult = { seeds: emptySeeds(), warnings: [], missing: [] };
  const warn = (m: string) => {
    res.warnings.push(m);
    opts.log?.warn(m);
  };
  const read = (key: keyof Seeds) => readArray(join(dir, SEED_FILES[key]), SEED_FILES[key], res, warn, strict);

  const known = taxonomyById();
  const checkCategory = (file: string) => (e: Obj, i: number) => {
    const cat = String(e.category ?? '').trim();
    if (cat && !known.has(cat)) warn(`seeds/${file}[${i}]: category "${cat}" is not a taxonomy id (kept; classifier ignores it)`);
  };

  // youtube-channels: validate, then de-duplicate by channelId (first wins).
  const channels = validateList<YoutubeChannelSeed>(read('youtubeChannels'), SEED_FILES.youtubeChannels, checkYoutubeChannel, warn, strict, (e) => ({
    ...(e as unknown as YoutubeChannelSeed),
    handle: (e.handle as string | null | undefined) ?? null,
    country: (e.country as string | null | undefined) ?? null,
    language: (e.language as string | null | undefined) ?? null,
  }));
  const seenChannels = new Set<string>();
  channels.forEach((c, i) => {
    checkCategory(SEED_FILES.youtubeChannels)(c as unknown as Obj, i);
    if (seenChannels.has(c.channelId)) {
      warn(`seeds/${SEED_FILES.youtubeChannels}: duplicate channelId ${c.channelId}; later entry ignored`);
      return;
    }
    seenChannels.add(c.channelId);
    res.seeds.youtubeChannels.push(c);
  });

  res.seeds.keywords = validateList<KeywordSeed>(read('keywords'), SEED_FILES.keywords, checkKeyword, warn, strict);
  res.seeds.keywords.forEach((k, i) => checkCategory(SEED_FILES.keywords)(k as unknown as Obj, i));
  res.seeds.dailymotion = validateList<DailymotionQuerySeed>(read('dailymotion'), SEED_FILES.dailymotion, checkDailymotion, warn, strict);
  res.seeds.niconico = validateList<NiconicoQuerySeed>(read('niconico'), SEED_FILES.niconico, checkNiconico, warn, strict);
  res.seeds.niconico.forEach((n, i) => checkCategory(SEED_FILES.niconico)(n as unknown as Obj, i));
  res.seeds.peertube = validateList<PeertubeQuerySeed>(read('peertube'), SEED_FILES.peertube, checkPeertube, warn, strict);

  const creators = validateList<CreatorSeed>(read('creators'), SEED_FILES.creators, checkCreator, warn, strict, (e) => ({
    ...(e as unknown as CreatorSeed),
    accountIds: [...new Set((e.accountIds as string[]).map((a) => a.trim()))],
    note: (e.note as string | null | undefined) ?? null,
  }));
  const seenCreators = new Set<string>();
  for (const c of creators) {
    if (seenCreators.has(c.id)) {
      warn(`seeds/${SEED_FILES.creators}: duplicate creator id ${c.id}; later entry ignored`);
      continue;
    }
    seenCreators.add(c.id);
    res.seeds.creators.push(c);
  }
  return res;
}

/** Parsed seed files; missing files are empty arrays, invalid entries are skipped (reported via `log`). */
export function loadSeeds(dir: string = DEFAULT_SEEDS_DIR, opts: LoadSeedsOptions = {}): Seeds {
  return loadSeedsDetailed(dir, opts).seeds;
}

/**
 * Verified creator portfolios from seeds: creators.json plus `creatorId` links on YouTube channel seeds
 * (a channel whose creatorId names an existing creator is added to that creator's accounts).
 */
export function creatorsFromSeeds(seeds: Seeds): CreatorSeed[] {
  const byId = new Map<string, CreatorSeed>();
  for (const c of seeds.creators) byId.set(c.id, { ...c, accountIds: [...c.accountIds] });
  for (const ch of seeds.youtubeChannels) {
    const cid = ch.creatorId?.trim();
    if (!cid) continue;
    const c = byId.get(cid);
    if (!c) continue;
    const acc = `youtube:${ch.channelId}`;
    if (!c.accountIds.includes(acc)) c.accountIds.push(acc);
  }
  return [...byId.values()];
}

