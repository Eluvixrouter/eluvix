import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Eluvix,
  RouterConfig,
  UpstreamConfig,
  invalidateUserCache,
  addMemoryItem,
  clearUserMemories
} from '../index.js';

/**
 * Security remediation Tier 3 — identity & cache integrity.
 *
 * H-2: scope.userId must be proven-identity-only. The client-supplied
 * body field request.user used to select the cache/memory partition, so
 * any caller could read/write another user's partition by naming them.
 * H-3: the cache key must ALWAYS carry the identity partition.
 * M-9: the key must also capture the routing context (upstream set,
 * system-prompt prepend, egress/strip state) — a body produced under
 * one context must never be replayed under another.
 * M-10: invalidateUserCache drops one user's partition on demand.
 * D4: unscoped calls keep caching, in the explicit 'default' partition.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const LOCAL: UpstreamConfig = {
  id: 'local-engine',
  name: 'Local Engine',
  type: 'openai-compatible',
  endpoint: 'http://127.0.0.1:11434/v1',
  priority: 10,
  models: ['test-model', '*'],
  costPer1kTokens: 0
};

const CLOUD: UpstreamConfig = {
  id: 'cloud-engine',
  name: 'Cloud Engine',
  type: 'openai-compatible',
  endpoint: 'https://api.example.com/v1',
  priority: 100,
  models: ['test-model', '*'],
  costPer1kTokens: 0
};

function cachingConfig(upstreams: UpstreamConfig[], extra: Partial<RouterConfig> = {}): RouterConfig {
  return {
    strategy: 'cost-complexity',
    modelGateway: { caching: { enabled: true, ttlSeconds: 3600 } },
    upstreams,
    ...extra
  };
}

/** Fetch mock that answers per-host and records calls + bodies. */
function hostFetch(calls: { local: number; cloud: number; bodies: Array<{ host: string; body: any }> }) {
  return vi.fn().mockImplementation(async (url: any, opts: any) => {
    const u = String(url);
    const isLocal = u.includes('127.0.0.1');
    if (isLocal) calls.local++;
    else calls.cloud++;
    let body: any = null;
    try {
      body = opts?.body ? JSON.parse(opts.body) : null;
    } catch {}
    calls.bodies.push({ host: isLocal ? 'local' : 'cloud', body });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: isLocal ? 'local-answer' : 'cloud-answer' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  });
}

function newCalls() {
  return { local: 0, cloud: 0, bodies: [] as Array<{ host: string; body: any }> };
}

describe('H-2: request.user can no longer spoof a cache/memory partition', () => {
  it('a body.user naming the victim does NOT hit the victim’s cached entry', async () => {
    const calls = newCalls();
    globalThis.fetch = hostFetch(calls);
    const router = new Eluvix(cachingConfig([CLOUD]));
    const messages = [{ role: 'user', content: 'partition probe' }];

    // Victim (proven scope) populates their partition.
    const victim = await router.routeChatCompletion(
      { model: 'test-model', messages },
      { scope: { userId: 'victim' } }
    );
    expect(victim.headers.get('X-Eluvix-Cache')).not.toBe('HIT');
    expect(calls.cloud).toBe(1);

    // Attacker: no proven scope, but body.user names the victim.
    // Pre-fix this was a HIT on the victim's entry; post-fix it lands
    // in the 'default' partition and must fetch.
    const spoof = await router.routeChatCompletion({ model: 'test-model', messages, user: 'victim' });
    expect(spoof.headers.get('X-Eluvix-Cache')).not.toBe('HIT');
    expect(calls.cloud).toBe(2);

    // The victim's own repeat still hits their partition.
    const victimRepeat = await router.routeChatCompletion(
      { model: 'test-model', messages },
      { scope: { userId: 'victim' } }
    );
    expect(victimRepeat.headers.get('X-Eluvix-Cache')).toBe('HIT');
    expect(calls.cloud).toBe(2);

    // And the unscoped repeat hits the 'default' partition entry the
    // spoof attempt created (D4: partitioned, not disabled).
    const unscopedRepeat = await router.routeChatCompletion({ model: 'test-model', messages });
    expect(unscopedRepeat.headers.get('X-Eluvix-Cache')).toBe('HIT');
    expect(calls.cloud).toBe(2);
  });
});

describe('H-3: the cache key always carries the identity partition', () => {
  it('partitions scoped and unscoped callers from each other', async () => {
    const calls = newCalls();
    globalThis.fetch = hostFetch(calls);
    const router = new Eluvix(cachingConfig([CLOUD]));
    const messages = [{ role: 'user', content: 'who am i' }];

    await router.routeChatCompletion({ model: 'test-model', messages }, { scope: { userId: 'alice' } });
    await router.routeChatCompletion({ model: 'test-model', messages }, { scope: { userId: 'bob' } });
    await router.routeChatCompletion({ model: 'test-model', messages });
    expect(calls.cloud).toBe(3);

    // Each repeat hits only its own partition.
    for (const scope of [{ userId: 'alice' }, { userId: 'bob' }, undefined]) {
      const res = await router.routeChatCompletion(
        { model: 'test-model', messages },
        scope ? { scope } : undefined
      );
      expect(res.headers.get('X-Eluvix-Cache')).toBe('HIT');
    }
    expect(calls.cloud).toBe(3);

    // White-box: every stored key is versioned and partition-prefixed.
    const keys = [...(router as any).responseCache.keys()] as string[];
    expect(keys).toHaveLength(3);
    expect(keys.every(k => k.startsWith('v2:'))).toBe(true);
    expect(keys.some(k => k.startsWith('v2:alice:'))).toBe(true);
    expect(keys.some(k => k.startsWith('v2:bob:'))).toBe(true);
    expect(keys.some(k => k.startsWith('v2:default:'))).toBe(true);
  });
});

describe('M-9: the cache key captures routing context', () => {
  it('a systemPromptPrepend change misses instead of replaying the old context’s answer', async () => {
    const calls = newCalls();
    globalThis.fetch = hostFetch(calls);
    const router = new Eluvix(
      cachingConfig([CLOUD], {
        modelGateway: {
          caching: { enabled: true, ttlSeconds: 3600 },
          systemPromptPrepend: 'Alpha prepend.'
        }
      })
    );
    const messages = [{ role: 'user', content: 'prepend probe' }];

    await router.routeChatCompletion({ model: 'test-model', messages });
    const hit = await router.routeChatCompletion({ model: 'test-model', messages });
    expect(hit.headers.get('X-Eluvix-Cache')).toBe('HIT');
    expect(calls.cloud).toBe(1);

    // Same instance, new prepend (config objects are live references —
    // exactly the drift the old key could not see, since the cache check
    // ran before the prepend was even applied).
    (router as any).config.modelGateway.systemPromptPrepend = 'Beta prepend.';
    const miss = await router.routeChatCompletion({ model: 'test-model', messages });
    expect(miss.headers.get('X-Eluvix-Cache')).not.toBe('HIT');
    expect(calls.cloud).toBe(2);
  });

  it('an egressPolicy change (upstream set shrinks) misses', async () => {
    const calls = newCalls();
    globalThis.fetch = hostFetch(calls);
    const router = new Eluvix(cachingConfig([LOCAL, CLOUD]));
    const messages = [{ role: 'user', content: 'egress probe' }];
    const scope = { scope: { userId: 'alice' } };

    await router.routeChatCompletion({ model: 'test-model', messages }, scope);
    const hit = await router.routeChatCompletion({ model: 'test-model', messages }, scope);
    expect(hit.headers.get('X-Eluvix-Cache')).toBe('HIT');
    const fetchesBefore = calls.local + calls.cloud;

    (router as any).config.egressPolicy = 'local-only';
    const miss = await router.routeChatCompletion({ model: 'test-model', messages }, scope);
    expect(miss.headers.get('X-Eluvix-Cache')).not.toBe('HIT');
    expect(calls.local + calls.cloud).toBe(fetchesBefore + 1);
    // And under local-only the serving upstream must be the local one.
    expect(calls.local).toBeGreaterThan(0);
  });

  it('a memory strip-context change misses: stripped cloud answer is not replayed when the context becomes local-only (filter)', async () => {
    const user = `t3-strip-${Date.now()}`;
    addMemoryItem({
      userId: user,
      content: 'My secret launch codename is AURORA-FALLS.'
    });
    const calls = newCalls();
    globalThis.fetch = hostFetch(calls);
    const router = new Eluvix(
      cachingConfig([LOCAL, CLOUD], {
        memory: {
          enabled: true,
          provider: 'builtin',
          writeBack: false,
          allowCloudEgress: false,
          cloudMode: 'strip'
        }
      })
    );
    const messages = [{ role: 'user', content: 'What is my secret launch codename?' }];
    const scope = { scope: { userId: user } };

    try {
      // Strip mode: the cloud upstream (ranked first) serves, and what it
      // receives must NOT contain the recalled memory.
      const first = await router.routeChatCompletion({ model: 'auto', messages }, scope);
      const firstData = await first.json();
      expect(firstData.choices[0].message.content).toBe('cloud-answer');
      expect(calls.cloud).toBe(1);
      const cloudBody = JSON.stringify(calls.bodies.find(b => b.host === 'cloud')?.body ?? {});
      expect(cloudBody).not.toContain('AURORA-FALLS');

      const repeat = await router.routeChatCompletion({ model: 'auto', messages }, scope);
      expect(repeat.headers.get('X-Eluvix-Cache')).toBe('HIT');
      expect(calls.cloud).toBe(1);

      // Switch to filter mode: non-local upstreams leave the candidate
      // set, so the routing context changed — the stripped-context
      // answer must not be replayed; the local engine serves with the
      // memory intact.
      (router as any).config.memory.cloudMode = 'filter';
      const after = await router.routeChatCompletion({ model: 'auto', messages }, scope);
      expect(after.headers.get('X-Eluvix-Cache')).not.toBe('HIT');
      const afterData = await after.json();
      expect(afterData.choices[0].message.content).toBe('local-answer');
      const localBody = JSON.stringify(calls.bodies.find(b => b.host === 'local')?.body ?? {});
      expect(localBody).toContain('AURORA-FALLS');
    } finally {
      clearUserMemories(user);
    }
  });
});

describe('M-10: invalidateUserCache drops exactly one partition', () => {
  it('exported invalidateUserCache removes the user’s entries; other partitions keep hitting', async () => {
    const calls = newCalls();
    globalThis.fetch = hostFetch(calls);
    const router = new Eluvix(cachingConfig([CLOUD]));
    const user = `inv-${Date.now()}`;
    const messages = [{ role: 'user', content: 'invalidate me' }];

    await router.routeChatCompletion({ model: 'test-model', messages }, { scope: { userId: user } });
    await router.routeChatCompletion({ model: 'test-model', messages }, { scope: { userId: 'bob' } });
    expect(calls.cloud).toBe(2);

    const removed = invalidateUserCache(user);
    expect(removed).toBe(1);

    // The invalidated user's repeat must fetch again…
    const miss = await router.routeChatCompletion(
      { model: 'test-model', messages },
      { scope: { userId: user } }
    );
    expect(miss.headers.get('X-Eluvix-Cache')).not.toBe('HIT');
    expect(calls.cloud).toBe(3);

    // …while bob's entry is untouched.
    const bobHit = await router.routeChatCompletion(
      { model: 'test-model', messages },
      { scope: { userId: 'bob' } }
    );
    expect(bobHit.headers.get('X-Eluvix-Cache')).toBe('HIT');
    expect(calls.cloud).toBe(3);

    // The instance method behaves the same for its own map.
    expect(router.invalidateUserCache('bob')).toBe(1);
    const bobMiss = await router.routeChatCompletion(
      { model: 'test-model', messages },
      { scope: { userId: 'bob' } }
    );
    expect(bobMiss.headers.get('X-Eluvix-Cache')).not.toBe('HIT');
  });
});
