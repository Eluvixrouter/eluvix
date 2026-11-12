import crypto from 'node:crypto';
import { getDb } from './db.js';
import { validateUpstreamHttpEndpoint } from './ssrf-guard.js';

export type AlertWebhookEventType =
  | 'budget.threshold'
  | 'circuit.opened'
  | 'audit.tamper_detected'
  | 'guard.blocked'
  | 'batch.completed'
  | '*';

export type AlertWebhookProvider = 'json' | 'slack' | 'discord' | 'ntfy';

export interface AlertWebhookRecord {
  id: string;
  userId: string;
  name: string;
  url: string;
  provider: AlertWebhookProvider;
  hasSecret: boolean;
  events: AlertWebhookEventType[];
  enabled: boolean;
  lastStatus: number | null;
  lastTriggeredAt: string | null;
  createdAt: string;
}

export interface AlertWebhookPayload {
  id: string;
  event: AlertWebhookEventType;
  timestamp: string;
  severity: 'info' | 'warning' | 'critical';
  summary: string;
  data: Record<string, any>;
}

/**
 * Computes the `X-Eluvix-Signature` HMAC-SHA256 header (`sha256=<hex>`) for a raw JSON body.
 */
export function computeWebhookHmacSignature(rawBody: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return `sha256=${hmac}`;
}

/**
 * Formats an alert event into provider-specific JSON (`slack`, `discord`, `ntfy`, or `json`).
 */
export function formatAlertWebhookBody(
  provider: AlertWebhookProvider,
  payload: AlertWebhookPayload
): Record<string, any> {
  if (provider === 'slack') {
    return {
      text: `*[Eluvix ${payload.severity.toUpperCase()}]* \`${payload.event}\` — ${payload.summary}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*[Eluvix ${payload.severity.toUpperCase()}]* \`${payload.event}\`\n${payload.summary}`,
          },
        },
      ],
    };
  }
  if (provider === 'discord') {
    return {
      content: `**[Eluvix ${payload.severity.toUpperCase()}]** \`${payload.event}\` — ${payload.summary}`,
    };
  }
  if (provider === 'ntfy') {
    return {
      topic: 'eluvix-alerts',
      title: `Eluvix Alert: ${payload.event}`,
      message: payload.summary,
      priority: payload.severity === 'critical' ? 5 : payload.severity === 'warning' ? 4 : 3,
      tags: ['eluvix', payload.event],
    };
  }
  return payload;
}

function rowToWebhookRecord(row: Record<string, any>): AlertWebhookRecord {
  let events: AlertWebhookEventType[] = ['*'];
  try {
    const parsed = JSON.parse(row.events_json || '["*"]');
    if (Array.isArray(parsed) && parsed.length > 0) events = parsed;
  } catch {}
  return {
    id: String(row.id),
    userId: String(row.user_id || 'default'),
    name: String(row.name),
    url: String(row.url),
    provider: (row.provider || 'json') as AlertWebhookProvider,
    hasSecret: Boolean(row.secret && String(row.secret).length > 0),
    events,
    enabled: Boolean(row.enabled),
    lastStatus: typeof row.last_status === 'number' ? Number(row.last_status) : null,
    lastTriggeredAt: row.last_triggered_at ? String(row.last_triggered_at) : null,
    createdAt: String(row.created_at),
  };
}

export function registerAlertWebhook(input: {
  name: string;
  url: string;
  provider?: AlertWebhookProvider;
  secret?: string;
  events?: AlertWebhookEventType[];
  enabled?: boolean;
  userId?: string;
  allowLoopbackAndLan?: boolean;
}): AlertWebhookRecord {
  const ssrf = validateUpstreamHttpEndpoint(input.url, {
    allowLoopbackAndLan: input.allowLoopbackAndLan ?? true,
  });
  if (!ssrf.ok) {
    throw new Error(ssrf.reason || `Invalid or blocked webhook URL: ${input.url}`);
  }

  const db = getDb();
  const id = `wh_${crypto.randomBytes(7).toString('hex')}`;
  const userId = (input.userId || 'default').trim() || 'default';
  const name = (input.name || 'Alert Webhook').trim();
  const provider: AlertWebhookProvider = input.provider || 'json';
  const events: AlertWebhookEventType[] =
    Array.isArray(input.events) && input.events.length > 0 ? input.events : ['*'];
  const enabled = input.enabled !== false ? 1 : 0;
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO alert_webhooks (id, user_id, name, url, provider, secret, events_json, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    name,
    input.url.trim(),
    provider,
    input.secret?.trim() || null,
    JSON.stringify(events),
    enabled,
    createdAt
  );

  const row = db.prepare('SELECT * FROM alert_webhooks WHERE id = ?').get(id) as Record<string, any>;
  return rowToWebhookRecord(row);
}

export function listAlertWebhooks(userId = 'default'): AlertWebhookRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM alert_webhooks WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as Array<Record<string, any>>;
  return rows.map(rowToWebhookRecord);
}

export function deleteAlertWebhook(id: string, userId = 'default'): boolean {
  const db = getDb();
  const info = db
    .prepare('DELETE FROM alert_webhooks WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return Number(info?.changes || 0) > 0;
}

/**
 * Dispatches an alert event to all subscribed webhooks with HMAC-SHA256 signing,
 * SSRF validation, and single retry on 5xx errors.
 */
export async function dispatchAlertWebhooks(
  event: {
    event: AlertWebhookEventType;
    severity?: 'info' | 'warning' | 'critical';
    summary: string;
    data?: Record<string, any>;
    userId?: string;
  },
  options?: {
    fetchImpl?: typeof fetch;
    allowLoopbackAndLan?: boolean;
  }
): Promise<{ delivered: number; failed: number }> {
  const db = getDb();
  const rows = (
    event.userId
      ? db.prepare('SELECT * FROM alert_webhooks WHERE enabled = 1 AND user_id = ?').all(event.userId)
      : db.prepare('SELECT * FROM alert_webhooks WHERE enabled = 1').all()
  ) as Array<Record<string, any>>;

  const fetchFn = options?.fetchImpl || globalThis.fetch;
  let delivered = 0;
  let failed = 0;

  const alertPayload: AlertWebhookPayload = {
    id: `evt_${crypto.randomBytes(7).toString('hex')}`,
    event: event.event,
    timestamp: new Date().toISOString(),
    severity: event.severity || 'warning',
    summary: event.summary,
    data: event.data || {},
  };

  for (const row of rows) {
    let subscribed: string[] = ['*'];
    try {
      subscribed = JSON.parse(row.events_json || '["*"]');
    } catch {}
    if (!subscribed.includes('*') && !subscribed.includes(event.event)) {
      continue;
    }

    const url = String(row.url);
    const ssrf = validateUpstreamHttpEndpoint(url, {
      allowLoopbackAndLan: options?.allowLoopbackAndLan ?? true,
    });
    if (!ssrf.ok) {
      failed += 1;
      continue;
    }

    const provider = (row.provider || 'json') as AlertWebhookProvider;
    const bodyObj = formatAlertWebhookBody(provider, alertPayload);
    const rawBody = JSON.stringify(bodyObj);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Eluvix-Event': event.event,
      'X-Eluvix-Delivery': alertPayload.id,
    };
    if (row.secret && String(row.secret).length > 0) {
      headers['X-Eluvix-Signature'] = computeWebhookHmacSignature(rawBody, String(row.secret));
    }

    let status = 0;
    let ok = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers,
          body: rawBody,
          signal: AbortSignal.timeout(4000),
        });
        status = res.status;
        if (res.ok) {
          ok = true;
          break;
        }
        if (res.status < 500) break; // Do not retry 4xx
      } catch {
        status = 0;
      }
    }

    try {
      db.prepare(
        'UPDATE alert_webhooks SET last_status = ?, last_triggered_at = ? WHERE id = ?'
      ).run(status, alertPayload.timestamp, row.id);
    } catch {}

    if (ok) delivered += 1;
    else failed += 1;
  }

  return { delivered, failed };
}
