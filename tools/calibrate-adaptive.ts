/**
 * Fit the `adaptive` constants to a target split, against a real corpus.
 *
 * The scoring maths below is a transcription of `AdaptiveStrategy.scoreTargets`
 * with the module constants lifted into parameters, because those constants are
 * compile-time by design — they are claims, not settings.
 *
 * That transcription can drift, and a fitted constant is worthless if it was
 * fitted to a formula the router does not run. The cross-check is
 * `tools/simulate-adaptive.ts`, which drives the real `Router` and the real
 * strategy: pick a row here, put its values in `AdaptiveStrategy.ts`, and the
 * simulator must reproduce the same split. It currently does, exactly, on both
 * `input/ru` and `out/ru`. Re-check it after changing either file.
 *
 *   npx tsx tools/calibrate-adaptive.ts input/ru --target=deepseek=65,minimax-m3=25,minimax-m3-free=10
 *   npx tsx tools/simulate-adaptive.ts input/ru gemma-local,gpt-luna,deepseek,minimax-m3,minimax-m3-free
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { scoreComplexity } from '../src/routing/strategies/adaptive/ComplexityScorer.js';
import { profileFor } from '../src/routing/strategies/adaptive/ModelProfiles.js';

interface Knobs {
  wThroughput: number;
  wHealth: number;
  wCost: number;
  wProse: number;
  pull: number;
  /** Per-model tolerance overrides, on top of the compiled profiles. */
  tolerance: Record<string, number>;
  /** How well a model renders prose — the axis the four criteria have no term for. */
  prose: Record<string, number>;
  /** Never reward a model for being fragile; see the critique in the report. */
  clampFragile: boolean;
  /** Failure-rate overrides, for testing what a rate-limited free tier does. */
  failure: Record<string, number>;
}

const CURRENT: Knobs = {
  wThroughput: 1.0,
  wHealth: 1.5,
  wCost: 0.2,
  wProse: 0.5,
  pull: 0.45,
  tolerance: {},
  prose: {},
  clampFragile: true,
  failure: {},
};

/**
 * How well each model renders prose, 0..1 — the user's stated reason for
 * wanting deepseek to carry most of the corpus, and the one axis none of the
 * four criteria measures.
 */
const PROSE: Record<string, number> = {
  deepseek: 0.95,
  'minimax-m3': 0.7,
  'minimax-m3-free': 0.7,
};

/** The three that actually compete once the free endpoints are saturated. */
const CONTENDERS = ['deepseek', 'minimax-m3', 'minimax-m3-free'] as const;

/** USD for one 2000-in / 2000-out call, from `biomd.config.yaml`. */
const COST: Record<string, number> = {
  deepseek: (2000 * 0.08 + 2000 * 0.18) / 1e6,
  'minimax-m3': (2000 * 0.3 + 2000 * 1.2) / 1e6,
  'minimax-m3-free': 0,
};

const NEUTRAL_TOLERANCE = 0.5;

function proportional(values: readonly number[], higherIsBetter: boolean): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= 0) return values.map(() => 0.5);
  if (higherIsBetter) return values.map((v) => Math.min(1, v / max));
  const floor = max / 100;
  return values.map((v) => Math.min(1, (min + floor) / (v + floor)));
}

function winnerFor(complexity: number, knobs: Knobs): string {
  const rows = CONTENDERS.map((id) => {
    const profile = profileFor(id);
    return {
      id,
      throughput: profile.priorThroughput,
      health: 1 - (knobs.failure[id] ?? profile.priorFailureRate),
      prose: knobs.prose[id] ?? PROSE[id] ?? 0.5,
      cost: COST[id] ?? 0,
      tolerance: knobs.tolerance[id] ?? profile.tolerance,
    };
  });

  const t = proportional(rows.map((r) => r.throughput), true);
  const h = proportional(rows.map((r) => r.health), true);
  const c = proportional(rows.map((r) => r.cost), false);
  const p = proportional(rows.map((r) => r.prose), true);
  const total = knobs.wThroughput + knobs.wHealth + knobs.wCost + knobs.wProse;

  let best = rows[0]!.id;
  let bestScore = -Infinity;
  rows.forEach((row, i) => {
    const quality =
      (t[i]! * knobs.wThroughput + h[i]! * knobs.wHealth + c[i]! * knobs.wCost + p[i]! * knobs.wProse) / total;
    let bend = knobs.pull * (complexity - 0.5) * 2 * (row.tolerance - NEUTRAL_TOLERANCE);
    if (knobs.clampFragile && row.tolerance < NEUTRAL_TOLERANCE) bend = Math.min(0, bend);
    const score = quality + bend;
    if (score > bestScore) {
      bestScore = score;
      best = row.id;
    }
  });
  return best;
}

function distribution(scores: readonly number[], knobs: Knobs): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of CONTENDERS) counts[id] = 0;
  for (const score of scores) counts[winnerFor(score, knobs)] = (counts[winnerFor(score, knobs)] ?? 0) + 1;
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(counts)) out[id] = (100 * n) / scores.length;
  return out;
}

function distanceTo(actual: Record<string, number>, target: Record<string, number>): number {
  let sum = 0;
  for (const [id, want] of Object.entries(target)) sum += Math.abs((actual[id] ?? 0) - want);
  return sum;
}

function render(dist: Record<string, number>): string {
  return CONTENDERS.map((id) => `${id} ${(dist[id] ?? 0).toFixed(1)}%`).join('  |  ');
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? 'input/ru';
  const args = process.argv.slice(3);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.bio.md'));

  const scores: number[] = [];
  for (const file of files) {
    scores.push(scoreComplexity(await readFile(join(dir, file), 'utf8')).score);
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

  console.log(`\ncorpus: ${dir} — ${files.length} documents`);
  console.log(
    `complexity  min ${at(0).toFixed(3)}  p25 ${at(0.25).toFixed(3)}  median ${at(0.5).toFixed(3)}` +
      `  p75 ${at(0.75).toFixed(3)}  p90 ${at(0.9).toFixed(3)}  max ${at(1).toFixed(3)}\n`,
  );

  console.log(`AS CONFIGURED NOW:  ${render(distribution(scores, CURRENT))}\n`);

  const targetArg = args.find((a) => a.startsWith('--target='))?.slice('--target='.length);
  if (!targetArg) return;

  const target: Record<string, number> = {};
  for (const pair of targetArg.split(',')) {
    const [id, value] = pair.split('=');
    if (id && value) target[id.trim()] = Number(value);
  }
  console.log(`TARGET:             ${CONTENDERS.map((id) => `${id} ${target[id] ?? 0}%`).join('  |  ')}\n`);

  const results: { knobs: Knobs; dist: Record<string, number>; distance: number }[] = [];
  for (const pull of [0.35, 0.45, 0.55, 0.65]) {
    for (const wCost of [0.1, 0.2, 0.3]) {
      for (const wProse of [0.5, 0.8, 1.1, 1.4, 1.8]) {
        for (const freeFail of [0.05, 0.08, 0.12]) {
          for (const freeTol of [0.5, 0.6, 0.7]) {
          const knobs: Knobs = {
            wThroughput: 1.0,
            wHealth: 1.5,
            wCost,
            wProse,
            pull,
            tolerance: { 'minimax-m3-free': freeTol },
            prose: {},
            clampFragile: true,
            failure: { 'minimax-m3-free': freeFail },
          };
          const dist = distribution(scores, knobs);
          results.push({ knobs, dist, distance: distanceTo(dist, target) });
          }
        }
      }
    }
  }

  results.sort((a, b) => a.distance - b.distance);
  console.log('BEST FITS (clampFragile on, W_THROUGHPUT 1.0, W_HEALTH 1.5)');
  console.log(
    `  ${'PULL'.padStart(5)} ${'W_COST'.padStart(7)} ${'W_PROSE'.padStart(8)} ${'fail(free)'.padStart(11)}` +
      `   ${'off-by'.padStart(7)}   distribution`,
  );
  for (const row of results.slice(0, 10)) {
    const k = row.knobs;
    console.log(
      `  ${k.pull.toFixed(2).padStart(5)} ${k.wCost.toFixed(2).padStart(7)} ${k.wProse.toFixed(2).padStart(8)}` +
        ` ${(k.failure['minimax-m3-free'] ?? 0).toFixed(2).padStart(11)}` +
        ` ${(k.tolerance['minimax-m3-free'] ?? 0).toFixed(2).padStart(10)}` +
        `   ${row.distance.toFixed(1).padStart(7)}   ${render(row.dist)}`,
    );
  }
  console.log();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
