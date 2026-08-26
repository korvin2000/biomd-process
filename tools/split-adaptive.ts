/**
 * What share of a run each target actually serves, averaged over repeated runs.
 *
 *   npx tsx tools/split-adaptive.ts [runs] [documents] [corpus-dir]
 *
 * The instrument for every constant in `AdaptiveStrategy.ts`, and the reason it
 * reports a mean and a spread rather than a number: the split is **not** a
 * function of the constants. The strategy learns during a run, so whichever
 * target draws the first requests accumulates measured throughput and pulls
 * ahead, and task order under `run.concurrency` varies between runs. Fitting to
 * one run is fitting noise — which is how an earlier calibration came to quote
 * point values it could not reproduce. Five runs is the floor, ten is better.
 *
 * It drives `runJob` — the real Router, lanes and gateway — through
 * `tests/helpers/adaptiveHarness.ts`, the same module the simulation test uses.
 * Nothing here transcribes the scoring maths, deliberately: see the header of
 * `tools/calibrate-adaptive.ts` for what happens when something does.
 *
 * `measured` is the check that the instrument is honest. Those figures must land
 * near `SPEED`, which is the profile priors; when they came back as three times
 * the prior for whichever target answered first, the harness was reporting a
 * first-mover bonus and every constant fitted against it was fitted to that.
 */
import { ENDPOINT_OF, loadCorpus, runOnce, SPEED } from '../tests/helpers/adaptiveHarness.js';

function describe(values: readonly number[]): string {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
  return `${mean.toFixed(1).padStart(5)}%   sd ${sd.toFixed(1).padStart(4)}   [${Math.min(...values).toFixed(
    1,
  )} – ${Math.max(...values).toFixed(1)}]`;
}

async function main(): Promise<void> {
  const runs = Number(process.argv[2] ?? 10);
  const documents = Number(process.argv[3] ?? 24);
  const dir = process.argv[4];

  const corpus = await loadCorpus(documents, dir);
  if (corpus.length === 0) throw new Error('No corpus: expected .bio.md files under input/ru or out/ru');

  const models = Object.keys(SPEED);
  const overall: Record<string, number[]> = Object.fromEntries(models.map((m) => [m, []]));
  const openrouter: Record<string, number[]> = Object.fromEntries(models.map((m) => [m, []]));
  const throughput: Record<string, number[]> = Object.fromEntries(models.map((m) => [m, []]));
  let calls = 0;
  let failures = 0;

  const started = Date.now();
  for (let run = 0; run < runs; run += 1) {
    const outcome = await runOnce(corpus);
    calls += outcome.total;
    failures += outcome.failures;
    for (const model of models) {
      const served = outcome.byTarget.get(model) ?? 0;
      overall[model]!.push((100 * served) / Math.max(outcome.total, 1));
      openrouter[model]!.push((100 * served) / Math.max(outcome.onOpenRouter, 1));
      const rate = outcome.measured.get(`${ENDPOINT_OF[model]}:${model}`);
      if (rate !== undefined) throughput[model]!.push(rate);
    }
    process.stderr.write(`  run ${run + 1}/${runs}\r`);
  }

  console.log(
    `\n${runs} runs × ${corpus.length} documents × 5 languages — ` +
      `${Math.round(calls / runs)} calls per run, ${failures} failed, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s\n`,
  );

  console.log('SHARE OF ALL CALLS');
  for (const model of models) console.log(`  ${model.padEnd(18)} ${describe(overall[model]!)}`);

  console.log('\nSHARE OF THE OPENROUTER CALLS (the decision this strategy exists to make)');
  for (const model of ['deepseek', 'minimax-m3', 'minimax-m3-free']) {
    console.log(`  ${model.padEnd(18)} ${describe(openrouter[model]!)}`);
  }

  console.log('\nMEASURED THROUGHPUT, tok/s — must land near the profile prior, or the instrument is lying');
  for (const model of models) {
    const rates = throughput[model]!;
    if (rates.length === 0) {
      console.log(`  ${model.padEnd(18)}     — never served a call`);
      continue;
    }
    const mean = rates.reduce((sum, v) => sum + v, 0) / rates.length;
    console.log(`  ${model.padEnd(18)} ${mean.toFixed(1).padStart(6)}   prior ${String(SPEED[model]).padStart(4)}`);
  }
  console.log();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
