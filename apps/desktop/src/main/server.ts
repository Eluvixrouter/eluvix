import http, { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {
  Eluvix,
  RouterConfig,
  UpstreamConfig,
  ChatRequest,
  detectUpstreamModels,
  getOrCreateLocalCert,
  TlsCertificates,
  EluvixProviderAgent,
  getProviderSettings,
  getProviderJobLogs,
  getOrCreateDesktopToken,
  isTrustedLocalOrigin,
  isAllowedLocalHost,
  desktopTokenEquals,
  extractDesktopToken,
  DESKTOP_TOKEN_HEADER
} from '@eluvix/router-core';
import EventEmitter from 'node:events';

/** Request-body ceiling for the desktop API (audit L-12). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** A stalled body must not pin a handler forever (audit L-12). */
const BODY_READ_TIMEOUT_MS = 30000;

export interface RequestLog {
  id: string;
  timestamp: string;
  model: string;
  upstream: string;
  status: number;
  durationMs: number;
  streaming: boolean;
}

export class DesktopRouterServer extends EventEmitter {
  private server: net.Server | http.Server | https.Server | null = null;
  private router: Eluvix;
  private providerAgent: EluvixProviderAgent;
  private config: RouterConfig;
  private port: number;
  private tlsCerts: TlsCertificates | null = null;
  private isHttps: boolean = false;
  private desktopToken: string;
  private desktopTokenFile: string;

  constructor(port = 3001) {
    super();
    this.port = port;

    // Per-install API token (audit C-1, decision D1): every route on this
    // server requires it. It is generated on first run into a 0o600 file
    // in the config dir; the renderer receives it from the main process
    // over IPC, and local CLI tools read the file — it is never served
    // over this HTTP API itself.
    const desktopToken = getOrCreateDesktopToken();
    this.desktopToken = desktopToken.token;
    this.desktopTokenFile = desktopToken.tokenFile;

    // Default configuration with Billama as a first-class citizen alongside local engines
    this.config = {
      fallbackStrategy: 'priority',
      upstreams: [
        {
          id: 'vllm',
          name: 'Local vLLM',
          type: 'vllm',
          endpoint: 'http://localhost:8000',
          priority: 25,
          models: ['meta-llama/Llama-3-8b', 'meta-llama/Llama-3-70b']
        },
        {
          id: 'vllm-sr',
          name: 'Local vLLM-sr',
          type: 'vllm-sr',
          endpoint: 'http://localhost:8001',
          priority: 22,
          models: ['meta-llama/Llama-3-8b-instruct', 'mistralai/Mistral-7B-v0.1']
        },
        {
          id: 'ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 20,
          models: ['llama3', 'llama3.1', 'qwen2.5-coder', 'mistral']
        },
        {
          id: 'lemonade',
          name: 'Lemonade Router',
          type: 'lemonade',
          endpoint: 'http://localhost:13305',
          priority: 18,
          models: ['llama3.2-1b-FLM', 'Qwen3.5-4B-MTP-GGUF']
        },
        {
          id: 'switchyard',
          name: 'Local Switchyard Node',
          type: 'switchyard',
          endpoint: 'http://localhost:8080',
          priority: 15,
          models: ['deepseek-ai/deepseek-coder-6.7b', 'codellama/CodeLlama-7b-hf']
        },
        {
          id: 'billama-cloud',
          name: 'Billama Cloud (Recommended)',
          type: 'billama',
          endpoint: 'https://api.billama.dev',
          apiKey: process.env.BILLAMA_API_KEY || '',
          priority: 10,
          models: ['*'] // Universal fallback
        },
        {
          id: 'openai-direct',
          name: 'OpenAI Direct (Optional)',
          type: 'openai-compatible',
          endpoint: 'https://api.openai.com',
          apiKey: process.env.OPENAI_API_KEY || '',
          priority: 5,
          models: ['gpt-4o', 'gpt-4o-mini', 'o1-preview']
        }
      ]
    };

    this.router = new Eluvix(this.config);
    this.providerAgent = new EluvixProviderAgent();

    this.providerAgent.on('status-changed', (status) => {
      this.emit('provider-status-changed', status);
    });
    this.providerAgent.on('preempted', (info) => {
      this.emit('provider-status-changed', { status: 'STANDBY', ...info });
    });
    this.providerAgent.on('resumed', () => {
      this.emit('provider-status-changed', { status: 'ONLINE' });
    });
    this.providerAgent.on('job-completed', (job) => {
      this.emit('provider-job-completed', job);
    });
  }

  public getProviderAgent(): EluvixProviderAgent {
    return this.providerAgent;
  }

  /** The per-install API token. Main-process/IPC use only — never routed. */
  public getDesktopToken(): string {
    return this.desktopToken;
  }

  /** Path of the 0o600 token file, for the startup banner and CLI docs. */
  public getDesktopTokenFile(): string {
    return this.desktopTokenFile;
  }

  public async getProviderStatus() {
    return await this.providerAgent.getStatus();
  }

  public async toggleProvider(enabled: boolean) {
    return await this.providerAgent.setEnabled(enabled);
  }

  public updateProviderConfig(config: any) {
    this.providerAgent.updateConfig(config);
    return getProviderSettings();
  }

  public async runProviderBenchmark(model?: string) {
    return await this.providerAgent.runBenchmark(model);
  }

  public getConfig(): RouterConfig {
    return this.config;
  }

  public updateConfig(newConfig: Partial<RouterConfig>) {
    this.config = { ...this.config, ...newConfig };
    this.router = new Eluvix(this.config);
    this.emit('config-updated', this.config);
  }

  public async detectModels(targetUpstream: UpstreamConfig, timeoutMs = 5000): Promise<string[]> {
    return detectUpstreamModels(targetUpstream, timeoutMs);
  }

  public async detectAllModels(timeoutMs = 5000): Promise<Record<string, string[]>> {
    return this.router.detectAllModels(timeoutMs);
  }

  public start(): Promise<number> {
    return new Promise((resolve, reject) => {
      // Check if mkcert generated or can generate a certificate for local HTTPS
      this.tlsCerts = getOrCreateLocalCert(['localhost', '127.0.0.1', '::1', 'eluvix.local']);
      if (this.tlsCerts) {
        this.isHttps = true;
        this.server = https.createServer(
          { key: this.tlsCerts.key, cert: this.tlsCerts.cert },
          (req, res) => this.handleRequest(req, res)
        );
      } else {
        this.isHttps = false;
        this.server = http.createServer((req, res) => this.handleRequest(req, res));
      }

      // start()'s promise resolves only from this callback, so EVERY listen
      // attempt — including EADDRINUSE retries — must carry it. A bare
      // retry listen() binds the new port but leaves the promise pending
      // forever: no window is created and no error is surfaced.
      const onListening = () => {
        const protocol = this.isHttps ? 'https' : 'http';
        console.log(`[Eluvix Desktop] Server listening on ${protocol}://127.0.0.1:${this.port} (TLS: ${this.isHttps ? 'Enabled via mkcert' : 'Disabled'})`);
        console.log(`[Eluvix Desktop] API token file: ${this.desktopTokenFile} (send it as the '${DESKTOP_TOKEN_HEADER}' header or 'Authorization: Bearer <token>')`);
        resolve(this.port);
      };

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`Port ${this.port} is in use, trying next port ${this.port + 1}...`);
          this.port += 1;
          this.server?.removeListener('listening', onListening);
          this.server?.listen(this.port, '127.0.0.1', onListening);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', onListening);
    });
  }

  public stop(): Promise<void> {
    this.providerAgent.stop();
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  public getPort(): number {
    return this.port;
  }

  public getIsHttps(): boolean {
    return this.isHttps;
  }

  public getBaseUrl(): string {
    const protocol = this.isHttps ? 'https' : 'http';
    return `${protocol}://127.0.0.1:${this.port}`;
  }

  private setCorsHeaders(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (!origin) return;
    // Reflect only trusted local origins. The opaque 'null' origin (the
    // file:// renderer's fetches) is reflected so its preflights succeed —
    // reflection grants nothing by itself: every actual request still has
    // to present the desktop token. Arbitrary *.local names are NOT
    // reflected anymore (audit H-12: any LAN device can claim one).
    if (origin === 'null' || isTrustedLocalOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
      res.setHeader(
        'Access-Control-Allow-Headers',
        `Content-Type, Authorization, x-api-key, ${DESKTOP_TOKEN_HEADER}`
      );
      res.setHeader('Vary', 'Origin');
    }
  }

  private rejectJson(res: ServerResponse, status: number, message: string, code: string) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message, type: 'invalid_request_error', code } }));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    // 1. Host allowlist — defeats DNS rebinding regardless of any other
    //    header: a rebound attacker hostname is not a local host (audit
    //    C-1/H-12).
    if (!isAllowedLocalHost(req.headers.host)) {
      this.rejectJson(res, 403, 'Host not allowed.', 'forbidden_host');
      return;
    }

    // 2. Preflight: answer only for trusted local origins (plus the
    //    renderer's opaque 'null'); anything else is rejected, not
    //    merely left unreflected.
    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && !isTrustedLocalOrigin(origin)) {
        this.rejectJson(res, 403, 'Cross-Origin requests from untrusted origins are blocked.', 'unauthorized_origin');
        return;
      }
      this.setCorsHeaders(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    // 3. Origin rejection, mirroring the Next.js middleware: a present
    //    Origin that is not a trusted local origin is blocked before any
    //    handler runs. 'null' (the file:// renderer, sandboxed frames) is
    //    not rejected here — those requests still have to pass the token
    //    check below, which a drive-by page cannot satisfy.
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !isTrustedLocalOrigin(origin)) {
      this.rejectJson(res, 403, 'Cross-Origin requests from untrusted origins are blocked.', 'unauthorized_origin');
      return;
    }
    this.setCorsHeaders(req, res);

    // 4. Token auth on EVERY route (audit C-1/H-12/H-13): no route —
    //    config, provider, detect-models, chat, health — is reachable
    //    without the per-install token.
    const providedToken = extractDesktopToken(req.headers);
    if (!providedToken || !desktopTokenEquals(providedToken, this.desktopToken)) {
      this.rejectJson(res, 401, 'Missing or invalid desktop API token.', 'invalid_api_key');
      return;
    }

    const baseUrl = this.getBaseUrl();
    const url = new URL(req.url || '/', baseUrl);
    const pathname = url.pathname;

    try {
      // Health / Status check
      if (pathname === '/' || pathname === '/health' || pathname === '/v1/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          service: 'Eluvix Desktop Proxy',
          port: this.port,
          tls: this.isHttps,
          openAiEndpoint: `${baseUrl}/v1`,
          activeUpstreams: this.config.upstreams.map(u => ({ id: u.id, name: u.name, type: u.type, priority: u.priority }))
        }));
        return;
      }

      // Models list (OpenAI-compatible)
      if (pathname === '/v1/models' && req.method === 'GET') {
        const upstreams = this.router.getUpstreams();
        const modelSet = new Set<string>();
        upstreams.forEach(u => {
          u.models.forEach(m => {
            if (m !== '*') modelSet.add(m);
          });
        });

        const models = Array.from(modelSet).map(m => ({
          id: m,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'eluvix'
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models }));
        return;
      }

      // Configuration endpoints for desktop GUI
      if (pathname === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.config));
        return;
      }

      if (pathname === '/api/config' && req.method === 'POST') {
        const bodyStr = await this.readBody(req);
        const newConfig = JSON.parse(bodyStr);
        this.updateConfig(newConfig);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', config: this.config }));
        return;
      }

      // Model detection endpoint for desktop GUI
      if (pathname === '/api/detect-models' && req.method === 'POST') {
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');

        if (body.all) {
          const detectedMap = await this.router.detectAllModels(5000);
          this.config.upstreams.forEach(u => {
            if (detectedMap[u.id] && detectedMap[u.id].length > 0) {
              u.models = detectedMap[u.id];
            }
          });
          this.emit('config-updated', this.config);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, detected: detectedMap, config: this.config }));
          return;
        }

        let targetUpstream = this.config.upstreams.find(u => u.id === body.id);
        if (!targetUpstream && body.endpoint) {
          targetUpstream = {
            id: body.id || 'custom-detect',
            name: body.name || 'Custom Node',
            type: body.type || 'openai-compatible',
            endpoint: body.endpoint,
            apiKey: body.apiKey,
            priority: 1,
            models: []
          };
        }

        if (!targetUpstream) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Upstream not found' }));
          return;
        }

        const detected = await detectUpstreamModels(targetUpstream, 5000);
        if (detected.length > 0 && targetUpstream.id !== 'custom-detect') {
          targetUpstream.models = detected;
          this.emit('config-updated', this.config);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          id: targetUpstream.id,
          models: detected,
          count: detected.length,
          message: detected.length > 0
            ? `Successfully detected ${detected.length} model(s).`
            : `No models detected at ${targetUpstream.endpoint}. Make sure the server is running.`
        }));
        return;
      }

      // Provider API endpoints for GUI and external tools
      if (pathname === '/api/provider/status' && req.method === 'GET') {
        const status = await this.providerAgent.getStatus();
        const settings = getProviderSettings();
        const recentJobs = getProviderJobLogs(15);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, status, settings, recentJobs }));
        return;
      }

      if (pathname === '/api/provider/toggle' && req.method === 'POST') {
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');
        const status = await this.providerAgent.setEnabled(Boolean(body.enabled));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, status }));
        return;
      }

      if (pathname === '/api/provider/config' && req.method === 'POST') {
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');
        this.providerAgent.updateConfig(body);
        const status = await this.providerAgent.getStatus();
        const settings = getProviderSettings();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, status, settings }));
        return;
      }

      if (pathname === '/api/provider/benchmark' && req.method === 'POST') {
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');
        const result = await this.providerAgent.runBenchmark(body.model);
        const status = await this.providerAgent.getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result, status }));
        return;
      }

      // Chat completions proxy (OpenAI-compatible)
      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        // Consumer Zero-Lag Preemption: pause provider compute for 30s
        this.providerAgent.notifyConsumerActive(30000);

        const startTime = Date.now();
        const bodyStr = await this.readBody(req);
        const chatReq: ChatRequest = JSON.parse(bodyStr);

        let chosenUpstreamName = 'unknown';
        // chatReq.model is optional (the router defaults it); an absent
        // model can only match wildcard upstreams in this label pre-filter,
        // exactly as before.
        const targetUpstreams = this.config.upstreams.filter(u =>
          (chatReq.model !== undefined && u.models.includes(chatReq.model)) || u.models.includes('*')
        );
        if (targetUpstreams.length > 0) {
          chosenUpstreamName = targetUpstreams[0].name;
        }

        const upstreamResponse = await this.router.routeChatCompletion(chatReq);
        const durationMs = Date.now() - startTime;
        const actualUpstream = upstreamResponse.headers.get('x-eluvix-upstream') || chosenUpstreamName;

        const logEntry: RequestLog = {
          id: `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          timestamp: new Date().toLocaleTimeString(),
          model: chatReq.model || 'auto',
          upstream: actualUpstream,
          status: upstreamResponse.status,
          durationMs,
          streaming: Boolean(chatReq.stream)
        };
        this.emit('request-logged', logEntry);

        const contentType = upstreamResponse.headers.get('content-type') || '';
        const isSse = contentType.includes('text/event-stream');

        if (chatReq.stream && upstreamResponse.body && isSse) {
          res.writeHead(upstreamResponse.status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          const reader = upstreamResponse.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
          return;
        }

        const data = await upstreamResponse.json().catch(() => ({}));
        res.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      // Not found
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Route ${pathname} not found on Eluvix Desktop`, type: 'invalid_request_error' } }));
    } catch (err: any) {
      console.error('[Eluvix Server Error]', err);
      if (res.destroyed || res.writableEnded) return;
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message || 'Internal Eluvix Error', type: 'api_error' } }));
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    // Bounded body read (audit L-12): the previous implementation
    // accumulated chunks with no size limit and no timeout, so any local
    // process (or website, via the old unauthenticated path) could stream
    // an unbounded body and exhaust the desktop process's memory.
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      let settled = false;

      const timer = setTimeout(() => {
        // A stalled body gets its socket torn down; there is no live
        // response channel left to report the 408 on, and that is fine.
        fail(Object.assign(new Error('Request body read timed out'), { statusCode: 408 }), true);
      }, BODY_READ_TIMEOUT_MS);
      timer.unref?.();

      const fail = (err: Error & { statusCode?: number }, destroy = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (destroy) {
          try { req.destroy(); } catch {}
        }
        reject(err);
      };

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          // Over the cap: keep draining but discard, so memory stays
          // bounded AND the socket survives to deliver the 413.
          overflow = true;
          return;
        }
        if (!overflow) chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        if (overflow) {
          fail(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', (err) => fail(err));
    });
  }
}
