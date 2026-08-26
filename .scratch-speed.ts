import { loadCorpus, runOnce, slowedBy, speedAwareClient } from './tests/helpers/adaptiveHarness.js';

const corpus = await loadCorpus(24);
for (const factor of [1, 1.5, 2, 2.5, 3, 3.5, 5]) {
  const o = await runOnce(corpus, speedAwareClient({ speed: slowedBy('deepseek', factor) }));
  const s = (m: string) => (100 * (o.byTarget.get(m) ?? 0)) / Math.max(o.onOpenRouter, 1);
  console.log(
    `deepseek ${factor.toFixed(1)}x slower -> ${s('deepseek').toFixed(1)} / ${s('minimax-m3').toFixed(1)} / ${s('minimax-m3-free').toFixed(1)}`,
  );
}
