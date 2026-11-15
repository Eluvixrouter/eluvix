export interface EluvixRunUsageResponse {
  runId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  requests: number;
  dominantModel?: string;
  byModel: Array<{
    model: string;
    upstreamId: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    requests: number;
  }>;
}

function usageSignature(u: EluvixRunUsageResponse): string {
  return `${u.requests ?? 0}|${u.inputTokens}|${u.outputTokens}|${u.cachedInputTokens}|${u.cacheWriteTokens}|${u.costUsd}|${u.byModel?.length ?? 0}`;
}

function hasUsageActivity(u: EluvixRunUsageResponse): boolean {
  return (
    Number(u.requests || 0) > 0 ||
    Number(u.inputTokens || 0) > 0 ||
    Number(u.outputTokens || 0) > 0 ||
    Number(u.costUsd || 0) > 0 ||
    (Array.isArray(u.byModel) && u.byModel.length > 0)
  );
}

export async function fetchEluvixUsageForRun(opts: {
  baseUrl: string;
  apiKey: string;
  runId: string;
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxSettleWaitMs?: number;
}): Promise<EluvixRunUsageResponse | null> {
  const fetchFn = opts.fetchImpl || globalThis.fetch;
  if (!fetchFn) return null;
  const base = opts.baseUrl.replace(/\/$/, '');
  const endpoint = `${base}/api/v1/paperclip/usage/${encodeURIComponent(opts.runId)}`;
  const pollIntervalMs = Math.max(0, opts.pollIntervalMs ?? 100);
  const maxSettleWaitMs = Math.max(0, opts.maxSettleWaitMs ?? 1500);

  const readOnce = async (): Promise<EluvixRunUsageResponse | null> => {
    try {
      const res = await fetchFn(endpoint, {
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
        },
        signal: opts.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as EluvixRunUsageResponse;
    } catch {
      return null;
    }
  };

  let prev = await readOnce();
  if (!prev || maxSettleWaitMs === 0) return prev;

  const deadline = Date.now() + maxSettleWaitMs;
  while (Date.now() < deadline && !opts.signal?.aborted) {
    if (pollIntervalMs > 0) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    if (opts.signal?.aborted) break;
    const next = await readOnce();
    if (!next) return prev;
    if (usageSignature(next) === usageSignature(prev) && hasUsageActivity(next)) {
      return next;
    }
    // Also settle if zero-request run confirmed twice consecutively after an attempt
    if (usageSignature(next) === usageSignature(prev) && Date.now() + pollIntervalMs >= deadline) {
      return next;
    }
    prev = next;
  }

  return prev;
}
