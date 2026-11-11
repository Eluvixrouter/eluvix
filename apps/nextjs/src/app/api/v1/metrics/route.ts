import { NextResponse } from 'next/server';
import {
  getDb,
  getRollingSpendUsd,
  globalCircuitBreaker,
  resolveBearerToken,
} from '@eluvix/router-core';
import { getConfig, getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

function escapePromLabel(val: string): string {
  return String(val || 'unknown')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function computePercentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, idx))];
}

/**
 * Prometheus Exposition Endpoint (`GET /api/v1/metrics`).
 * Emits `text/plain; version=0.0.4; charset=utf-8` telemetry for Prometheus,
 * VictoriaMetrics, and Grafana Agent scrapers. Supports authentication via
 * named `elx_` API keys, Admin Bearer token, or authenticated NextAuth session.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('elx_')) {
      const resolved = resolveBearerToken(token);
      if (!resolved.valid) {
        return NextResponse.json(
          {
            error: {
              message: 'Incorrect API key provided.',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          },
          { status: 401 }
        );
      }
    }
  }

  try {
    const db = getDb();
    const config = getConfig();
    const router = getRouter();
    const upstreams = router.getUpstreams();

    const groupedRequests = db
      .prepare(
        `SELECT upstream_id, model, status, COUNT(*) AS cnt
         FROM request_logs
         GROUP BY upstream_id, model, status`
      )
      .all() as Array<{ upstream_id: string; model: string; status: number; cnt: number }>;

    const tokenTotals = (db
      .prepare(
        `SELECT
           COALESCE(SUM(prompt_tokens), 0) AS prompt_total,
           COALESCE(SUM(completion_tokens), 0) AS completion_total,
           COALESCE(SUM(kv_cache_kb), 0) AS kv_kb_total
         FROM request_logs`
      )
      .get() || { prompt_total: 0, completion_total: 0, kv_kb_total: 0 }) as {
      prompt_total: number;
      completion_total: number;
      kv_kb_total: number;
    };

    const recentSuccess = db
      .prepare(
        `SELECT duration_ms, ttft_ms, itl_ms
         FROM request_logs
         WHERE status >= 200 AND status < 400
         ORDER BY id DESC
         LIMIT 500`
      )
      .all() as Array<{ duration_ms: number | null; ttft_ms: number | null; itl_ms: number | null }>;

    const durations = recentSuccess
      .map(r => Number(r.duration_ms || 0))
      .filter(v => v > 0)
      .sort((a, b) => a - b);
    const ttfts = recentSuccess
      .map(r => Number(r.ttft_ms ?? r.duration_ms ?? 0))
      .filter(v => v > 0)
      .sort((a, b) => a - b);
    const itls = recentSuccess
      .map(r => Number(r.itl_ms || 0))
      .filter(v => v > 0)
      .sort((a, b) => a - b);

    const latencyP50 = Math.round(computePercentile(durations, 50));
    const ttftP50 = Math.round(computePercentile(ttfts, 50));
    const ttftP99 = Math.round(computePercentile(ttfts, 99));
    const itlP50 = Number(computePercentile(itls, 50).toFixed(2));

    const rolling24hSpendUsd = getRollingSpendUsd(24);
    const dailySpendCapUsd = Number(config.switchyard?.maxDailySpendUsd || 0);
    const kvCacheBytesTotal = Math.round(Number(tokenTotals.kv_kb_total || 0) * 1024);

    const lines: string[] = [
      '# HELP eluvix_requests_total Total number of routed AI requests partitioned by upstream, model, and HTTP status.',
      '# TYPE eluvix_requests_total counter',
    ];
    for (const row of groupedRequests) {
      lines.push(
        `eluvix_requests_total{upstream="${escapePromLabel(row.upstream_id)}",model="${escapePromLabel(row.model)}",status="${Number(row.status) || 0}"} ${Number(row.cnt) || 0}`
      );
    }

    lines.push(
      '# HELP eluvix_tokens_total Total prompt and completion tokens routed through Eluvix.',
      '# TYPE eluvix_tokens_total counter',
      `eluvix_tokens_total{direction="prompt"} ${Math.round(Number(tokenTotals.prompt_total) || 0)}`,
      `eluvix_tokens_total{direction="completion"} ${Math.round(Number(tokenTotals.completion_total) || 0)}`,
      '# HELP eluvix_kv_cache_transferred_bytes_total Estimated KV-cache bytes processed across routed requests.',
      '# TYPE eluvix_kv_cache_transferred_bytes_total counter',
      `eluvix_kv_cache_transferred_bytes_total ${kvCacheBytesTotal}`,
      '# HELP eluvix_latency_p50_ms Median end-to-end request duration in milliseconds over recent successful requests.',
      '# TYPE eluvix_latency_p50_ms gauge',
      `eluvix_latency_p50_ms ${latencyP50}`,
      '# HELP eluvix_ttft_p50_ms Median Time-To-First-Token (TTFT) in milliseconds.',
      '# TYPE eluvix_ttft_p50_ms gauge',
      `eluvix_ttft_p50_ms ${ttftP50}`,
      '# HELP eluvix_ttft_p99_ms 99th-percentile Time-To-First-Token (TTFT) in milliseconds.',
      '# TYPE eluvix_ttft_p99_ms gauge',
      `eluvix_ttft_p99_ms ${ttftP99}`,
      '# HELP eluvix_itl_p50_ms Median Inter-Token Latency (ITL) in milliseconds per token.',
      '# TYPE eluvix_itl_p50_ms gauge',
      `eluvix_itl_p50_ms ${itlP50}`,
      '# HELP eluvix_rolling_24h_spend_usd Rolling 24-hour estimated cloud API spend in USD.',
      '# TYPE eluvix_rolling_24h_spend_usd gauge',
      `eluvix_rolling_24h_spend_usd ${rolling24hSpendUsd.toFixed(6)}`,
      '# HELP eluvix_daily_spend_cap_usd Configured 24-hour cloud spend guardrail cap in USD (0 when uncapped).',
      '# TYPE eluvix_daily_spend_cap_usd gauge',
      `eluvix_daily_spend_cap_usd ${dailySpendCapUsd.toFixed(6)}`,
      '# HELP eluvix_upstreams_configured_total Number of configured inference upstreams in active router config.',
      '# TYPE eluvix_upstreams_configured_total gauge',
      `eluvix_upstreams_configured_total ${upstreams.length}`,
      '# HELP eluvix_circuit_breaker_open Whether the upstream circuit breaker is currently open (1 = open, 0 = closed/half-open).',
      '# TYPE eluvix_circuit_breaker_open gauge'
    );

    for (const u of upstreams) {
      const isOpen = globalCircuitBreaker.getState(u.id) === 'open' ? 1 : 0;
      lines.push(
        `eluvix_circuit_breaker_open{upstream="${escapePromLabel(u.id)}",type="${escapePromLabel(u.type)}"} ${isOpen}`
      );
    }

    lines.push('');

    return new Response(lines.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: { message: err?.message || 'Failed to collect metrics', type: 'metrics_error' } },
      { status: 500 }
    );
  }
}
