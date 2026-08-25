# Endpoints, providers and model tuning

Three transports sit behind one client (`OpenAiCompatibleClient`), so everything here is
configuration rather than code. What differs between them is what they *silently ignore* — and
that is the whole subject of this file.

Settings and defaults: [config-map.md](config-map.md) · what to do when one misbehaves:
[failure-modes.md](failure-modes.md) · getting all three busy at once:
[throughput.md](throughput.md).

> **Target ids differ between the two config files.** The live `biomd.config.yaml` uses
> `gemma-local` · `gpt-luna` · `deepseek` · `minimax-m3` · `search-std` · `search-mx` ·
> `search-safe` · `paid-search`; the annotated `biomd.config.yaml.example` still uses the older
> `local-small` · `or-luna` · `or-cheap` · `or-search{,2,3}` · `or-osearch` · `or-search-quality`.
> Historical incidents below keep the id they happened under. **Free vs paid is a property of the
> endpoint, not of the id — read `pricing`.**

> **Sourcing.** Rows marked *(gateway)* were read from the deployment's own `/v1/models` or
> measured on the wire and written up in `reports/`. Rows marked *(upstream)* come from the
> project's public documentation and describe defaults, which a local install may have changed.
> Where the two disagree, the gateway wins — it is the thing answering.

---

## OmniRoute

A local, MIT-licensed gateway that fronts many providers behind one OpenAI-compatible endpoint
(*upstream:* [github.com/diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)).
Models are named `provider/model-name`; the special id `auto` lets the gateway choose.

### Ports — this deployment is non-default

| Setting | Upstream default | Here |
|---|---|---|
| `PORT` — dashboard + `/v1` API | `20128` | — |
| `LIVE_WS_PORT` — monitoring WebSocket | `20129` | — |
| `llm.endpoints[omniroute].baseUrl` | — | `http://192.168.1.26:20129/v1` |

The configured API port is upstream's *WebSocket* default, so this install has been re-pointed.
It works — every probe and every run in `reports/omniroute-openai-report.md` went through it — but
do not "correct" it to 20128 from the documentation alone, and do not assume 20129 on a fresh
install.

### What the gateway does to a request

| Behaviour | Consequence for this project |
|---|---|
| the `cx/*` models report `api_format: responses` *(gateway)* | ordinary tasks may use the Chat adapter; hosted web search uses `apiFormat: responses` and the real `/responses` tool path |
| **`temperature` is validated and ignored by Chat, and rejected by Responses** *(gateway)* | do not set it on a `cx/*` target. Writing it down records an intention the endpoint does not honour |
| **reasoning is on unless disabled** *(gateway)* — bare `cx/gpt-5.6-luna` spends 184 reasoning tokens on a control question | `reasoning: { enabled: false, dialect: reasoning_effort }`. `reasoning_effort: none` gives exactly 0 |
| effort suffixes are monotone *(gateway)*: `terra-low` 14% → `luna-medium` 20% → `luna-high` 86% of output tokens | `-high` costs 7× the tokens and 7× the wall clock for this corpus's work |
| **buffered overlap cross-talk** *(gateway)* — two overlapping non-streamed requests, the second gets the first's completion, 5 of 5 | **`stream: true`**. Correct 15 of 15 with it. `maxConcurrent > 1` is safe only because of it |
| **response cache** *(gateway)* — an identical body returns in ~15–50 ms with no model attribution | add a nonce when probing, or a re-run looks implausibly fast and a "pass" is a cache hit |
| `prompt_cache` is real *(gateway)* — 2816 of a 3704-token first call returned as `cached_tokens`, across runs *and* across models | Chat reports cached tokens additively, hence `usage.chatCachedTokens: additional`; the Responses bridge rejects explicit cache controls and uses its implicit cache |
| intermittent `404 No active credentials for provider: omniroute` *(gateway)* | for a model listed in its own `/v1/models`, working minutes later. **A `/v1/models` listing is not a health check** |
| `X-OmniRoute-Decision` and `X-OmniRoute-*` headers carry strategy, provider, latency and cost *(upstream)* | not consumed by this client; useful when probing with `curl -i` |
| three resilience layers *(upstream)*: provider circuit breaker on 408/5xx, connection cooldown (5 s OAuth / 3 s API key), per-model 429 lockout | the gateway retries beneath this tool's own retry. A single slow call may be several upstream attempts |

### Environment variables that interact with this project *(upstream)*

| Variable | Default | Why it matters here |
|---|---|---|
| `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT` | `1` | heavyweight chat requests **queue rather than 503**. A whole-document translation can trip this |
| `OMNIROUTE_CHAT_LARGE_BODY_BYTES` | `262144` (256 KB) | the threshold for "heavyweight". `mode: segments` keeps bodies far below it; `mode: document` on a long article is what approaches it |
| `COMBO_CONCURRENCY_PER_MODEL` | `3` | the gateway's own per-model round-robin cap — the ceiling an endpoint `maxConcurrent` above 3 would be arguing with |
| `RELAY_IP_PER_MINUTE` | `30` | per-IP rate limit. This project configures `requestsPerMinute: 60` for the endpoint; if the install kept the default, the gateway is the tighter limit |
| `OMNI_MAX_CONCURRENT_CONNECTIONS` | 0 (off) | a global connection cap, if the install sets one |
| `REQUIRE_API_KEY` | — | when on, `/v1/*` needs the key. `apiKey: ${OMNIROUTE_API_KEY}` covers it either way |
| `DISABLE_CONTEXT_WINDOW_CHECKS` | `false` | the gateway validates token limits itself; this tool's `onOverflow` decides earlier and independently |
| `MAX_BODY_SIZE_BYTES` | `10485760` (10 MB) | far above anything this project sends |

### Authentication and OAuth *(upstream)*

Credentials are stored locally, encrypted at rest with AES-256-GCM, and OAuth flows are completed
through the dashboard or CLI rather than through the API. For a reverse-proxy or non-localhost
install, `NEXT_PUBLIC_BASE_URL` must be set to a stable public URL or OAuth callbacks break.
Remote-mode access tokens carry a `read` / `write` / `admin` scope.

**Nothing in this project performs an OAuth flow.** It sends a bearer key
(`apiKey: ${OMNIROUTE_API_KEY}`) to an already-authorized gateway; the provider credentials behind
it are the gateway's business. If a `cx/*` model starts 404-ing on credentials, the fix is in the
OmniRoute dashboard, not in `biomd.config.yaml`.

### Probing it by hand

```bash
curl -s -H "Authorization: Bearer $OMNIROUTE_API_KEY" http://192.168.1.26:20129/v1/models | head -40
```

Two traps: a probe that **omits `stream`** gets SSE and looks clean, which is how the coalescing bug
was once mis-declared fixed; and an identical body hits the response cache, so vary a nonce.

---

## OpenRouter

`https://openrouter.ai/api/v1`, with `headers: { HTTP-Referer, X-Title }` for attribution.
Paid — see the boundary in [CLAUDE.md](../../CLAUDE.md#boundaries).

### The finding that matters: one model id is many hosts

`deepseek/deepseek-v4-flash-0731` is served by **29 providers, and their sampling support differs.**
Measured 2026-08-24 from
`/api/v1/models/deepseek/deepseek-v4-flash-0731/endpoints`: only **nine of the 29** implement
`top_k` *and* `min_p` *and* `response_format`. The other twenty accept the request and drop what
they do not implement — DeepSeek's own host answers **200** to `top_k: 1, min_p: 0.5` and samples as
if neither had been sent.

Nothing downstream can see that: same status, same German, same cost, and which of the two happened
depends on who had capacity that second.

### The `provider` block — a correctness setting, not a price one

`llm.models[].provider` (`providerRoutingSchema`):

| Key | Effect |
|---|---|
| `order` | preferred providers, best first; the rest of the market stays behind them |
| `only` | hard whitelist |
| `ignore` | never route here. A slug in both `ignore` and `order`/`only` is a config error, not a silent resolution |
| `allowFallbacks` | `false` pins routing to `order`/`only` — a failure there fails the call. Leave unset for a batch; set `false` to pin an experiment |
| **`requireParameters`** | **restricts routing to a provider supporting every field in the request.** This is what makes the drop audible: an unhonoured `min_p` arrives as `404 No endpoints found that can handle the requested parameters`. **Any target carrying more than `temperature` wants this on** |
| `sort` | `price` \| `throughput` \| `latency` |
| `quantizations` | e.g. `[bf16, fp8]` to exclude fp4 hosts outright |

Measured throughput on a real 2.5k-token translation call — not the p50 of a one-line prompt:

| Provider | $/1M in–out | tok/s | ok | notes |
|---|---|---|---|---|
| `ambient/fp4` | 0.08 / 0.18 | 74 | 3/3 | cache, seed |
| `together` | 0.14 / 0.28 | 47 | 3/3 | cache |
| `phala` | 0.20 / 0.40 | 59 | 3/3 | cache, seed |
| `deepinfra/fp8` | 0.08 / 0.18 | **104** | **2/3** | cheapest *and* fastest, and fourth — on 2026-08-24 it answered `502 Upstream error` to 6 of 8 strictly sequential calls five seconds apart. Pacing is not what ails it, and a 25% success rate at the head of the list is 75% of the batch paying a failed round trip first |
| `morph/bf16` | 0.079 / 0.278 | 16 | 3/3 | the only unquantized host — the fidelity reference, four times slower |

Excluded: `mancer/fp8` ("No tokens generated" on a real payload) and `wafer/fast` (status −2,
85.8% uptime).

> Pricing is written for the **pinned** providers, not for the model page. Pinning changes the bill,
> so the bill belongs where the pin is.

### Getting a model that actually searches

Four routes, in descending order of preference:

1. **Responses hosted search** — `apiFormat: responses`, `webSearchMode: responses_tool`, plus a request carrying
   `tools: [{ type: web_search }]` and `tool_choice: required`. This is what the OmniRoute targets use.
2. **a hosted search model** — `webSearchMode: hosted`, e.g. `model: perplexity/sonar`
3. **the `:online` suffix** — `webSearchMode: online`, e.g. `model: openai/gpt-5.6-luna:online`, which bills a per-request search
   fee on top of tokens
4. **the web plugin** — `webSearchMode: plugin` plus `params.extra: { plugins: [{ id: web, max_results: 5 }] }`

`tasks.websearch` routes on the declared `web_search` capability, but declaration is not proof:
the response must contain a completed provider search call and every accepted source URL must be
present in its source evidence. Ordinary `cx/gpt-5.6-luna` Chat Completions were measured fabricating
a current GitHub SHA while citing the right URL; the Responses tool returned the exact live value.

**Web search and `json_object` are mutually exclusive on the configured gateways.** They refuse the combination —
`400 Web Search cannot be used with JSON mode` — so `or-osearch`/`paid-search` must **omit
`json_object` from its capability list**. The transport then sends no `response_format` and the
target degrades to asking for JSON in the prompt, which the prompt already does.

### Reasoning

OpenRouter records a per-model default. `deepseek-v4-flash-0731` publishes
`default_enabled: true, default_effort: high`, so it reasons unless told not to, **and those tokens
bill at the output rate**. Verified on the wire 2026-08-24:

| Setting | Result |
|---|---|
| no field | the model deliberates in the answer |
| `{ enabled: false }` (dialect `reasoning`) | `reasoning_tokens: 0`, clean answer |
| `{ effort: none }` | same |
| **`{ exclude: true }`** | **the trap — hides the trace and still spends it** |

Not every endpoint permits it: `google/gemini-3.7-flash` answers
`400 Reasoning is mandatory for this endpoint and cannot be disabled`. Where reasoning is
mandatory it competes with the answer for the output budget, so keep `maxOutputTokens` generous.

---

## llama.cpp (`llama-server`) — the `local` endpoint

`http://192.168.1.26:8080/v1`, serving `gemma-4-31B-it-qat-UD-Q4_K_XL` (Q4_0 ftype, 30.7 B
params), `n_ctx` 65536, **1 slot** *(gateway)*.

- **One slot means `maxConcurrent: 1`, and that is a fact about the server, not a preference.**
  It is also exactly why `cost-optimized` throttles a translation run to a single lane — see
  [throughput.md](throughput.md).
- **No authentication** — the endpoint takes no `apiKey`.
- **`top_k` and `min_p` are native**, not extensions. `llama-server`'s own defaults are
  `temperature 0.75, top_k 64, top_p 0.95, min_p 0.05`, which is why the tuned values sit so close
  to them.
- It accepts `response_format` for `json_object` / `json_schema` and reports `cached_tokens`.
- Raising throughput here is a **server-side** change (`--parallel` / more slots), not a config one.
  Until then, the local model is one lane no matter what the pool says.

### `topK` / `minP` are first-class

```yaml
params:
  temperature: 0.75
  topP: 0.915
  topK: 64
  minP: 0.035
  extra: { anything_else: … }   # spread onto the body verbatim
```

`temperature` `topP` `topK` `minP` `frequencyPenalty` `presencePenalty` `seed` `stop` all map to
their wire names in `buildRequestBody`. `params.extra` is the escape hatch for everything else.

> `reports/gemma4-report.md` §3 says `top_k` has no schema field and must ride in `params.extra`.
> **That was true when it was written and is not now** — `topK` and `minP` were promoted precisely
> because they are the two a gateway most often accepts and ignores. Both forms reach the wire as
> `top_k` / `min_p`; the first-class one is checked by Zod, the `extra` one is not.

---

## Model tuning

Current values are from `biomd.config.yaml`. **Three of the five studies conclude the sampler
barely matters at all, and the other two caveat their own ranking as within noise** — run-to-run
spread on the same setting exceeded, or came close to, every difference between settings. Treat these as *stated* defaults (the endpoint's own are unknown and can change
under a batch), not as a tuned optimum.

### `gemma4-31b-local` — the local workhorse (extract + translate)

```yaml
params: { temperature: 0.75, topP: 0.915, topK: 64, minP: 0.035 }
```

- 114 runs (`gemma4-v2-report.md`): `top_k` 60–66 is **mechanically inert** — byte-identical output
  in 16 of 18 cases; `min_p` 0.02–0.06 changes the text but not its quality; `top_p` 0.90–0.93 shows
  no effect that survives a paired re-test.
- **The reproducibility axis is the one that matters.** This target ran at the server default while
  every other sat at 0.1, and it does all the extraction and all the translation. Same eight
  fragments asked three times: server default → **3 distinct answers**, `temperature 0.2` → 2,
  `temperature 0` → 1. That churn is what makes two runs differ on "very young age" vs "too-young
  age" — easily mistaken for a prompt regression. `useTranslationMemory` assumes a stable rendering.
  **Use `temperature: 0` when reproducibility matters more than the last few percent of fluency.**
- Stable defects are prompt-side, not sampling-side: the romanize-and-gloss rule misfires ~28% of
  runs at any setting, and the one catastrophic failure in the study — a surname left in Cyrillic —
  is **seed-bound**, reproducing at both `min_p` extremes on seed 20260824 and on no other seed.

### `cx/gpt-5.6-luna` on OmniRoute — German/English translation

```yaml
contextWindow: 272000
maxOutputTokens: 32768        # the gateway reports 128000; 32768 surfaces a runaway as output_truncated
capabilities: [json_object, json_schema, prompt_cache, tools]
reasoning: { enabled: false, dialect: reasoning_effort }
# no params.temperature, deliberately — the gateway ignores it
```

First on translation quality of five models tested, second overall, ~41 s and ~2.1k output tokens
per article. **The only family that transliterates into German rather than English** —
`Tschudinow`, not `Chudinov`, which is the difference between an entry a German reader finds and
one they do not.

`-high` scores higher overall on rule-following and is not worth it: 7× the output tokens, 7× the
wall clock, and it spelled the subject's surname two or three ways in half its runs. Reasoning did
not resolve this corpus's ambiguities — it **manufactured** one, turning the typo `да и а строй`
into "die A-Saite" in 4 of 4 runs at medium effort, published as fluent German about a string the
article never mentions.

Neither `terra` model belongs in a German pool: both transliterate the English way and both write
straight `"…"` instead of `„…"`.

### `deepseek/deepseek-v4-flash-0731` on OpenRouter

```yaml
provider: { order: [ambient/fp4, together, phala, deepinfra/fp8, morph/bf16], requireParameters: true }
reasoning: { enabled: false, dialect: reasoning }
params: { temperature: 0.6, topP: 0.95, topK: 42, minP: 0.02 }
```

36 combinations × 2 on `example/example.bio.md` ru→de: **no parameter's effect is distinguishable
from chance** (p = 0.45 / 0.38 / 0.96 / 0.69), because two runs of the *same* combination differ by
16.7 points on average while the largest spread between levels is 4.3.

> The two settings in that block that genuinely change what you get are **`provider` and
> `reasoning`**, not the samplers.

Used here as the preferred model for `zh`, `ja`, `ko`, `it` and as a co-preference for `fr`.

### `minimax/minimax-m3` on OpenRouter

```yaml
contextWindow: 262144         # CoreWeave's figure; OpenRouter's aggregate is 1048576
reasoning: { enabled: false, dialect: reasoning }
params:
  temperature: 0.36
  extra: { provider: { order: [CoreWeave, Parasail, DeepInfra], allow_fallbacks: false } }
```

Ten runs ru→fr across five temperatures: **0.35 is the only cell on the good side of both axes**,
and its *worse* run beats the worse run of every other temperature. The live config sits at 0.36.
The report's own caveat: the spread across all five temperatures is 4.2 points and the spread
between two seeds of the *same* temperature reaches 6.6 — **the trend is reliable, the ranking of
places 2–5 is not.**

Preferred for `es` and co-preferred for `fr`.

### `google/gemini-3.7-flash` — strong, and **not** a search model

Deliberately carries no `web_search` capability. Put it in the `websearch` pool and it answers
every question fluently, with a citation, from memory — see
[failure-modes.md](failure-modes.md#endpoint-faults). Reasoning cannot be disabled on this
endpoint, so `maxOutputTokens` must stay generous.

---

## Adding a target — the checklist

1. **Declare only capabilities you have verified.** `--probe` proves the target answers; a JSON
   probe proves `json_object`; a repeat call showing `cached_tokens` proves `prompt_cache`. Nothing
   proves `web_search` except an answer carrying a source you can open.
2. **Read `contextWindow` and `maxOutputTokens` off the gateway's `/v1/models`**, not off a model
   page. An understated output ceiling makes `onOverflow: skip` drop a target that would have
   worked.
3. **Decide reasoning explicitly.** The default is usually "on", and `exclude` is not "off".
4. **On OpenRouter, pin providers and set `requireParameters: true`** if the target carries any
   sampler beyond `temperature`.
5. **Put it in a pool with something behind it**, and re-run `--probe`.
6. **Price it for the providers you pinned.**
