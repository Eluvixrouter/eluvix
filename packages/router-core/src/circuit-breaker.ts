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
  // Half-open probes in flight, with admission timestamps. Without this,
  // every concurrent request probes a recovering upstream at once.
  private probing = new Map<string, number>();

  public isAllowed(upstreamId: string, failureThreshold = 3, cooldownSeconds = 60): boolean {
    const entry = this.states.get(upstreamId);
    if (!entry || entry.openedAt === null) return true;
    const elapsedSec = (Date.now() - entry.openedAt) / 1000;
    if (elapsedSec >= cooldownSeconds) {
      // Half-open: admit a single probe. A probe already in flight (younger
      // than the cooldown window) blocks the rest; a stale probe entry —
      // e.g. a caller that never reported back — expires so the upstream
      // can never wedge in "probe already running" forever.
      const probeAt = this.probing.get(upstreamId);
      if (probeAt !== undefined && Date.now() - probeAt < cooldownSeconds * 1000) {
        return false;
      }
      this.probing.set(upstreamId, Date.now());
      return true;
    }
    return entry.consecutiveFailures < failureThreshold;
  }

  public recordSuccess(upstreamId: string): void {
    this.states.delete(upstreamId);
    this.probing.delete(upstreamId);
  }

  public recordFailure(upstreamId: string, failureThreshold = 3): void {
    this.probing.delete(upstreamId);
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
    this.probing.clear();
  }
}

export const globalCircuitBreaker = new CircuitBreakerRegistry();
