---
paths:
  - "biomd.config.yaml"
  - "biomd.config.yaml.example"
  - "config/**/*.yaml"
  - "src/config/**/*.ts"
---

# Editing configuration or a model target

Settings and defaults: [docs/ref/config-map.md](../../docs/ref/config-map.md) ·
endpoint and model specifics: [docs/ref/providers.md](../../docs/ref/providers.md) ·
throughput: [docs/ref/throughput.md](../../docs/ref/throughput.md).

`src/config/schema.ts` is the authority on every setting, and carries a doc comment on nearly all
of them. Read the comment, not just the type.

- **A declared capability is only the routing gate.** A `web_search` model must also declare
  `webSearchMode`; Responses-tool targets must use `apiFormat: responses`. Runtime validation
  requires a completed provider search call and source evidence, so model-authored URLs alone are
  never proof of browsing.
- **A pool of one has no fallback chain.** `All 1 model target(s) failed` is what that shape looks
  like from the outside.
- **Lanes divide an endpoint's cap; they never raise one.** `config check` rejects lanes summing
  above `llm.endpoints[].maxConcurrent`.
- **Raise `run.concurrency` to at least the number of lanes**, or the orchestrator runs out of tasks
  before the endpoints run out of slots.
- **Under `sequential` the first entry is what gets called.** Putting a paid target at the head of
  the `websearch` list sends every search to the only thing that bills.
- **`reliability.fallback.maxTargets` truncates a pool.** A fourth entry is documentation, not a
  fallback, unless `maxTargets` is at least 4.
- **`omniroute` needs `stream: true`.** `maxConcurrent > 1` on that endpoint is safe only because
  of it; if streaming goes, the cap goes back to 1.
- **`topK` and `minP` are first-class fields** (`params.topK`, `params.minP`) and reach the wire as
  `top_k` / `min_p`. `params.extra` is the escape hatch for anything else, spread onto the body
  verbatim. Older reports in `reports/` say `top_k` needs `extra:` — that was true before the
  fields were added and is no longer.
- **On OpenRouter, a sampler you set is not a sampler that was applied.** Most hosts of a given
  model accept the request and drop what they do not implement. `provider.requireParameters: true`
  is what turns that silence into a `404`.
