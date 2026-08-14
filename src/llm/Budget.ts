import type { CostConfig } from '../config/schema.js';
import { BudgetExceededError } from '../shared/errors.js';
import type { TokenUsage } from './types.js';

export interface BudgetSnapshot {
  requests: number;
  totalTokens: number;
  costUsd: number;
  exceeded: boolean;
  /** Which limit tripped, if any. */
  reason?: string;
}

/**
 * Run-wide spending guard. Checked before every call and updated after every
 * response, so a misconfigured pool or a runaway retry loop cannot quietly burn
 * a budget across a thousand documents.
 */
export class BudgetGuard {
  private requests = 0;
  private totalTokens = 0;
  private costUsd = 0;
  private trippedReason: string | undefined;

  constructor(
    private readonly config: CostConfig,
    private readonly onWarn?: (reason: string) => void,
  ) {}

  /** Throws when the budget is spent and `onExceeded` is `stop`. */
  assertAvailable(): void {
    const reason = this.exceededReason();
    if (!reason) return;

    if (this.config.onExceeded === 'stop') {
      throw new BudgetExceededError(`Run budget exceeded: ${reason}`, { details: { ...this.snapshot() } });
    }
    if (this.trippedReason !== reason) {
      this.trippedReason = reason;
      this.onWarn?.(reason);
    }
  }

  record(usage: TokenUsage, costUsd: number): void {
    this.requests += 1;
    this.totalTokens += usage.totalTokens;
    this.costUsd += costUsd;
  }

  snapshot(): BudgetSnapshot {
    const reason = this.exceededReason();
    return {
      requests: this.requests,
      totalTokens: this.totalTokens,
      costUsd: Number(this.costUsd.toFixed(6)),
      exceeded: reason !== undefined,
      reason,
    };
  }

  private exceededReason(): string | undefined {
    const { maxRequests, maxTotalTokens, maxCostUsd } = this.config.budget;
    if (maxRequests > 0 && this.requests >= maxRequests) {
      return `${this.requests}/${maxRequests} requests`;
    }
    if (maxTotalTokens > 0 && this.totalTokens >= maxTotalTokens) {
      return `${this.totalTokens}/${maxTotalTokens} tokens`;
    }
    if (maxCostUsd > 0 && this.costUsd >= maxCostUsd) {
      return `$${this.costUsd.toFixed(4)}/$${maxCostUsd.toFixed(2)}`;
    }
    return undefined;
  }
}
