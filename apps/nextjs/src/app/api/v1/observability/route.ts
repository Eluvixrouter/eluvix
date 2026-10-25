import { NextResponse } from 'next/server';
import { getRequestLogs, getDb, getCachedAntigravityModels } from '@eluvix/router-core';
import { getRouter } from '@/lib/router';
import { spawn } from 'node:child_process';

export const dynamic = 'force-dynamic';

interface UpstreamHealth {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  status: 'online' | 'offline' | 'degraded';
  latencyMs: number;
  modelsCount: number;
  models: string[];
}

import { normalizeProbeUrl } from '@/lib/api-helpers';

let agyHealthCache: { isAvailable: boolean; timestamp: number } | null = null;
const AGY_HEALTH_TTL_MS = 10000;

async function checkUpstreamHealth(upstream: any): Promise<UpstreamHealth> {
  const start = Date.now();
  const rawModels = (upstream.models || []).filter((m: string) => m !== '*');

  if (upstream.type === 'antigravity' || upstream.endpoint?.startsWith('cli://')) {
    const agyBaseIds = getCachedAntigravityModels().map(m => m.baseId);
    const models = Array.from(new Set([...rawModels, ...agyBaseIds]));
    const cliPath = upstream.antigravity?.cliPath || 'agy';
    let isAvailable = false;

    if (agyHealthCache && (Date.now() - agyHealthCache.timestamp < AGY_HEALTH_TTL_MS)) {
      isAvailable = agyHealthCache.isAvailable;
    } else {
      isAvailable = await new Promise<boolean>((resolve) => {
        let resolved = false;
        const child = spawn(cliPath, ['--version'], { stdio: 'ignore' });
        const timeoutId = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            try { child.kill('SIGTERM'); } catch {}
            resolve(false);
          }
        }, 1000);

        child.on('error', () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            resolve(false);
          }
        });
        child.on('close', (code) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            resolve(code === 0);
          }
        });
      });
      agyHealthCache = { isAvailable, timestamp: Date.now() };
    }

    const latencyMs = Date.now() - start;
    return {
      id: upstream.id,
      name: upstream.name,
      type: upstream.type,
      endpoint: upstream.endpoint,
      status: isAvailable ? 'online' : 'offline',
      latencyMs: isAvailable ? latencyMs : 0,
      modelsCount: models.length,
      models,
    };
  }

  const models = rawModels;
  if (upstream.endpoint?.startsWith('http')) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200);

      // Probe health endpoint or root using normalized probe URL
      const probeUrl = normalizeProbeUrl(upstream.endpoint, upstream.type);

      const res = await fetch(probeUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: upstream.apiKey ? { Authorization: `Bearer ${upstream.apiKey}` } : {},
      });
      clearTimeout(timeoutId);

      const latencyMs = Date.now() - start;
      return {
        id: upstream.id,
        name: upstream.name,
        type: upstream.type,
        endpoint: upstream.endpoint,
        status: res.ok ? 'online' : 'degraded',
        latencyMs,
        modelsCount: models.length,
        models,
      };
    } catch {
      return {
        id: upstream.id,
        name: upstream.name,
        type: upstream.type,
        endpoint: upstream.endpoint,
        status: 'offline',
        latencyMs: 0,
        modelsCount: models.length,
        models,
      };
    }
  }

  return {
    id: upstream.id,
    name: upstream.name,
    type: upstream.type,
    endpoint: upstream.endpoint || 'unknown',
    status: 'online',
    latencyMs: 5,
    modelsCount: models.length,
    models,
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const filterStatus = searchParams.get('status');
    const filterModel = searchParams.get('model');

    const rawLogs = getRequestLogs(limit);
    const router = getRouter();
    const upstreams = router.getUpstreams();

    // Check upstream health in parallel
    const upstreamsHealth = await Promise.all(upstreams.map(u => checkUpstreamHealth(u)));

    // Filter logs if requested
    let logs = rawLogs;
    if (filterStatus === 'success') {
      logs = logs.filter(l => l.status >= 200 && l.status < 400);
    } else if (filterStatus === 'error') {
      logs = logs.filter(l => l.status >= 400);
    }
    if (filterModel) {
      logs = logs.filter(l => l.model.toLowerCase().includes(filterModel.toLowerCase()));
    }

    // Compute Summary Metrics
    const totalRequests = rawLogs.length;
    const successLogs = rawLogs.filter(l => l.status >= 200 && l.status < 400);
    const errorLogs = rawLogs.filter(l => l.status >= 400);
    const successCount = successLogs.length;
    const errorCount = errorLogs.length;
    const successRate = totalRequests > 0 ? Math.round((successCount / totalRequests) * 100) : 100;

    const avgLatencyMs = totalRequests > 0
      ? Math.round(rawLogs.reduce((acc, l) => acc + (l.duration_ms || 0), 0) / totalRequests)
      : 0;

    const promptTokens = rawLogs.reduce((acc, l) => acc + (l.prompt_tokens || 0), 0);
    const completionTokens = rawLogs.reduce((acc, l) => acc + (l.completion_tokens || 0), 0);
    const totalTokens = promptTokens + completionTokens;

    // Disaggregated Serving Latency Percentiles (Prefill TTFT & Decode ITL)
    const ttftValues = successLogs.map(l => l.ttft_ms ?? l.duration_ms).filter((v): v is number => typeof v === 'number' && v > 0).sort((a, b) => a - b);
    const itlValues = successLogs.map(l => l.itl_ms).filter((v): v is number => typeof v === 'number' && v > 0).sort((a, b) => a - b);

    const percentile = (arr: number[], p: number): number => {
      if (arr.length === 0) return 0;
      const index = Math.ceil((p / 100) * arr.length) - 1;
      return Math.round(arr[Math.max(0, Math.min(arr.length - 1, index))]);
    };

    const p50TtftMs = percentile(ttftValues, 50);
    const p99TtftMs = percentile(ttftValues, 99);
    const p50ItlMs = Number((itlValues.length > 0 ? (percentile(itlValues.map(v => Math.round(v * 10)), 50) / 10) : 0).toFixed(1));
    const p99ItlMs = Number((itlValues.length > 0 ? (percentile(itlValues.map(v => Math.round(v * 10)), 99) / 10) : 0).toFixed(1));

    // SLA criteria: TTFT < 1500ms and ITL < 30ms/tok
    const slaMetCount = successLogs.filter(l => {
      const ttft = l.ttft_ms ?? l.duration_ms;
      const itl = l.itl_ms ?? (l.completion_tokens && l.completion_tokens > 0 ? l.duration_ms / l.completion_tokens : 20);
      return ttft <= 1500 && itl <= 30;
    }).length;
    const slaGoodputPct = successCount > 0 ? Math.round((slaMetCount / successCount) * 100) : 100;

    const totalKvTransferredMb = Number(
      (rawLogs.reduce((acc, l) => acc + (l.kv_cache_kb || 0), 0) / 1024).toFixed(2)
    );

    // Model and Upstream distributions
    const modelDistribution: Record<string, number> = {};
    const upstreamDistribution: Record<string, number> = {};

    rawLogs.forEach(l => {
      const model = l.model || 'unknown';
      const upstreamId = l.upstream_id || 'unknown';
      modelDistribution[model] = (modelDistribution[model] || 0) + 1;
      upstreamDistribution[upstreamId] = (upstreamDistribution[upstreamId] || 0) + 1;
    });

    // Local cost savings calculation ($0.005 estimated per successful local completion vs commercial cloud API)
    const localRequestsCount = successLogs.filter(l => {
      const up = (l.upstream_id || '').toLowerCase();
      return (
        up.includes('ollama') ||
        up.includes('vllm') ||
        up.includes('sglang') ||
        up.includes('lemonade') ||
        up.includes('switchyard') ||
        up.includes('antigravity')
      );
    }).length;
    const estimatedSavings = (localRequestsCount * 0.005).toFixed(3);

    return NextResponse.json({
      success: true,
      data: {
        summary: {
          totalRequests,
          successCount,
          errorCount,
          successRate,
          avgLatencyMs,
          promptTokens,
          completionTokens,
          totalTokens,
          estimatedSavings,
          p50TtftMs,
          p99TtftMs,
          p50ItlMs,
          p99ItlMs,
          slaGoodputPct,
          totalKvTransferredMb,
          activeUpstreamsCount: upstreamsHealth.filter(u => u.status === 'online').length,
          totalUpstreamsCount: upstreamsHealth.length,
        },
        modelDistribution,
        upstreamDistribution,
        upstreams: upstreamsHealth,
        logs,
      }
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const db = getDb();
    db.exec('DELETE FROM request_logs;');
    return NextResponse.json({ success: true, message: 'All request logs have been purged.' });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST() {
  try {
    const router = getRouter();
    const startTime = Date.now();

    const response = await router.routeChatCompletion({
      model: 'auto',
      messages: [{ role: 'user', content: 'Eluvix health ping' }],
    }, {
      // Internal admin health probe: explicitly the 'default' partition.
      scope: { userId: 'default' }
    });

    const durationMs = Date.now() - startTime;
    const status = response.status;
    const upstreamId = response.headers.get('x-eluvix-upstream') || 'router-auto';

    return NextResponse.json({
      success: true,
      message: 'Test ping executed successfully.',
      durationMs,
      status,
      upstreamId,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
