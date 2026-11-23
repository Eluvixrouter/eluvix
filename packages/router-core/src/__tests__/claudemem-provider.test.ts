import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import {
  ClaudeMemContextProvider,
  CLAUDEMEM_TARGET_VERSION,
  claudeMemProjectForUser,
  resolveClaudeMemEndpoint,
  createContextProvider
} from '../index.js';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function startStubServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void
): Promise<{
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({
          method: req.method || '',
          url: req.url || '',
          headers: req.headers,
          body
        });
        handler(req, body, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r()))
      });
    });
  });
}

function searchPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    observations: [
      {
        id: 42,
        memory_session_id: 'sess-1',
        project: 'eluvix:alice',
        text: 'Decided to use the write-only vault for backups.',
        type: 'decision',
        title: 'Vault decision',
        created_at: '2026-11-20T10:00:00.000Z',
        created_at_epoch: 1794000000,
        score: 0.91
      },
      {
        id: 43,
        memory_session_id: 'sess-1',
        project: 'eluvix:alice',
        text: null,
        narrative: 'Fixed the resilver by replacing the disk.',
        type: 'bugfix',
        title: null,
        created_at: '2026-11-21T10:00:00.000Z',
        created_at_epoch: 1794100000,
        score: 0.77
      }
    ],
    sessions: [
      {
        id: 7,
        memory_session_id: 'sess-1',
        project: 'eluvix:alice',
        request: 'audit the backup vault',
        learned: 'Object Lock compliance mode blocks deletes.',
        completed: 'Vault verified write-only.',
        created_at: '2026-11-21T11:00:00.000Z',
        created_at_epoch: 1794103600,
        score: 0.5
      }
    ],
    prompts: [],
    totalResults: 3,
    query: 'vault',
    ...overrides
  };
}

describe('ClaudeMemContextProvider (recall-only)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of ['CLAUDE_MEM_WORKER_ENDPOINT', 'CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_LOCAL_API_TOKEN']) {
    savedEnv[key] = process.env[key];
  }

  beforeEach(() => {
    for (const key of Object.keys(savedEnv)) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  it('maps claude-mem project keys per user', () => {
    expect(claudeMemProjectForUser('alice')).toBe('eluvix:alice');
    expect(claudeMemProjectForUser('')).toBe('eluvix:default');
  });

  it('resolves the default endpoint as 37700 + (uid % 100)', () => {
    const uid =
      typeof process.getuid === 'function' ? process.getuid() : null;
    const expected =
      uid === null ? 'http://127.0.0.1:37700' : `http://127.0.0.1:${37700 + (uid % 100)}`;
    expect(resolveClaudeMemEndpoint({})).toBe(expected);
  });

  it('prefers config endpoint, then CLAUDE_MEM_WORKER_ENDPOINT, then CLAUDE_MEM_WORKER_PORT', () => {
    process.env.CLAUDE_MEM_WORKER_ENDPOINT = 'http://127.0.0.1:37999';
    process.env.CLAUDE_MEM_WORKER_PORT = '37998';
    expect(resolveClaudeMemEndpoint({})).toBe('http://127.0.0.1:37999');
    expect(
      resolveClaudeMemEndpoint({ endpoint: 'http://127.0.0.1:37997' })
    ).toBe('http://127.0.0.1:37997');
    delete process.env.CLAUDE_MEM_WORKER_ENDPOINT;
    expect(resolveClaudeMemEndpoint({})).toBe('http://127.0.0.1:37998');
  });

  it('refuses a remote plaintext endpoint at construction', () => {
    expect(
      () => new ClaudeMemContextProvider({ endpoint: 'http://example.com:37700' })
    ).toThrow(/must use https/);
  });

  it('recall() scopes to eluvix:<userId> and maps rows to blocks', async () => {
    const stub = await startStubServer((_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(searchPayload()));
    });
    try {
      const provider = new ClaudeMemContextProvider({ endpoint: stub.url });
      const result = await provider.recall(
        'vault',
        { userId: 'alice', origin: 'client' },
        800
      );
      expect(result.provider).toBe('claudemem');
      expect(result.blocks).toHaveLength(3);
      // Observation: title leads, text follows; uri + score carried over.
      expect(result.blocks[0].text).toBe(
        'Vault decision\nDecided to use the write-only vault for backups.'
      );
      expect(result.blocks[0].uri).toBe('claudemem://observation/42');
      expect(result.blocks[0].score).toBe(0.91);
      // Observation with null text falls back to narrative.
      expect(result.blocks[1].text).toBe('Fixed the resilver by replacing the disk.');
      expect(result.blocks[1].uri).toBe('claudemem://observation/43');
      // Session summary: learned + completed.
      expect(result.blocks[2].text).toBe(
        'Object Lock compliance mode blocks deletes.\nVault verified write-only.'
      );
      expect(result.blocks[2].uri).toBe('claudemem://session/7');
      expect(result.tokenEstimate).toBeGreaterThan(0);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);

      const searchReq = stub.requests.find((r) => r.url.startsWith('/api/search'));
      expect(searchReq).toBeDefined();
      const url = new URL(`http://127.0.0.1${searchReq!.url}`);
      expect(url.searchParams.get('query')).toBe('vault');
      expect(url.searchParams.get('project')).toBe('eluvix:alice');
      expect(url.searchParams.get('format')).toBe('json');
      expect(url.searchParams.get('limit')).toBe('8');
    } finally {
      await stub.close();
    }
  });

  it('recall() drops foreign-project rows and keeps unattributed ones', async () => {
    const stub = await startStubServer((_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          searchPayload({
            observations: [
              {
                id: 1,
                project: 'eluvix:bob',
                text: 'Bob secret, must not leak to Alice.',
                type: 'decision',
                title: null,
                score: 0.99
              },
              {
                id: 2,
                text: 'No project field on this row.',
                type: 'discovery',
                title: null,
                score: 0.5
              }
            ],
            sessions: []
          })
        )
      );
    });
    try {
      const provider = new ClaudeMemContextProvider({ endpoint: stub.url });
      const result = await provider.recall(
        'secret',
        { userId: 'alice', origin: 'client' },
        800
      );
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].text).toBe('No project field on this row.');
    } finally {
      await stub.close();
    }
  });

  it('recall() returns empty blocks on an empty query without fetching', async () => {
    const stub = await startStubServer((_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(searchPayload()));
    });
    try {
      const provider = new ClaudeMemContextProvider({ endpoint: stub.url });
      const result = await provider.recall(
        '   ',
        { userId: 'alice', origin: 'client' },
        800
      );
      expect(result.blocks).toEqual([]);
      expect(stub.requests).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it('recall() throws on a worker error (fail-fast, like mem0)', async () => {
    const stub = await startStubServer((_req, _body, res) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'boom' }));
    });
    try {
      const provider = new ClaudeMemContextProvider({ endpoint: stub.url });
      await expect(
        provider.recall('vault', { userId: 'alice', origin: 'client' }, 800)
      ).rejects.toThrow(/HTTP 500/);
    } finally {
      await stub.close();
    }
  });

  it('recall() respects the token budget, slicing the first block when needed', async () => {
    const longText = 'x'.repeat(400);
    const stub = await startStubServer((_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          searchPayload({
            observations: [
              {
                id: 9,
                project: 'eluvix:alice',
                text: longText,
                type: 'decision',
                title: null,
                score: 1
              }
            ],
            sessions: []
          })
        )
      );
    });
    try {
      const provider = new ClaudeMemContextProvider({ endpoint: stub.url });
      // 400 chars ~= 100 tokens; budget 64 forces the slice path.
      const result = await provider.recall(
        'x',
        { userId: 'alice', origin: 'client' },
        64
      );
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].text.length).toBe(64 * 4);
      expect(result.tokenEstimate).toBeLessThanOrEqual(64);
    } finally {
      await stub.close();
    }
  });

  it('health() returns true on ok and does not warn on the target version', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = await startStubServer((_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ status: 'ok', version: CLAUDEMEM_TARGET_VERSION, pid: 1 })
      );
    });
    try {
      const provider = new ClaudeMemContextProvider({ endpoint: stub.url });
      expect(await provider.health()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await stub.close();
    }
  });

  it('health() warns on a version mismatch but still reports healthy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = await startStubServer((_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', version: '15.0.0', pid: 1 }));
    });
    try {
      const provider = new ClaudeMemContextProvider({ endpoint: stub.url });
      expect(await provider.health()).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('15.0.0')
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(CLAUDEMEM_TARGET_VERSION)
      );
    } finally {
      await stub.close();
    }
  });

  it('health() fails clearly when the worker is down, and logs the guidance once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No server listening on this port: connection refused.
    const provider = new ClaudeMemContextProvider({
      endpoint: 'http://127.0.0.1:59991'
    });
    expect(await provider.health()).toBe(false);
    expect(await provider.health()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('npx claude-mem install')
    );
  });

  it('sends X-Claude-Mem-Token only when a token is configured', async () => {
    const stub = await startStubServer((_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', version: CLAUDEMEM_TARGET_VERSION }));
    });
    try {
      const withoutToken = new ClaudeMemContextProvider({ endpoint: stub.url });
      expect(await withoutToken.health()).toBe(true);
      expect(stub.requests[0].headers['x-claude-mem-token']).toBeUndefined();

      const withConfigToken = new ClaudeMemContextProvider({
        endpoint: stub.url,
        apiKey: 'tok-from-config'
      });
      expect(await withConfigToken.health()).toBe(true);
      expect(stub.requests[1].headers['x-claude-mem-token']).toBe('tok-from-config');

      process.env.CLAUDE_MEM_LOCAL_API_TOKEN = 'tok-from-env';
      const withEnvToken = new ClaudeMemContextProvider({ endpoint: stub.url });
      expect(await withEnvToken.health()).toBe(true);
      expect(stub.requests[2].headers['x-claude-mem-token']).toBe('tok-from-env');
    } finally {
      await stub.close();
    }
  });

  it('remember() is a no-op: it never hits the worker', async () => {
    const stub = await startStubServer((_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
    });
    try {
      const provider = new ClaudeMemContextProvider({ endpoint: stub.url });
      await provider.remember(
        {
          user: { role: 'user', content: 'do not store this turn' },
          assistant: 'and not this reply either'
        },
        { userId: 'alice', origin: 'client' }
      );
      expect(stub.requests).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it('createContextProvider wires the claudemem provider', () => {
    const provider = createContextProvider({
      enabled: true,
      provider: 'claudemem',
      endpoint: 'http://127.0.0.1:37700'
    });
    expect(provider.id).toBe('claudemem');
    expect(provider).toBeInstanceOf(ClaudeMemContextProvider);
  });
});
