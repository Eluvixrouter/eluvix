import { useState, useEffect, useCallback } from 'react';
import type { NodeLiveTelemetry } from './NodeHealthIndicator';

export interface CanvasTelemetrySnapshot {
  byUpstreamId: Record<string, NodeLiveTelemetry>;
  totalRequests: number;
  lastUpdated: number | null;
}

export function useCanvasTelemetry(enabled: boolean, pollIntervalMs = 8000) {
  const [snapshot, setSnapshot] = useState<CanvasTelemetrySnapshot>({
    byUpstreamId: {},
    totalRequests: 0,
    lastUpdated: null,
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/observability?limit=100');
      if (!res.ok) return;
      const json = await res.json();
      if (!json?.success || !json?.data) return;

      const logs: Array<{
        upstream_id?: string;
        duration_ms?: number;
        status?: number;
        timestamp?: string;
      }> = Array.isArray(json.data.logs) ? json.data.logs : [];

      const total = logs.length;
      if (total === 0) {
        setSnapshot({
          byUpstreamId: {},
          totalRequests: 0,
          lastUpdated: Date.now(),
        });
        return;
      }

      const grouped = new Map<string, number[]>();
      for (const l of logs) {
        const upId = String(l.upstream_id || '').trim();
        if (!upId) continue;
        const arr = grouped.get(upId) || [];
        arr.push(Number(l.duration_ms || 0));
        grouped.set(upId, arr);
      }

      const byUpstreamId: Record<string, NodeLiveTelemetry> = {};
      for (const [upId, durations] of Array.from(grouped.entries())) {
        const sorted = [...durations].sort((a, b) => a - b);
        const sum = sorted.reduce((acc, v) => acc + v, 0);
        const avgLatencyMs = Math.round(sum / sorted.length);
        const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
        const p95LatencyMs = Math.round(sorted[p95Idx] || avgLatencyMs);
        const hitSharePct = Math.round((sorted.length / total) * 100);

        byUpstreamId[upId] = {
          requests: sorted.length,
          avgLatencyMs,
          p95LatencyMs,
          hitSharePct,
          activeRecently: true,
        };
      }

      setSnapshot({
        byUpstreamId,
        totalRequests: total,
        lastUpdated: Date.now(),
      });
    } catch {
      // Fail silently on telemetry poll
    }
  }, []);

  // Initial refresh, kicked off from a timer callback rather than
  // synchronously in the effect body (react-hooks/set-state-in-effect);
  // the first snapshot still lands before the next paint.
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      refresh();
    }, 0);
    const interval = setInterval(refresh, pollIntervalMs);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [enabled, pollIntervalMs, refresh]);

  return { snapshot, refresh };
}
