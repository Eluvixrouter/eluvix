import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Eluvix, RouterConfig, UpstreamConfig } from '../index.js';
import { fetchWithSafeRedirects, assertEndpointNotMetadata } from '../fetch-policy.js';
import { getProviderSettings } from '../db.js';

// Mock DB interactions (same pattern as hunt-t2 / switchyard tests)
vi.mock('../db.js', () => ({
  logRequest: vi.fn(),
  getRequestLogs: vi.fn().mockReturnValue([]),
  getProviderSettings: vi.fn().mockReturnValue(null)
}));

const mockedGetProviderSettings = vi.mocked(getProviderSettings);

interface StubServer {
  origin: string;
  hits: number;
  lastFinalMethod?: string;
  lastFinalBody?: string;
  close: () => Promise<void>;
}

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, stub: StubServer) => void
): Promise<StubServer> {
  return new Promise((resolve) => {
    const stub: StubServer = {
      origin: '',
      hits: 0,
      close: () =>
        new Promise<void>((done) => {
          (server as any).closeAllConnections?.();
          server.close(() => done());
        })
    };
    const server = http.createServer((req, res) => {
      stub.hits++;
      handler(req, res, stub);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      stub.origin = `http://127.0.0.1:${port}`;
      resolve(stub);
    });
  });
}

function completionJson(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

let target: StubServer; // the "internal service" a redirect would bounce to
let crossRedirector: StubServer; // upstream that 307s everything cross-origin
let sameOrigin: StubServer; // upstream that redirects within itself

beforeAll(async () => {
  target = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(completionJson('TARGET-REACHED'));
  });

  crossRedirector = await startServer((_req, res) => {
    res.writeHead(307, { Location: `${target.origin}/v1/chat/completions` });
    res.end();
  });

  sameOrigin = await startServer((req, res, stub) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(307, { Location: '/v1/final' });
      res.end();
      return;
    }
    if (req.url === '/post302') {
      res.writeHead(302, { Location: '/v1/final' });
      res.end();
      return;
    }
    if (req.url === '/hop1') {
      res.writeHead(307, { Location: '/hop2' });
      res.end();
      return;
    }
    if (req.url === '/hop2') {
      res.writeHead(307, { Location: '/hop1' });
      res.end();
      return;
    }
    if (req.url === '/v1/final') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        stub.lastFinalMethod = req.method;
        stub.lastFinalBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(completionJson('same-origin-ok'));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

afterAll(async () => {
  await Promise.all([target.close(), crossRedirector.close(), sameOrigin.close()]);
});

afterEach(() => {
  target.hits = 0;
  mockedGetProviderSettings.mockReturnValue(null);
  vi.restoreAllMocks();
});

function routerWith(endpoint: string): Eluvix {
  const upstream: UpstreamConfig = {
    id: 'stub-upstream',
    name: 'Stub Upstream',
    type: 'openai-compatible',
    endpoint,
    priority: 10,
    models: ['test-model']
  };
  const config: RouterConfig = { strategy: 'cost-complexity', upstreams: [upstream] };
  return new Eluvix(config);
}

describe('M-8: chat forwarding refuses cross-origin redirects', () => {
  it('a 307 to a different origin is refused and the target is never contacted', async () => {
    const router = routerWith(crossRedirector.origin);
    await expect(
      router.routeChatCompletion({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }]
      })
    ).rejects.toThrow(/All upstreams failed/);
    expect(target.hits).toBe(0);
  }, 20000);

  it('a same-origin 307 is still followed and the completion succeeds', async () => {
    const router = routerWith(sameOrigin.origin);
    const res = await router.routeChatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }]
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('same-origin-ok');
    // 307 preserves the POST (and its body) across the hop
    expect(sameOrigin.lastFinalMethod).toBe('POST');
    expect(sameOrigin.lastFinalBody).toContain('test-model');
  }, 20000);
});

describe('M-8: fetchWithSafeRedirects policy', () => {
  it('refuses a cross-origin redirect with a clear error and never contacts the target', async () => {
    await expect(
      fetchWithSafeRedirects(`${crossRedirector.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'x-api-key': 'secret' },
        body: JSON.stringify({ model: 'test-model' })
      })
    ).rejects.toThrow(/cross-origin redirect/i);
    expect(target.hits).toBe(0);
  });

  it('follows same-origin redirects up to the bound, then refuses the loop', async () => {
    await expect(fetchWithSafeRedirects(`${sameOrigin.origin}/hop1`)).rejects.toThrow(
      /too many redirects/i
    );
  });

  it('converts a POST to GET without a body on a 302 (fetch-spec method rewriting)', async () => {
    const res = await fetchWithSafeRedirects(`${sameOrigin.origin}/post302`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'body' })
    });
    expect(res.status).toBe(200);
    expect(sameOrigin.lastFinalMethod).toBe('GET');
    expect(sameOrigin.lastFinalBody).toBe('');
  });

  it('passes non-redirect responses through untouched', async () => {
    const res = await fetchWithSafeRedirects(`${target.origin}/v1/models`);
    expect(res.status).toBe(200);
    expect(target.hits).toBe(1);
  });

  it('falls back to a plain fetch for an unparseable URL instead of throwing on URL parsing', async () => {
    // Rebase regression: hunt-2 A tests use synthetic endpoints such as
    // http://localhost:11434-stub-m1 (non-numeric port), which new URL()
    // rejects. The helper is a drop-in for fetch, so it must not fail
    // before fetch itself gets a say.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'stub-ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    try {
      const res = await fetchWithSafeRedirects('http://localhost:11434-stub-m1/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'test-model' }),
      });
      expect(res.status).toBe(200);
      expect((globalThis.fetch as any).mock.calls[0][0]).toBe(
        'http://localhost:11434-stub-m1/v1/chat/completions'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('S-2: model detection refuses metadata / link-local targets', () => {
  it('blocks the cloud metadata IP literal', async () => {
    await expect(
      assertEndpointNotMetadata('http://169.254.169.254/latest/meta-data/')
    ).rejects.toThrow(/Refusing to probe/);
  });

  it('blocks metadata.google.internal by name', async () => {
    await expect(
      assertEndpointNotMetadata('http://metadata.google.internal/computeMetadata/v1/')
    ).rejects.toThrow(/Refusing to probe/);
  });

  it('allows loopback literals the operator typed (probing local servers is the feature)', async () => {
    await expect(assertEndpointNotMetadata('http://127.0.0.1:11434/api/tags')).resolves.toBeUndefined();
    await expect(assertEndpointNotMetadata('http://localhost:11434/api/tags')).resolves.toBeUndefined();
  });

  it('detectUpstreamModelDetails refuses a metadata endpoint before any fetch', async () => {
    const { detectUpstreamModelDetails } = await import('../index.js');
    const upstream: UpstreamConfig = {
      id: 'meta',
      name: 'Meta',
      type: 'openai-compatible',
      endpoint: 'http://169.254.169.254',
      priority: 1,
      models: []
    };
    await expect(detectUpstreamModelDetails(upstream, 500)).rejects.toThrow(/Refusing to probe/);
  }, 60000);
});

describe('M-7: local-only egress exceptions are named loudly at startup (D9: warn, not block)', () => {
  function localOnlyConfig(memoryEndpoint: string): RouterConfig {
    return {
      strategy: 'cost-complexity',
      egressPolicy: 'local-only',
      memory: { enabled: true, provider: 'mem0', endpoint: memoryEndpoint },
      upstreams: [
        {
          id: 'local',
          name: 'Local',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 10,
          models: ['test-model']
        }
      ]
    };
  }

  it('warns about both a non-local memory endpoint and an enabled non-local provider agent', () => {
    mockedGetProviderSettings.mockReturnValue({
      enabled: 1,
      server_url: 'https://api.billama.dev'
    } as any);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Eluvix(localOnlyConfig('https://mem0.example.com'));
    const warnings = warnSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(warnings).toContain('egressPolicy=local-only');
    expect(warnings).toContain('memory provider');
    expect(warnings).toContain('provider agent');
  });

  it('stays quiet when every exception channel is local', () => {
    mockedGetProviderSettings.mockReturnValue({
      enabled: 1,
      server_url: 'http://127.0.0.1:9000'
    } as any);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Eluvix(localOnlyConfig('http://127.0.0.1:8888'));
    const warnings = warnSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(warnings).not.toContain('egressPolicy=local-only');
  });

  it('stays quiet when the policy is not local-only', () => {
    mockedGetProviderSettings.mockReturnValue({
      enabled: 1,
      server_url: 'https://api.billama.dev'
    } as any);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = localOnlyConfig('https://mem0.example.com');
    delete config.egressPolicy;
    new Eluvix(config);
    const warnings = warnSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(warnings).not.toContain('egressPolicy=local-only');
  });
});
