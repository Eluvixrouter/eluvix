import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
  Eluvix,
  listMemoryItems,
  clearUserMemories,
} from '../index.js';

/**
 * Hunt-2 suspect S-C2: the observability health ping is a routeChatCompletion
 * call with the fixed message "Eluvix health ping". routeChatCompletion
 * performs memory write-back for any call when memory is enabled, so the
 * probe exchange used to land in memory — originally the shared 'default'
 * partition (L-C4, fixed by scoping the ping to its caller), and even after
 * that fix it still polluted the caller's own recall. The fix is the
 * skipMemoryWriteBack option, which the ping now passes. These tests pin
 * both halves: write-back happens by default, and the flag suppresses it.
 */

function startMockServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        handler(req, body, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function waitForMemory(userId: string, needle: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = listMemoryItems(userId, 50);
    if (items.some((i) => (i.content || '').includes(needle))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('S-C2: health-ping memory write-back', () => {
  const users: string[] = [];

  function freshUser(): string {
    const u = `sc2-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    users.push(u);
    return u;
  }

  afterEach(() => {
    for (const u of users.splice(0)) clearUserMemories(u);
  });

  it('writes a ping-shaped turn back to memory by default', async () => {
    const userId = freshUser();
    const mockUpstream = await startMockServer((_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-ping',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong: router healthy' } }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        })
      );
    });

    try {
      const router = new Eluvix({
        memory: { enabled: true, provider: 'builtin', recallBudgetTokens: 500, writeBack: true },
        upstreams: [
          {
            id: 'mock-ollama',
            name: 'Mock',
            type: 'ollama',
            endpoint: mockUpstream.url,
            priority: 10,
            models: ['*'],
          },
        ],
      });

      const res = await router.routeChatCompletion(
        { model: 'auto', messages: [{ role: 'user', content: 'Eluvix health ping' }] },
        { scope: { userId } }
      );
      expect(res.status).toBe(200);

      // remember() is fire-and-forget: poll until the exchange lands.
      expect(await waitForMemory(userId, 'Eluvix health ping')).toBe(true);
    } finally {
      await mockUpstream.close();
    }
  });

  it('does not write back when skipMemoryWriteBack is set', async () => {
    const userId = freshUser();
    const mockUpstream = await startMockServer((_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-ping',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong: router healthy' } }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        })
      );
    });

    try {
      const router = new Eluvix({
        memory: { enabled: true, provider: 'builtin', recallBudgetTokens: 500, writeBack: true },
        upstreams: [
          {
            id: 'mock-ollama',
            name: 'Mock',
            type: 'ollama',
            endpoint: mockUpstream.url,
            priority: 10,
            models: ['*'],
          },
        ],
      });

      const res = await router.routeChatCompletion(
        { model: 'auto', messages: [{ role: 'user', content: 'Eluvix health ping' }] },
        { scope: { userId }, skipMemoryWriteBack: true }
      );
      expect(res.status).toBe(200);

      // Give any stray async write-back time to land, then assert nothing did.
      await new Promise((r) => setTimeout(r, 500));
      expect(listMemoryItems(userId, 50)).toHaveLength(0);
    } finally {
      await mockUpstream.close();
    }
  });
});
