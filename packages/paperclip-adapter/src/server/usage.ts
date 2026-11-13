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

export async function fetchEluvixUsageForRun(opts: {
  baseUrl: string;
  apiKey: string;
  runId: string;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<EluvixRunUsageResponse | null> {
  const fetchFn = opts.fetchImpl || globalThis.fetch;
  if (!fetchFn) return null;
  const base = opts.baseUrl.replace(/\/$/, '');
  try {
    const res = await fetchFn(
      `${base}/api/v1/paperclip/usage/${encodeURIComponent(opts.runId)}`,
      {
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
        },
      }
    );
    if (!res.ok) return null;
    return (await res.json()) as EluvixRunUsageResponse;
  } catch {
    return null;
  }
}
