/**
 * Writes apps/web/public/data/sample.json (compact format, core encodeDataset) from the deterministic
 * synthetic generator. Run from the repo root:
 *
 *   npx tsx apps/web/scripts/make-sample-dataset.ts [--videos 2500] [--seed 20260928] [--out path]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeDataset } from '@vti/core';
import { generateSampleDataset, SAMPLE_SEED } from './sample-generator.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(arg('out') ?? resolve(here, '../public/data/sample.json'));
const seed = Number(arg('seed') ?? SAMPLE_SEED);
const videos = Number(arg('videos') ?? 2500);

const started = Date.now();
const dataset = generateSampleDataset({ seed, videos });
const compact = encodeDataset(dataset);
const json = JSON.stringify(compact);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, json);

const obs = dataset.videos.reduce((a, v) => a + v.obs.length, 0);
const byPlatform = new Map<string, number>();
for (const v of dataset.videos) byPlatform.set(v.platform, (byPlatform.get(v.platform) ?? 0) + 1);
console.log(
  [
    `wrote ${out}`,
    `  videos ${dataset.videos.length} (${[...byPlatform].map(([p, n]) => `${p} ${n}`).join(', ')})`,
    `  accounts ${dataset.accounts.length}, creators ${dataset.creators.length}, observations ${obs}`,
    `  coverage ${dataset.coverage.length}, runs ${dataset.runs.length}`,
    `  size ${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)} MB, ${Date.now() - started} ms`,
  ].join('\n'),
);
