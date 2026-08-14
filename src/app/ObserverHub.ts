import type { AttemptRecord, GatewayCallOptions, GatewayObserver } from '../llm/LlmGateway.js';

/**
 * Fan-out point for gateway events.
 *
 * The gateway is built once, at startup; the run store that consumes its events
 * only exists once a run begins. The hub lets listeners attach later without
 * making the gateway itself mutable or run-aware.
 */
export class ObserverHub implements GatewayObserver {
  private readonly listeners: GatewayObserver[] = [];

  add(listener: GatewayObserver): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  onAttempt(record: AttemptRecord, options: GatewayCallOptions): void {
    for (const listener of this.listeners) listener.onAttempt?.(record, options);
  }

  onRetry(info: { target: string; attempt: number; delayMs: number; kind: string; message: string }): void {
    for (const listener of this.listeners) listener.onRetry?.(info);
  }

  onFallback(info: { from: string; to: string; kind: string; message: string }): void {
    for (const listener of this.listeners) listener.onFallback?.(info);
  }
}
