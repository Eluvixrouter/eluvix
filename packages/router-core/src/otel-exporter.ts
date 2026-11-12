/**
 * Dependency-light OpenTelemetry (`OTLP/HTTP JSON` + Langfuse) Trace Exporter
 * with OpenTelemetry `gen_ai.*` and `eluvix.*` semantic conventions.
 *
 * IMPORTANT: Keep ZERO `node:*` imports in this module so browser/client bundles
 * can safely import types and payload builders from `@eluvix/router-core/otel-exporter`.
 */

import { applyPrivacyGuard } from './guard.js';
import { validateUpstreamHttpEndpoint } from './ssrf-guard.js';

export interface ObservabilityExporterConfig {
  enabled?: boolean;
  projectName?: string;
  exporter?: 'sqlite' | 'otlp' | 'langfuse' | 'prometheus';
  otlpEndpoint?: string;
  headers?: Record<string, string>;
  langfusePublicKey?: string;
  langfuseSecretKey?: string;
  samplingRate?: number;
  captureInputs?: boolean;
  scrubPii?: boolean;
  latencyAlertMs?: number;
  maxQueueSize?: number;
}

export interface OtelChildSpanInput {
  spanId?: string;
  name: string;
  kind?: 'SERVER' | 'CLIENT' | 'INTERNAL';
  startTimeMs: number;
  endTimeMs: number;
  status?: 'OK' | 'ERROR';
  errorMessage?: string;
  attributes?: Record<string, string | number | boolean | undefined>;
}

export interface OtelRootSpanInput extends OtelChildSpanInput {
  traceId?: string;
  parentSpanId?: string;
  children?: OtelChildSpanInput[];
}

function randomHex(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLen; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateTraceId(): string {
  return randomHex(16); // 32 hex chars (128-bit)
}

export function generateSpanId(): string {
  return randomHex(8); // 16 hex chars (64-bit)
}

function msToUnixNanoString(ms: number): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : Date.now();
  return `${safeMs}000000`;
}

function encodeBase64Ascii(raw: string): string {
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(raw);
  }
  const B = (globalThis as any).Buffer;
  if (B && typeof B.from === 'function') {
    return B.from(raw, 'utf8').toString('base64');
  }
  return raw;
}

function scrubTraceString(value: string, shouldScrub: boolean): string {
  if (!shouldScrub || !value) return value;
  const res = applyPrivacyGuard([{ role: 'user', content: value }], {
    enabled: true,
    action: 'anonymize',
    redactionStyle: 'token',
    auditLogging: false,
  });
  const mod = res.modifiedMessages[0]?.content;
  return typeof mod === 'string' ? mod : value;
}

function toOtlpAttribute(
  key: string,
  rawVal: string | number | boolean,
  shouldScrub: boolean
): Record<string, any> {
  if (typeof rawVal === 'boolean') {
    return { key, value: { boolValue: rawVal } };
  }
  if (typeof rawVal === 'number') {
    if (Number.isInteger(rawVal)) {
      return { key, value: { intValue: String(rawVal) } };
    }
    return { key, value: { doubleValue: rawVal } };
  }
  const strVal =
    key === 'gen_ai.prompt' || key === 'gen_ai.completion' || key.endsWith('.input') || key.endsWith('.output')
      ? scrubTraceString(String(rawVal), shouldScrub)
      : String(rawVal);
  return { key, value: { stringValue: strVal } };
}

function mapSpanKind(kind?: 'SERVER' | 'CLIENT' | 'INTERNAL'): number {
  if (kind === 'SERVER') return 2;
  if (kind === 'CLIENT') return 3;
  return 1; // SPAN_KIND_INTERNAL
}

/**
 * Builds an OpenTelemetry OTLP/HTTP JSON `ExportTraceServiceRequest` payload
 * with `gen_ai.*` and `eluvix.*` semantic conventions for a root request span
 * and its child spans (`guard`, `routing`, `upstream`, `memory`, `tools`).
 */
export function buildOtlpTracePayload(
  rootSpan: OtelRootSpanInput,
  config: ObservabilityExporterConfig = {}
): {
  traceId: string;
  rootSpanId: string;
  payload: Record<string, any>;
} {
  const traceId =
    typeof rootSpan.traceId === 'string' && /^[0-9a-f]{32}$/i.test(rootSpan.traceId)
      ? rootSpan.traceId.toLowerCase()
      : generateTraceId();
  const rootSpanId =
    typeof rootSpan.spanId === 'string' && /^[0-9a-f]{16}$/i.test(rootSpan.spanId)
      ? rootSpan.spanId.toLowerCase()
      : generateSpanId();

  const shouldScrub = config.scrubPii !== false;
  const serviceName = config.projectName || 'eluvix-gateway';

  const formatSpan = (
    span: OtelChildSpanInput,
    spanId: string,
    parentSpanId?: string
  ): Record<string, any> => {
    const attrs: Array<Record<string, any>> = [];
    for (const [k, v] of Object.entries(span.attributes || {})) {
      if (v === undefined || v === null) continue;
      if (
        !config.captureInputs &&
        (k === 'gen_ai.prompt' || k === 'gen_ai.completion')
      ) {
        continue;
      }
      attrs.push(toOtlpAttribute(k, v, shouldScrub));
    }

    return {
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: span.name,
      kind: mapSpanKind(span.kind),
      startTimeUnixNano: msToUnixNanoString(span.startTimeMs),
      endTimeUnixNano: msToUnixNanoString(Math.max(span.startTimeMs, span.endTimeMs)),
      attributes: attrs,
      status: {
        code: span.status === 'ERROR' ? 2 : 1,
        ...(span.errorMessage ? { message: span.errorMessage } : {}),
      },
    };
  };

  const spans: Array<Record<string, any>> = [
    formatSpan(rootSpan, rootSpanId, rootSpan.parentSpanId),
  ];

  for (const child of rootSpan.children || []) {
    const childId =
      typeof child.spanId === 'string' && /^[0-9a-f]{16}$/i.test(child.spanId)
        ? child.spanId.toLowerCase()
        : generateSpanId();
    spans.push(formatSpan(child, childId, rootSpanId));
  }

  return {
    traceId,
    rootSpanId,
    payload: {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: serviceName } },
              { key: 'telemetry.sdk.name', value: { stringValue: 'eluvix-otel-exporter' } },
              { key: 'telemetry.sdk.language', value: { stringValue: 'typescript' } },
            ],
          },
          scopeSpans: [
            {
              scope: {
                name: '@eluvix/router-core',
                version: '1.2.0',
              },
              spans,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Resolves the target OTLP HTTP endpoint and headers for either generic OTLP
 * collectors (`http://localhost:4318/v1/traces`) or Langfuse (`/api/public/otel/v1/traces`).
 */
export function resolveOtlpEndpointAndHeaders(
  config: ObservabilityExporterConfig
): { endpoint: string | null; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.headers || {}),
  };

  if (config.langfusePublicKey && config.langfuseSecretKey && !headers['Authorization']) {
    headers['Authorization'] = `Basic ${encodeBase64Ascii(
      `${config.langfusePublicKey}:${config.langfuseSecretKey}`
    )}`;
  }

  let rawEndpoint = (config.otlpEndpoint || '').trim();
  if (!rawEndpoint) {
    if (config.exporter === 'otlp') {
      rawEndpoint = 'http://127.0.0.1:4318/v1/traces';
    } else if (config.exporter === 'langfuse') {
      rawEndpoint = 'https://cloud.langfuse.com/api/public/otel/v1/traces';
    } else {
      return { endpoint: null, headers };
    }
  }

  if (config.exporter === 'langfuse' && !rawEndpoint.includes('/v1/traces')) {
    rawEndpoint = `${rawEndpoint.replace(/\/+$/, '')}/api/public/otel/v1/traces`;
  } else if (config.exporter === 'otlp' && !rawEndpoint.endsWith('/v1/traces')) {
    rawEndpoint = `${rawEndpoint.replace(/\/+$/, '')}/v1/traces`;
  }

  return { endpoint: rawEndpoint, headers };
}

/**
 * Bounded, non-blocking OTLP/HTTP JSON trace exporter with drop-on-overflow queue
 * and SSRF endpoint validation.
 */
export class OtlpTraceExporter {
  private queue: Array<Record<string, any>> = [];
  private droppedSpansCount = 0;
  private exportedBatchesCount = 0;

  constructor(private config: ObservabilityExporterConfig = {}) {}

  public updateConfig(config: ObservabilityExporterConfig): void {
    this.config = config;
  }

  public getStats(): {
    queued: number;
    droppedSpansCount: number;
    exportedBatchesCount: number;
  } {
    return {
      queued: this.queue.length,
      droppedSpansCount: this.droppedSpansCount,
      exportedBatchesCount: this.exportedBatchesCount,
    };
  }

  public shouldSample(randomVal = Math.random()): boolean {
    if (!this.config) return false;
    const isActiveExporter =
      this.config.enabled !== false &&
      (this.config.exporter === 'otlp' ||
        this.config.exporter === 'langfuse' ||
        Boolean(this.config.otlpEndpoint));
    if (!isActiveExporter) return false;
    const rate = Math.max(0, Math.min(100, this.config.samplingRate ?? 100));
    if (rate <= 0) return false;
    if (rate >= 100) return true;
    return randomVal * 100 < rate;
  }

  public enqueueTrace(rootSpan: OtelRootSpanInput): {
    enqueued: boolean;
    traceId: string;
    rootSpanId: string;
  } {
    const built = buildOtlpTracePayload(rootSpan, this.config);
    if (!this.shouldSample()) {
      return { enqueued: false, traceId: built.traceId, rootSpanId: built.rootSpanId };
    }

    const maxQueue = Math.max(1, this.config.maxQueueSize ?? 512);
    if (this.queue.length >= maxQueue) {
      this.droppedSpansCount += 1 + (rootSpan.children?.length || 0);
      return { enqueued: false, traceId: built.traceId, rootSpanId: built.rootSpanId };
    }

    this.queue.push(built.payload);
    return { enqueued: true, traceId: built.traceId, rootSpanId: built.rootSpanId };
  }

  public async flush(
    fetchImpl: typeof fetch = globalThis.fetch
  ): Promise<{ sent: number; ok: boolean; error?: string }> {
    if (this.queue.length === 0) {
      return { sent: 0, ok: true };
    }

    const { endpoint, headers } = resolveOtlpEndpointAndHeaders(this.config);
    if (!endpoint) {
      this.queue.length = 0;
      return { sent: 0, ok: true };
    }

    const ssrfCheck = validateUpstreamHttpEndpoint(endpoint, { allowLoopbackAndLan: true });
    if (!ssrfCheck.ok) {
      this.droppedSpansCount += this.queue.length;
      this.queue.length = 0;
      return { sent: 0, ok: false, error: ssrfCheck.reason || 'Blocked unsafe OTLP endpoint' };
    }

    const batch = this.queue.splice(0, this.queue.length);
    const mergedSpans: Array<Record<string, any>> = [];
    for (const item of batch) {
      const spans = item?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans;
      if (Array.isArray(spans)) mergedSpans.push(...spans);
    }

    const mergedPayload = {
      ...(batch[0] || {}),
      resourceSpans: [
        {
          ...(batch[0]?.resourceSpans?.[0] || {}),
          scopeSpans: [
            {
              ...(batch[0]?.resourceSpans?.[0]?.scopeSpans?.[0] || {
                scope: { name: '@eluvix/router-core', version: '1.2.0' },
              }),
              spans: mergedSpans,
            },
          ],
        },
      ],
    };

    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(mergedPayload),
      });
      if (!res.ok) {
        return { sent: 0, ok: false, error: `OTLP collector returned HTTP ${res.status}` };
      }
      this.exportedBatchesCount += 1;
      return { sent: mergedSpans.length, ok: true };
    } catch (err: any) {
      return { sent: 0, ok: false, error: err?.message || 'OTLP export failed' };
    }
  }
}
