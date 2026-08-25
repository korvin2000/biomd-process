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
- **`prefer` is a reordering, never a filter.** The rest of the pool stays behind as the fallback
  chain, so a preference can slow a language down and can never make it unroutable.
- **A `GatewayObserver` method is optional, so an event `ObserverHub` forgets to forward reaches no
  listener and nothing fails.** That killed `onTargetDown` and every mechanism built on it. When
  adding an event, add it to the hub in the same change.
- **`AppLogger` writes the record envelope last.** A caller passing `{message: …}` as context must
  not be able to replace the line that says what happened.
