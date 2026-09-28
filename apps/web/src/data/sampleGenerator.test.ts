import { describe, expect, it } from 'vitest';
import { buildIndex, CLASSIFIER_VERSION, decodeDataset, encodeDataset, PLATFORMS, TAXONOMY, TOP_LEVEL_CATEGORY_IDS } from '@vti/core';
import type { Dataset } from '@vti/core';
import {
  compactObservations,
  createRng,
  DAY,
  generateSampleDataset,
  HOUR,
  keywordMatches,
  SAMPLE_GENERATED_AT,
  topicProfile,
} from '../../scripts/sample-generator.ts';

let cached: Dataset | null = null;
function sample(): Dataset {
  cached ??= generateSampleDataset();
  return cached;
}

describe('createRng', () => {
  it('is deterministic per seed and in [0,1)', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const xs = Array.from({ length: 100 }, () => a.next());
    expect(Array.from({ length: 100 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 100 }, () => c.next())).not.toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
  it('int / weighted stay in range', () => {
    const r = createRng(1);
    for (let i = 0; i < 500; i++) {
      const n = r.int(3, 5);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
    const picks = new Set(Array.from({ length: 200 }, () => r.weighted(['a', 'b', 'c'], [0, 1, 0])));
    expect([...picks]).toEqual(['b']);
  });
});

describe('topicProfile', () => {
  it('makes 추석 peak now and summer topics fade', () => {
    expect(topicProfile('추석', 3)).toBeGreaterThan(5);
    expect(topicProfile('추석', 30)).toBeLessThan(1.1);
    expect(topicProfile('여름휴가', 45)).toBeGreaterThan(3);
    expect(topicProfile('여름휴가', 2)).toBeLessThan(0.5);
    expect(topicProfile('아무거나', 10)).toBe(1);
  });
});

describe('compactObservations', () => {
  const now = SAMPLE_GENERATED_AT;
  it('keeps everything in the last 72h and the first/last points', () => {
    const times = Array.from({ length: 24 }, (_, i) => now - i * 3 * HOUR).reverse();
    expect(compactObservations(times, now)).toEqual(times);
  });
  it('thins 3–14 day old points to at most one per 6h bucket, keeping KST midnights', () => {
    const start = now - 10 * DAY;
    const times = Array.from({ length: 40 }, (_, i) => start + i * 3 * HOUR);
    const kept = compactObservations(times, now);
    expect(kept[0]).toBe(times[0]);
    expect(kept[kept.length - 1]).toBe(times[times.length - 1]);
    const buckets = new Map<number, number>();
    for (const t of kept.slice(1, -1)) {
      const isKstMidnight = (t - 15 * HOUR) % DAY === 0;
      if (isKstMidnight) continue;
      const b = Math.floor(t / (6 * HOUR));
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
    }
    expect([...buckets.values()].every((n) => n === 1)).toBe(true);
    expect(kept.length).toBeLessThan(times.length);
    // every KST midnight in the input is kept
    for (const t of times) if ((t - 15 * HOUR) % DAY === 0) expect(kept).toContain(t);
  });
  it('returns short inputs unchanged', () => {
    expect(compactObservations([], now)).toEqual([]);
    expect(compactObservations([1, 2], now)).toEqual([1, 2]);
  });
});

describe('generateSampleDataset', () => {
  it('is deterministic for a seed', () => {
    const a = generateSampleDataset({ videos: 150 });
    const b = generateSampleDataset({ videos: 150 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = generateSampleDataset({ videos: 150, seed: 7 });
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it('has the requested scale across five platforms', () => {
    const ds = sample();
    expect(ds.schemaVersion).toBe(1);
    expect(ds.generatedAt).toBe(SAMPLE_GENERATED_AT);
    expect(ds.videos.length).toBeGreaterThan(2300);
    expect(ds.videos.length).toBeLessThanOrEqual(2500);
    expect(ds.accounts).toHaveLength(200);
    expect(new Set(ds.videos.map((v) => v.platform))).toEqual(new Set(['youtube', 'dailymotion', 'niconico', 'peertube', 'tiktok']));
  });

  it('marks everything as synthetic', () => {
    const ds = sample();
    expect(ds.accounts.every((a) => a.name.startsWith('샘플'))).toBe(true);
    expect(ds.creators.every((c) => c.name.startsWith('샘플'))).toBe(true);
    expect(ds.videos.every((v) => v.url.startsWith('https://example.com/sample/'))).toBe(true);
    expect(ds.accounts.every((a) => a.url.startsWith('https://example.com/sample/'))).toBe(true);
    expect(ds.exportNotes.join(' ')).toContain('샘플 데이터');
  });

  it('produces valid, namespaced ids and references', () => {
    const ds = sample();
    const ids = new Set(ds.videos.map((v) => v.id));
    expect(ids.size).toBe(ds.videos.length);
    const accountIds = new Set(ds.accounts.map((a) => a.id));
    for (const v of ds.videos) {
      expect(v.id).toBe(`${v.platform}:${v.platformId}`);
      expect(accountIds.has(v.accountId)).toBe(true);
      expect(v.accountId.startsWith(`${v.platform}:`)).toBe(true);
      expect(PLATFORMS).toContain(v.platform);
    }
    for (const c of ds.creators) for (const a of c.accountIds) expect(accountIds.has(a)).toBe(true);
    for (const a of ds.accounts) if (a.creatorId) expect(ds.creators.some((c) => c.id === a.creatorId && c.accountIds.includes(a.id))).toBe(true);
  });

  it('has multi-platform creators including an unconfirmed suggestion', () => {
    const ds = sample();
    const platformsOf = (ids: string[]) => new Set(ids.map((id) => id.split(':')[0]));
    expect(ds.creators.length).toBeGreaterThanOrEqual(5);
    expect(ds.creators.every((c) => platformsOf(c.accountIds).size >= 2)).toBe(true);
    expect(ds.creators.some((c) => c.linkStatus === 'suggested')).toBe(true);
  });

  it('keeps observations sorted, within [publish, generatedAt], and first/last consistent', () => {
    const ds = sample();
    for (const v of ds.videos) {
      expect(v.obs.length).toBeGreaterThan(0);
      for (let i = 1; i < v.obs.length; i++) expect(v.obs[i].t).toBeGreaterThan(v.obs[i - 1].t);
      expect(v.obs[0].t).toBeGreaterThanOrEqual(v.publishedAt);
      expect(v.obs[v.obs.length - 1].t).toBeLessThanOrEqual(ds.generatedAt);
      expect(v.firstSeenAt).toBe(v.obs[0].t);
      expect(v.lastObservedAt).toBe(v.obs[v.obs.length - 1].t);
      expect(v.publishedAt).toBeLessThan(ds.generatedAt);
    }
  });

  it('spans ~60 days of observations and includes older videos', () => {
    const ds = sample();
    const first = Math.min(...ds.videos.map((v) => v.obs[0].t));
    expect(ds.generatedAt - first).toBeGreaterThanOrEqual(59 * DAY);
    expect(ds.videos.some((v) => v.publishedAt < ds.generatedAt - 60 * DAY)).toBe(true);
  });

  it('never uses 0 for counters a source does not provide', () => {
    const ds = sample();
    for (const v of ds.videos) {
      for (const o of v.obs) {
        if (v.platform !== 'tiktok') expect(o.shares).toBeNull();
        if (v.platform === 'dailymotion' || v.platform === 'peertube') expect(o.comments).toBeNull();
        expect(o.views).not.toBeNull();
      }
    }
    expect(ds.videos.some((v) => v.obs.every((o) => o.likes === null))).toBe(true);
    expect(ds.videos.some((v) => v.platform === 'youtube' && v.obs.every((o) => o.comments === null))).toBe(true);
  });

  it('models mostly monotone counters with a few flagged decreases', () => {
    const ds = sample();
    let decreasing = 0;
    for (const v of ds.videos) {
      if (v.obs.some((o, i) => i > 0 && (o.views ?? 0) < (v.obs[i - 1].views ?? 0))) decreasing++;
    }
    expect(decreasing).toBeGreaterThan(0);
    expect(decreasing).toBeLessThan(ds.videos.length * 0.03);
  });

  it('assigns valid categories with evidence and version', () => {
    const ds = sample();
    const tops = new Set<string>(TOP_LEVEL_CATEGORY_IDS);
    for (const v of ds.videos) {
      expect(v.categories.length).toBeGreaterThan(0);
      for (const c of v.categories) {
        expect(tops.has(c.id.split('/')[0])).toBe(true);
        expect(c.evidence.length).toBeGreaterThan(0);
        expect(c.confidence).toBeGreaterThan(0);
        expect(c.confidence).toBeLessThanOrEqual(1);
        expect(c.version).toBe(ds.classifierVersion);
      }
      expect(v.topics.length).toBeGreaterThan(0);
    }
  });

  it('assigns subcategories only with keyword evidence that exists in the taxonomy', () => {
    const ds = sample();
    const byId = new Map(TAXONOMY.map((n) => [n.id, n]));
    const subs = ds.videos.flatMap((v) => v.categories.filter((c) => c.id.includes('/')).map((c) => ({ v, c })));
    if (TAXONOMY.some((n) => n.parent)) expect(subs.length).toBeGreaterThan(100);
    for (const { v, c } of subs) {
      const node = byId.get(c.id);
      expect(node).toBeDefined();
      const kw = c.evidence[0].match;
      expect(node!.keywords.map((k) => k.toLowerCase())).toContain(kw);
      expect(v.topics.some((t) => keywordMatches(kw, t))).toBe(true);
    }
  });

  it('keywordMatches avoids short ASCII false positives', () => {
    expect(keywordMatches('스킨케어', '스킨케어')).toBe(true);
    expect(keywordMatches('먹방 asmr', '먹방')).toBe(true);
    expect(keywordMatches('hair', 'ai')).toBe(false);
    expect(keywordMatches('skincare', 'skin')).toBe(true);
    expect(keywordMatches('롤', '롤')).toBe(true);
    expect(keywordMatches('롤', '롤러코스터')).toBe(false);
    expect(keywordMatches('', 'x')).toBe(false);
  });

  it('uses the current classifier version', () => {
    expect(sample().classifierVersion).toBe(CLASSIFIER_VERSION);
  });

  it('has disclosed and likely sponsorships with fictional brands', () => {
    const ds = sample();
    const disclosed = ds.videos.filter((v) => v.sponsorship?.level === 'disclosed');
    const likely = ds.videos.filter((v) => v.sponsorship?.level === 'likely');
    expect(disclosed.length).toBeGreaterThan(20);
    expect(likely.length).toBeGreaterThan(10);
    for (const v of [...disclosed, ...likely]) {
      expect(v.sponsorship!.brands.length).toBeGreaterThan(0);
      expect(v.sponsorship!.evidence.length).toBeGreaterThan(0);
    }
  });

  it('provides Dailymotion source windows consistent with the latest observation', () => {
    const ds = sample();
    const withWindows = ds.videos.filter((v) => v.sourceWindows.length);
    expect(withWindows.length).toBeGreaterThan(20);
    for (const v of withWindows) {
      expect(v.platform).toBe('dailymotion');
      const last = v.obs[v.obs.length - 1];
      for (const w of v.sourceWindows) {
        expect(w.observedAt).toBe(last.t);
        expect([24, 168, 720]).toContain(w.windowHours);
        expect(w.value).toBeGreaterThanOrEqual(0);
        expect(w.value).toBeLessThanOrEqual(last.views!);
      }
    }
  });

  it('makes 추석 topics rise and summer topics fall (view growth, last week vs the week before)', () => {
    const ds = sample();
    const now = ds.generatedAt;
    // Latest observed views at or before t (0 before publish): a rough, model-free increment.
    const at = (v: Dataset['videos'][number], t: number) => {
      if (t < v.publishedAt) return 0;
      let x: number | null = null;
      for (const o of v.obs) if (o.t <= t) x = o.views;
      return x ?? 0;
    };
    const growth = (topics: string[], fromDays: number, toDays: number) =>
      ds.videos
        .filter((v) => v.topics.some((t) => topics.includes(t)))
        .reduce((s, v) => s + Math.max(0, at(v, now - toDays * DAY) - at(v, now - fromDays * DAY)), 0);
    const chuseok = ['추석', '추석음식', '송편', '귀성길'];
    expect(growth(chuseok, 7, 0)).toBeGreaterThan(3 * growth(chuseok, 14, 7));
    const summer = ['여름휴가', '워터파크', '바캉스'];
    expect(growth(summer, 7, 0)).toBeLessThan(growth(summer, 14, 7));
    // Some old 추석 videos re-trend (activity mode finds them, upload mode does not).
    const oldRetrending = ds.videos.filter(
      (v) => v.publishedAt < now - 20 * DAY && v.topics.some((t) => chuseok.includes(t)) && at(v, now) - at(v, now - 7 * DAY) > 2 * Math.max(1, at(v, now - 7 * DAY) - at(v, now - 14 * DAY)),
    );
    expect(oldRetrending.length).toBeGreaterThan(0);
  });

  it('includes deleted/private videos, late discoveries and disabled credentialed sources', () => {
    const ds = sample();
    expect(ds.videos.some((v) => v.status === 'deleted')).toBe(true);
    expect(ds.videos.some((v) => v.status === 'private')).toBe(true);
    expect(ds.videos.some((v) => v.discoveredVia.includes('search:late-discovery'))).toBe(true);
    const disabled = ds.coverage.filter((c) => !c.enabled);
    expect(disabled.map((c) => c.source).sort()).toEqual(['instagram-graph', 'twitch', 'x-api']);
    expect(disabled.every((c) => c.lastStatus === 'disabled' && c.videoCount === 0)).toBe(true);
    const enabledVideos = ds.coverage.filter((c) => c.enabled).reduce((a, c) => a + c.videoCount, 0);
    expect(enabledVideos).toBe(ds.videos.length);
    expect(ds.runs.length).toBeGreaterThan(10);
    expect(ds.runs.some((r) => r.status === 'error')).toBe(true);
  });

  it('records YouTube subscribers rounded to 3 significant digits and no followers for niconico', () => {
    const ds = sample();
    const yt = ds.accounts.filter((a) => a.platform === 'youtube' && a.followers.length);
    expect(yt.length).toBeGreaterThan(10);
    for (const a of yt) {
      for (const f of a.followers) {
        const digits = String(f.value).replace(/0+$/, '').length;
        expect(digits).toBeLessThanOrEqual(3);
      }
    }
    expect(ds.accounts.filter((a) => a.platform === 'niconico').every((a) => a.followers.length === 0)).toBe(true);
  });

  it('round-trips through the compact codec and indexes cleanly', () => {
    const ds = sample();
    const json = JSON.stringify(encodeDataset(ds));
    expect(json.length).toBeLessThan(12 * 1024 * 1024);
    const back = decodeDataset(JSON.parse(json));
    expect(back.videos.length).toBe(ds.videos.length);
    expect(back.videos[10].obs).toEqual(ds.videos[10].obs);
    const index = buildIndex(back);
    expect(index.videosById.size).toBe(ds.videos.length);
    expect(index.creatorOfAccount.size).toBeGreaterThan(0);
  });
});
