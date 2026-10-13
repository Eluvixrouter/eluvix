import { NextResponse } from 'next/server';
import { getRequestLogs, getDb } from '@eluvix/router-core';
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

async function checkUpstreamHealth(upstream: any): Promise<UpstreamHealth> {
  const start = Date.now();
  const models = (upstream.models || []).filter((m: string) => m !== '*');

  if (upstream.type === 'antigravity' || upstream.endpoint?.startsWith('cli://')) {
    const cliPath = upstream.antigravity?.cliPath || 'agy';
    const isAvailable = await new Promise<boolean>((resolve) => {
      let resolved = false;
      const child = spawn(cliPath, ['--version'], { stdio: 'ignore' });
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { child.kill(); } catch {}
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

    // Model and Upstream distributions
    const modelDistribution: Record<string, number> = {};
    const upstreamDistribution: Record<string, number> = {};

    rawLogs.forEach(l => {
      const model = l.model || 'unknown';
      const upstreamId = l.upstream_id || 'unknown';
      modelDistribution[model] = (modelDistribution[model] || 0) + 1;
      upstreamDistribution[upstreamId] = (upstreamDistribution[upstreamId] || 0) + 1;
    });

    // Local cost savings calculation ($0.005 estimated per local completion vs commercial cloud API)
    const localRequestsCount = rawLogs.filter(l => {
      const up = (l.upstream_id || '').toLowerCase();
      return (
        up.includes('ollama') ||
        up.includes('vllm') ||
        up.includes('lemonade') ||
        up.includes('switchyard')
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
