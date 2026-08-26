/**
 * Sweep one `adaptive` constant against a target split, over repeated real runs.
 *
 *   npx tsx tools/calibrate-adaptive.ts complexityPull 0.15,0.25,0.35,0.43
 *   npx tsx tools/calibrate-adaptive.ts prose 0.2,0.35,0.5 --fix=complexityPull=0.3
 *   npx tsx tools/calibrate-adaptive.ts --target=deepseek=65,minimax-m3=25,minimax-m3-free=10
 *
 * Sweepable names are the fields of `AdaptiveTuning`: `throughput`, `health`,
 * `cost`, `prose`, `complexityPull`, `explorationBonus`.
 *
 * ## Two things this file is deliberately not
 *
 * It does **not** transcribe the scoring maths. The version before this one did,
 * with a header admitting the transcription could drift — and it had: it modelled
 * neither the oversize penalty nor the exploration bonus, so it under-reported
 * the free tier badly, and a constant fitted against it was a number about a
 * formula the router does not run. `AdaptiveTuning` exists so this can drive
 * `scoreTargets` itself.
 *
 * It does **not** score a static preference map, either. Counting which model
 * would win each document ignores that the corpus is served as *calls*, that the
 * strategy learns while it serves them, and that endpoint occupancy decides who
 * is even eligible. Each point below is a real `runJob` over the real Router.
 *
 * ## And it reports a mean and a spread, never a point
 *
 * The split is not a function of these constants. Whichever target draws the
 * first requests accumulates measured throughput and pulls ahead, and task order
 * under `run.concurrency` varies. Two candidates whose means differ by less than
 * their spreads are not distinguishable by this instrument, however precise the
 * numbers look; raise `--runs` or accept that they are the same.
 */
import { loadCorpus, runOnce } from '../tests/helpers/adaptiveHarness.js';
import { DEFAULT_TUNING, type AdaptiveTuning } from '../src/routing/strategies/adaptive/AdaptiveStrategy.js';

/** The three that actually compete once the free endpoints are saturated. */
const CONTENDERS = ['deepseek', 'minimax-m3', 'minimax-m3-free'] as const;

interface Point {
  value: number;
  /** Mean openrouter share per contender, %. */
  share: Record<string, number>;
  /** Standard deviation of the same, %. */
  spread: Record<string, number>;
  /** Sum of absolute deviations from the target split, percentage points. */
  error: number;
}

function parseTarget(argv: readonly string[]): Record<string, number> {
  const flag = argv.find((a) => a.startsWith('--target='));
  if (!flag) return { deepseek: 65, 'minimax-m3': 25, 'minimax-m3-free': 10 };
  const wanted: Record<string, number> = {};
  for (const pair of flag.slice('--target='.length).split(',')) {
    const [id, value] = pair.split('=');
    if (id && value) wanted[id.trim()] = Number(value);
  }
  return wanted;
}

function numberFlag(argv: readonly string[], name: string, fallback: number): number {
  const flag = argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? Number(flag.slice(name.length + 3)) : fallback;
}

/**
 * `--fix=prose=0.35,complexityPull=0.3` — constants held away from their
 * defaults for the whole sweep.
 *
 * Two knobs are the usual case rather than the exception, because the split has
 * a level and a slope and they are different questions. The weights decide who
 * the *default* winner is; `complexityPull` decides how far from average a
 * document has to be to overturn that default. Fitting the level by turning the
 * slope is how the previous calibration ended up at a `complexityPull` whose
 * best value was very nearly zero — the split came out right and the complexity
 * term, which is the entire reason this strategy exists, had stopped doing
 * anything.
 */
function fixedFlags(argv: readonly string[]): Partial<AdaptiveTuning> {
  const flag = argv.find((a) => a.startsWith('--fix='));
  if (!flag) return {};
  const held: Record<string, number> = {};
  for (const pair of flag.slice('--fix='.length).split(',')) {
    const [name, value] = pair.split('=');
    if (!name || !value) continue;
    if (!(name in DEFAULT_TUNING)) throw new Error(`Unknown constant "${name}" in --fix`);
    held[name] = Number(value);
  }
  return held as Partial<AdaptiveTuning>;
}

async function measure(
  corpus: readonly { slug: string; text: string }[],
  tuning: AdaptiveTuning,
  runs: number,
  target: Record<string, number>,
  value: number,
): Promise<Point> {
  const samples: Record<string, number[]> = Object.fromEntries(CONTENDERS.map((m) => [m, []]));
  for (let run = 0; run < runs; run += 1) {
    const outcome = await runOnce(corpus, undefined, tuning);
    for (const model of CONTENDERS) {
      samples[model]!.push((100 * (outcome.byTarget.get(model) ?? 0)) / Math.max(outcome.onOpenRouter, 1));
    }
  }

  const share: Record<string, number> = {};
  const spread: Record<string, number> = {};
  let error = 0;
  for (const model of CONTENDERS) {
    const values = samples[model]!;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    share[model] = mean;
    spread[model] = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
    error += Math.abs(mean - (target[model] ?? 0));
  }
  return { value, share, spread, error };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const knob = positional[0] as keyof AdaptiveTuning | undefined;
  const values = positional[1]?.split(',').map(Number);

  const runs = numberFlag(argv, 'runs', 5);
  const documents = numberFlag(argv, 'docs', 20);
  const target = parseTarget(argv);
  const held = fixedFlags(argv);
  const base: AdaptiveTuning = { ...DEFAULT_TUNING, ...held };

  const corpus = await loadCorpus(documents, argv.find((a) => a.startsWith('--corpus='))?.slice(9));
  if (corpus.length === 0) throw new Error('No corpus: expected .bio.md files under input/ru or out/ru');

  if (knob !== undefined && !(knob in DEFAULT_TUNING)) {
    throw new Error(`Unknown constant "${knob}". Sweepable: ${Object.keys(DEFAULT_TUNING).join(', ')}`);
  }

  const sweep = knob && values?.length ? values : [base[knob ?? 'complexityPull']];
  console.log(
    `\ntarget ${CONTENDERS.map((m) => `${m}=${target[m] ?? 0}`).join(' / ')}` +
      `   ·   ${runs} runs × ${corpus.length} documents per point` +
      `${knob && values?.length ? `   ·   sweeping ${knob}` : '   ·   current tuning only'}\n`,
  );

  const points: Point[] = [];
  for (const value of sweep) {
    const tuning: AdaptiveTuning = knob ? { ...base, [knob]: value } : { ...base };
    const point = await measure(corpus, tuning, runs, target, value);
    points.push(point);
    console.log(
      `  ${(knob ?? 'current').padEnd(17)} ${String(value).padStart(6)}   ` +
        CONTENDERS.map(
          (m) => `${m} ${point.share[m]!.toFixed(1).padStart(5)}±${point.spread[m]!.toFixed(1)}`,
        ).join('   ') +
        `   |err| ${point.error.toFixed(1)}`,
    );
  }

  const best = [...points].sort((a, b) => a.error - b.error)[0];
  if (best && points.length > 1) {
    const rivals = points.filter(
      (p) => p !== best && p.error - best.error < CONTENDERS.reduce((s, m) => s + best.spread[m]!, 0),
    );
    console.log(`\nbest ${knob} = ${best.value}  (|err| ${best.error.toFixed(1)} points)`);
    if (rivals.length > 0) {
      console.log(
        `  indistinguishable from ${rivals.map((p) => p.value).join(', ')} at this run count — ` +
          `the gap is inside the spread. Raise --runs before believing the ordering.`,
      );
    }
  }
  console.log();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
