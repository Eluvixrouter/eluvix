export interface FallbackChainConfig {
  id: string;
  name?: string;
  primaryUpstreamId?: string;
  secondaryUpstreamId?: string;
  tertiaryUpstreamId?: string;
  orderedUpstreamIds: string[];
  failureThreshold?: number;
  cooldownSeconds?: number;
  retryOn429?: boolean;
}

interface CircuitEntry {
  consecutiveFailures: number;
  openedAt: number | null;
}

export class CircuitBreakerRegistry {
  private states = new Map<string, CircuitEntry>();

  public isAllowed(upstreamId: string, failureThreshold = 3, cooldownSeconds = 60): boolean {
    const entry = this.states.get(upstreamId);
    if (!entry || entry.openedAt === null) return true;
    const elapsedSec = (Date.now() - entry.openedAt) / 1000;
    if (elapsedSec >= cooldownSeconds) {
      // Half-open: allow probe request
      return true;
    }
    return entry.consecutiveFailures < failureThreshold;
  }

  public recordSuccess(upstreamId: string): void {
    this.states.delete(upstreamId);
  }

  public recordFailure(upstreamId: string, failureThreshold = 3): void {
    const prev = this.states.get(upstreamId) || { consecutiveFailures: 0, openedAt: null };
    const nextCount = prev.consecutiveFailures + 1;
    this.states.set(upstreamId, {
      consecutiveFailures: nextCount,
      openedAt: nextCount >= failureThreshold ? Date.now() : prev.openedAt
    });
  }

  public getState(
    upstreamId: string,
    failureThreshold = 3,
    cooldownSeconds = 60
  ): 'closed' | 'open' | 'half-open' {
    const entry = this.states.get(upstreamId);
    if (!entry || entry.openedAt === null || entry.consecutiveFailures < failureThreshold) {
      return 'closed';
    }
    const elapsedSec = (Date.now() - entry.openedAt) / 1000;
    return elapsedSec >= cooldownSeconds ? 'half-open' : 'open';
  }

  public reset(): void {
    this.states.clear();
  }
}

export const globalCircuitBreaker = new CircuitBreakerRegistry();
