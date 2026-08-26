---
paths:
  - "src/llm/**/*.ts"
  - "src/routing/**/*.ts"
  - "src/reliability/**/*.ts"
  - "src/core/Orchestrator.ts"
---

# Editing the call path

Full account: [docs/ref/architecture.md](../../docs/ref/architecture.md) ·
throughput recipes: [docs/ref/throughput.md](../../docs/ref/throughput.md) ·
provider quirks: [docs/ref/providers.md](../../docs/ref/providers.md).

- **Extend the `LlmErrorKind → Disposition` table in `src/reliability/errors.ts`.** Never match a
  provider's message string at a call site.
- **Retry (same target) and fallback (next target) are separate axes.** `output_truncated` is the
  one kind that is fallbackable but *not* retryable — the payload was accepted and the model ran
  out of room, so re-asking buys the identical cut.
- **A strategy ranks and never calls anything.** `RoutingStrategy.select(ctx): ModelTarget[]`, and
  everything it may see is in `RoutingContext`.
- **Fit is two windows.** A target must hold the prompt *and* emit the answer; `outputHeadroom ≥ 0`
  is half the test. Neither `onOverflow` value ever routes nowhere.
- **A required capability is a boundary, not a preference.** If no target has it, return no route;
  never fall back to an incapable model that can answer fluently anyway.
- **Claims and semaphores are not interchangeable.** A lane is claimed in the *same synchronous
  tick* as the ranking that chose it, or three tasks starting together all read "the local model is
  free". The lane semaphore is acquired **before** the endpoint's, never after.
- **`least-busy` ranks on how full an endpoint is, never on free slot count.** A count hands the
  most generous endpoint every request from the first one onward.
- **`adaptive` sorts by load *then* score, and the score applies at every load level.** Ranking
  only the least-loaded tier and leaving the remainder in cost order switches the strategy off:
  models sharing an endpoint always share a load value, so they were ranked on price alone —
  51-0-0 across three of them on a live run. Full account:
  [docs/ref/adaptive-routing.md](../../docs/ref/adaptive-routing.md).
- **An unmeasured target must be explored, or it is never measured.** Without
  `EXPLORATION_BONUS` the first completed call decides the whole run: whoever answered fastest
  once out-scores a pool-mate that has nothing but its profile to argue with, forever.
- **A short window is the *estimate*; the cumulative count is the *confidence*.** Both measured
  terms in `adaptive` keep the two apart, and both got it wrong once. Weighting health by window
  length capped every target's certainty at ten and handed the decision to cost; weighting
  throughput by window length left the hand-set prior holding 3/7 of the term for the whole run, so
  a target sustaining 200 tok/s against a prior of 81 scored as 149.
- **Score a term through a knee when the measurement is noisier than the thing it measures.**
  Speed on openrouter is a mixture over dozens of providers, so `v / max` is steepest exactly where
  the reading is least trustworthy. `SPEED_TOLERANCE` places the knee at the noise floor: a 2.5x
  difference is nearly a tie, a 3.5x one is not.
- **`COMPLEXITY_MIDPOINT` is a corpus property, not the middle of the scale.** It was 0.5 because
  0…1 has 0.5 in the middle; this corpus has a median of 0.24, so 93% of it counted as "below
  average" and the tolerant model was penalised on nearly everything. Fitting it moved that model
  from 6.7% to 24% at unchanged weights.
- **A share held up by a hairline tie is not a share.** Two targets separated by a *constant* term
  (price) flip all at once when that constant nears zero — one weight moved 15% swung seventeen
  points of traffic. Two separated by a *payload-dependent* term (complexity × tolerance) slide a
  threshold instead. `tools/matrix-adaptive.ts` gates on that before it ranks on error.
- **Anything measured must be able to go stale.** A slow window demotes a target, and being demoted
  is what stops the next measurement arriving. `STREAK_DECAY_MS` and `THROUGHPUT_DECAY_MS` exist so
  the evidence expires rather than the target.
- **A fake provider that answers instantly measures nothing.** The gateway records
  `Date.now() - startedAt` and ignores a response's declared `latencyMs`, so a test double that
  returns synchronously reports every call as free. `tests/helpers/adaptiveHarness.ts` sleeps a
  compressed duration and reports proportionally fewer tokens, keeping tok/s exact; the first
  assertion in `tests/adaptive.simulation.test.ts` checks that it still does.
- **`prefer` means what `preferMode` says.** `reorder` (the default) floats the list to the front
  and keeps the rest of the pool behind it as the fallback chain. `restrict` makes the list the
  variant's *whole* chain: a one-entry list is then a pool of one, and a list whose models are all
  unusable routes nowhere — deliberately, so a language fails loudly instead of being served by a
  model the config declined to choose for it.
  `wait` makes the list a first tier instead: free preferred model, else queue `preferWaitMs`, else
  the rest of the pool, else wait for whichever allowed model frees first. It never fails a call.
- **`exclude` is the only mechanism that removes.** Everything else here reorders. It is applied
  before preference and before the overflow policy, so a vetoed model cannot come back as a
  fallback, as what a preference falls back *to*, or as the last resort a saturated pool waits on.
- **Only `wait` reads queue depth, and only in `LlmGateway.headOfChain`.** `reorder` and `restrict`
  hand the head of the chain to `Lanes.acquire`, which queues indefinitely — which is why a
  preferred target under those modes serves 100% of its variant, not most of it.
- **`freeSlots` counts claims; `acquire` takes the semaphore.** They are separate on purpose and
  the gateway holds both. Claims outlive individual attempts, so `freeSlots` under-reports
  availability and never over-reports — which is what stops the availability check from picking a
  target whose semaphore is full. A test that takes one without the other builds a state
  production cannot reach.
- **An abandoned acquisition must reject, drop its queue slot and take nothing.** `RateLimiter`
  used to resolve, increment `active` past the cap, and leave a dead waiter to eat the next
  wakeup. Anything that can time out depends on all three.
- **A `GatewayObserver` method is optional, so an event `ObserverHub` forgets to forward reaches no
  listener and nothing fails.** That killed `onTargetDown` and every mechanism built on it. When
  adding an event, add it to the hub in the same change.
- **`AppLogger` writes the record envelope last.** A caller passing `{message: …}` as context must
  not be able to replace the line that says what happened.
