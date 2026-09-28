/** Adapter registry (contract). Order = collection order. */
import type { SourceAdapter } from '../types.ts';
import { youtubeRss } from './youtube-rss.ts';
import { dailymotion } from './dailymotion.ts';
import { peertube } from './peertube.ts';
import { niconico } from './niconico.ts';
import { youtubeDataApi } from './youtube-data-api.ts';
import { tiktokResearch } from './tiktok-research.ts';
import { instagramGraph } from './instagram-graph.ts';
import { xApi } from './x-api.ts';
import { twitch } from './twitch.ts';

export const ADAPTERS: SourceAdapter[] = [youtubeRss, dailymotion, peertube, niconico, youtubeDataApi, tiktokResearch, instagramGraph, xApi, twitch];

export function adapterById(id: string): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
