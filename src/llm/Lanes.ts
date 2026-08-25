import type { EndpointConfig, RoutingConfig } from '../config/schema.js';
import type { RateLimiterRegistry } from '../reliability/RateLimiter.js';
import type { OccupancyView } from '../routing/types.js';
import type { ModelTarget } from './types.js';

const DEFAULT_POOL = 'default';

/**
 * Who is allowed to be talking to whom, right now.
 *
 * Two numbers describe an endpoint's concurrency and they answer different
 * questions, which is why both are here rather than folded into one:
 *
 *  - the **endpoint's** `maxConcurrent` is a fact about the provider — three
 *    parallel requests is what OpenRouter tolerates, one is what the local
 *    gateway can actually serve, and one is what `omniroute` requires for
 *    *correctness* (it coalesces simultaneous requests into a single answer);
 *  - a **lane** (`llm.routing.pools.<pool>.maxConcurrent.<endpoint>`) is how
 *    that budget is shared out. Without one, the endpoint that allows the most
 *    parallelism takes every request the moment it has room, and ends up
 *    serving most of a corpus while two others idle. The lanes across all pools
 *    may never exceed the endpoint's own cap (checked in the config schema): a
 *    lane divides a budget, it never raises one.
 *
 * Both are counted, and a pool's free capacity is whichever runs out first —
 * an endpoint fully occupied by `extract` has nothing to offer `translate`
 * however generous `translate`'s lane on it is.
 *
 * And two mechanisms enforce them, deliberately:
 *
 *  - **claims** are the routing input. A claim is taken the instant a target is
 *    chosen — synchronously, in the same tick as the ranking that chose it —
 *    and released when the logical call is over. That is what makes
 *    `least-busy` reliable rather than racy: without it, three tasks starting
 *    together all read "the local model is free", all pick it, and two then
 *    block on a semaphore they could have avoided.
 *  - **semaphores** are the enforcement, and they still apply when the chain
 *    has nowhere else to go. Ranking is advice; a cap is a cap.
 */
export class LaneRegistry implements OccupancyView {
  private readonly endpointLimits = new Map<string, number>();
  /** Claim counts, keyed by endpoint id and by `pool@endpoint`. See {@link claim}. */
  private readonly claims = new Map<string, number>();

  constructor(
    private readonly routing: RoutingConfig,
    endpoints: readonly EndpointConfig[],
    private readonly limiters: RateLimiterRegistry,
  ) {
    for (const endpoint of endpoints) this.endpointLimits.set(endpoint.id, endpoint.maxConcurrent);
  }

  /** This pool's declared share of an endpoint. 0 = no lane, only the endpoint's own limit. */
  laneLimit(pool: string | undefined, endpointId: string): number {
    return this.routing.pools[pool ?? DEFAULT_POOL]?.maxConcurrent[endpointId] ?? 0;
  }

  /**
   * Concurrent requests this pool may hold on this endpoint. 0 = unlimited.
   *
   * The binding constraint of the two: a lane can only ever be narrower than
   * the endpoint it divides.
   */
  limitOf(pool: string | undefined, endpointId: string): number {
    const endpoint = this.endpointLimits.get(endpointId) ?? 0;
    const lane = this.laneLimit(pool, endpointId);
    if (endpoint === 0) return lane;
    if (lane === 0) return endpoint;
    return Math.min(endpoint, lane);
  }

  /** Logical calls this pool currently has in flight on the target's endpoint. */
  inFlight(pool: string | undefined, target: ModelTarget): number {
    return this.claims.get(laneKey(pool, target.endpointId)) ?? 0;
  }

  /**
   * Slots this pool could still fill on the target's endpoint.
   *
   * `Infinity` when nothing caps it, which is exactly what a comparison-based
   * strategy wants: an unlimited endpoint never has to be special-cased.
   */
  freeSlots(pool: string | undefined, target: ModelTarget): number {
    const endpointLimit = this.endpointLimits.get(target.endpointId) ?? 0;
    const lane = this.laneLimit(pool, target.endpointId);
    if (endpointLimit === 0 && lane === 0) return Number.POSITIVE_INFINITY;

    // Whichever runs out first. The endpoint total counts every pool, because
    // an endpoint another pool is saturating has nothing to offer this one.
    const byEndpoint =
      endpointLimit === 0
        ? Number.POSITIVE_INFINITY
        : endpointLimit - (this.claims.get(target.endpointId) ?? 0);
    const byLane = lane === 0 ? Number.POSITIVE_INFINITY : lane - this.inFlight(pool, target);
    return Math.max(0, Math.min(byEndpoint, byLane));
  }

  /**
   * How full the target's endpoint is for this pool: 0 idle, 1 full.
   *
   * The **fraction** rather than the count, and that is the whole design. An
   * endpoint that allows three parallel requests has three free slots while it
   * is idle and one that allows a single request has one; ranking on the count
   * would give the generous endpoint every request from the first one onwards,
   * which is the imbalance a spreading strategy exists to prevent. As a
   * proportion of what each endpoint can hold, idle is idle.
   */
  load(pool: string | undefined, target: ModelTarget): number {
    const limit = this.limitOf(pool, target.endpointId);
    if (limit === 0) return 0;
    return (limit - this.freeSlots(pool, target)) / limit;
  }

  /**
   * Records that this pool is about to occupy the target's endpoint.
   *
   * Synchronous on purpose. The gateway claims in the same tick as the routing
   * decision, so no two concurrent callers can both see the same free slot —
   * which is the whole difference between spreading the load and merely
   * intending to.
   */
  claim(pool: string | undefined, target: ModelTarget): () => void {
    const keys = [target.endpointId, laneKey(pool, target.endpointId)];
    for (const key of keys) this.claims.set(key, (this.claims.get(key) ?? 0) + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) this.claims.set(key, Math.max(0, (this.claims.get(key) ?? 1) - 1));
    };
  }

  /**
   * Waits for a real slot: the pool's lane first, then the endpoint itself.
   *
   * Lane before endpoint, and never the other way around. Holding an endpoint
   * slot while queueing for a lane would let a pool whose lane is full block a
   * pool whose lane is free — the endpoint's capacity spent on waiting rather
   * than on requests.
   */
  async acquire(pool: string | undefined, target: ModelTarget, signal?: AbortSignal): Promise<() => void> {
    const lane = this.laneLimit(pool, target.endpointId);
    const releaseLane =
      lane > 0
        ? await this.limiters
            .for(laneKey(pool, target.endpointId), { requestsPerMinute: 0, maxConcurrent: lane })
            .acquire(signal)
        : undefined;

    try {
      const releaseEndpoint = await this.limiters
        .for(target.endpointId, {
          requestsPerMinute: target.endpoint.requestsPerMinute,
          maxConcurrent: target.endpoint.maxConcurrent,
          // Spacing belongs to the endpoint, never to a lane: it is a fact about
          // what the provider tolerates, and two pools each honouring it
          // separately would still arrive together.
          minRequestSpacingMs: target.endpoint.minRequestSpacingMs,
        })
        .acquire(signal);

      return () => {
        releaseEndpoint();
        releaseLane?.();
      };
    } catch (error: unknown) {
      // The lane is already held at this point. Before abandoning an
      // acquisition was possible this could not happen; now that a wait can
      // time out it happens on every expiry, and a lane nobody holds and nobody
      // releases would shrink the pool's capacity by one for the rest of the run.
      releaseLane?.();
      throw error;
    }
  }

  /**
   * A slot on whichever of these targets frees one first.
   *
   * `undefined` means the deadline passed with all of them still busy — a
   * caller's cue to widen its choice rather than keep waiting. Losing
   * acquisitions are cancelled, and a loser that resolves anyway (cancellation
   * can race the handoff by one turn) hands its slot straight back; otherwise
   * it would be held by nobody for the rest of the run.
   *
   * Order is not a tie-break here and is not meant to be: this is for the case
   * where *nothing* is free, so "first to free" is the only ranking available.
   * A caller that wants its order honoured checks {@link freeSlots} first, in
   * its own order, and only falls back to this when that finds nothing.
   */
  async acquireAny(
    pool: string | undefined,
    targets: readonly ModelTarget[],
    options: { waitMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ target: ModelTarget; release: () => void } | undefined> {
    if (targets.length === 0) return undefined;

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer =
      options.waitMs !== undefined && Number.isFinite(options.waitMs)
        ? setTimeout(abort, Math.max(0, options.waitMs))
        : undefined;

    try {
      return await new Promise<{ target: ModelTarget; release: () => void } | undefined>((resolve) => {
        let outstanding = targets.length;
        let done = false;
        const settle = (value: { target: ModelTarget; release: () => void } | undefined): void => {
          if (done) return;
          done = true;
          resolve(value);
        };

        for (const target of targets) {
          void this.acquire(pool, target, controller.signal).then(
            (release) => {
              if (done) {
                release();
                return;
              }
              controller.abort();
              settle({ target, release });
            },
            () => {
              outstanding -= 1;
              if (outstanding === 0) settle(undefined);
            },
          );
        }
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

/** `pool@endpoint` — the unit both the claim counter and the lane semaphore key on. */
function laneKey(pool: string | undefined, endpointId: string): string {
  return `${pool ?? DEFAULT_POOL}@${endpointId}`;
}
