import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({
  default: { lookup: mockLookup },
}));

import { fetchWithPinnedDns, SsrfBlockedError } from '../api-helpers';
import { POST as toolsPost } from '../../app/api/v1/tools/route';

/**
 * Hunt-2 suspect S-C3: DNS-rebinding TOCTOU in the web scraper.
 * The old code checked the hostname (isBlockedHost + isBlockedDns, a
 * dns.lookup) and then called fetch(), which resolved the hostname a
 * second time. A DNS answer that flips between the two resolutions
 * (TTL-0 rebinding) could steer the connection to a loopback or cloud
 * metadata address the check just cleared.
 *
 * fetchWithPinnedDns resolves exactly once and pins the connection to the
 * validated addresses. These tests simulate the flip at the dns.lookup
 * layer: the first resolution returns 127.0.0.1, every later resolution
 * returns 127.0.0.2. A vulnerable implementation would follow the flip
 * to server B; the pinned fetch must still answer from server A, and must
 * call dns.lookup exactly once.
 *
 * Pinning mechanism note: the helper pins with `createConnection` —
 * connecting the socket to the validated IP literal — NOT with the
 * `lookup` request option, which `http.request` in Node 24.22.1 never
 * invokes (proven with a standalone script). The flip test above proves
 * the pin at the socket layer: the request lands on server A even though
 * any second resolution would return server B.
 *
 * Live end-to-end exploit note: a full DNS-flip landing could not be
 * demonstrated in this sandbox — fetch() here routes through the sandbox
 * HTTP proxy (whose resolver cannot be controlled), and the sandbox blocks
 * unconnected UDP sends, so a local fake DNS server cannot serve the
 * fetch's resolver. The check/fetch double-resolution itself was proven
 * live (the check issues its own DNS transactions, and consecutive
 * resolutions of one name returned different answers).
 */
describe('S-C3: DNS-pinned fetch', () => {
  let serverA: http.Server;
  let serverB: http.Server;
  let port: number;

  beforeAll(async () => {
    serverA = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('SERVER-A');
    });
    await new Promise<void>((r) => serverA.listen(0, '127.0.0.1', () => r()));
    port = (serverA.address() as { port: number }).port;
    serverB = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('SERVER-B');
    });
    await new Promise<void>((r) => serverB.listen(port, '127.0.0.2', () => r()));
  });

  afterAll(async () => {
    await new Promise<void>((r) => serverA.close(() => r()));
    await new Promise<void>((r) => serverB.close(() => r()));
  });

  beforeEach(() => {
    mockLookup.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('follows the pinned first resolution even after DNS flips', async () => {
    let calls = 0;
    mockLookup.mockImplementation(async () => {
      calls++;
      // First resolution (the helper's only one): server A. Every later
      // resolution — what a second, unpinned fetch would see: server B.
      return calls === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '127.0.0.2', family: 4 }];
    });

    const res = await fetchWithPinnedDns(`http://sc3-flip.test:${port}/`, {
      allowLoopbackAndLan: true,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('SERVER-A');
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  it('refuses when any resolved address is blocked', async () => {
    mockLookup.mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(
      fetchWithPinnedDns(`http://example.com:${port}/`, { allowLoopbackAndLan: true })
    ).rejects.toThrowError(SsrfBlockedError);
  });

  it('refuses a blocked resolved address in strict mode', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(fetchWithPinnedDns(`http://example.com:${port}/`)).rejects.toThrowError(
      SsrfBlockedError
    );
  });

  it('refuses a blocked literal host without resolving', async () => {
    await expect(fetchWithPinnedDns(`http://127.0.0.1:${port}/`)).rejects.toThrowError(
      SsrfBlockedError
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('fails closed when DNS resolution fails', async () => {
    mockLookup.mockRejectedValue(Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' }));
    await expect(fetchWithPinnedDns(`http://example.com:${port}/`)).rejects.toThrowError(
      /DNS resolution failed/
    );
  });

  it('web scraper route still refuses blocked targets with 403', async () => {
    // The route's strict guard blocks loopback, so a DNS flip cannot be
    // observed through it directly (the flip proof is the helper test
    // above). These cases prove the route still routes blocked targets
    // through the helper's validation instead of fetching them.
    const literalReq = new Request('http://localhost/api/v1/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'execute',
        tool: 'web_scraper',
        params: { url: `http://127.0.0.1:${port}/` },
      }),
    });
    const literalRes = await toolsPost(literalReq);
    expect(literalRes.status).toBe(403);
    expect((await literalRes.json()).error).toMatch(/blocked/);
    expect(mockLookup).not.toHaveBeenCalled();

    // A public hostname that resolves to loopback must also be refused.
    mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const resolvedReq = new Request('http://localhost/api/v1/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'execute',
        tool: 'web_scraper',
        params: { url: `http://example.com:${port}/` },
      }),
    });
    const resolvedRes = await toolsPost(resolvedReq);
    expect(resolvedRes.status).toBe(403);
    expect((await resolvedRes.json()).error).toMatch(/blocked/);
  });
});
