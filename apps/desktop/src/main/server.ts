import http, { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {
  Eluvix,
  RouterConfig,
  UpstreamConfig,
  ChatRequest,
  ChatMessage,
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
  DESKTOP_TOKEN_HEADER,
  validateUpstreamHttpEndpoint,
  anthropicToOpenAiChatRequest,
  openAiToAnthropicMessageResponse,
  transformOpenAiSseToAnthropicSse,
  responsesInputToChatRequest,
  openAiChatToResponsesObject,
  transformOpenAiSseToResponsesSse,
  getStoredResponse,
  saveStoredResponse,
  PAPERCLIP_VIRTUAL_MODELS,
  classifyPaperclipTask,
  recommendPaperclipAssignees,
  getPaperclipOutcomePriors,
  recordPaperclipAssignmentOutcome,
  getPaperclipUsageByCorrelation,
  globalCircuitBreaker,
  getEffectiveCostPer1kTokens,
  isLocalUpstream,
  getRollingSpendUsd,
  type PaperclipCandidateAgent,
  deleteStoredResponse,
  getDb,
  listDistillationPairs,
  formatDistillationAsSftJsonl,
  formatDistillationAsDpoJsonl,
  captureDistillationPair,
  recordBanditArmOutcome,
  estimatePromptComplexity,
  ELUVIX_MCP_PROTOCOL_VERSION,
  ELUVIX_MCP_TOOLS,
  ELUVIX_MCP_RESOURCES,
  handleEluvixMcpPayload,
  runEvalSuite,
  STARTER_GOLDEN_EVAL_SUITES,
  listAuditEvents,
  verifyAuditChain,
  createBatchFile,
  listBatchFiles,
  getBatchFileContent,
  createBatchJob,
  executeBatchJob,
  getBatchJob,
  listBatchJobs,
  cancelBatchJob,
  listPromptVersions,
  registerPromptVersion,
  promotePromptAlias,
  resolvePromptTemplate,
  listAlertWebhooks,
  registerAlertWebhook,
  deleteAlertWebhook,
  dispatchAlertWebhooks,
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
          id: 'ramalama',
          name: 'Local RamaLama OCI',
          type: 'ramalama',
          endpoint: 'http://localhost:8080',
          priority: 19,
          models: ['llama3.2:latest', 'qwen2.5-coder:7b']
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
          id: 'comfyui',
          name: 'Local ComfyUI Studio',
          type: 'comfyui',
          endpoint: 'http://localhost:8188',
          priority: 16,
          models: ['flux1-dev-fp8.safetensors', '*'],
          comfyui: {
            workflowPreset: 'flux-txt2img',
            vramMode: 'lowvram'
          }
        },
        {
          id: 'audio-voice',
          name: 'Local Sovereign Audio (Whisper + Kokoro)',
          type: 'audio',
          endpoint: 'http://localhost:8005',
          priority: 16,
          models: ['Systran/faster-whisper-large-v3-turbo', 'kokoro', 'whisper-1', 'tts-1'],
          audio: {
            mode: 'both',
            sttBackend: 'speaches',
            ttsBackend: 'kokoro',
            ttsEndpoint: 'http://localhost:8880',
            defaultVoice: 'af_heart',
            responseFormat: 'mp3',
            scrubTranscriptPii: true
          }
        },
        {
          id: 'switchyard',
          name: 'Local Switchyard Node',
          type: 'switchyard',
          endpoint: 'http://localhost:8090',
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
    if (newConfig.upstreams && !Array.isArray(newConfig.upstreams)) {
      throw new Error('upstreams must be an array');
    }
    // Construct first, then swap: if the Eluvix constructor throws on the
    // merged config, the old config/router pair stays intact instead of
    // leaving config updated while the router still serves the old one.
    const nextConfig = { ...this.config, ...newConfig };
    const nextRouter = new Eluvix(nextConfig);
    this.config = nextConfig;
    this.router = nextRouter;
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
        const s = this.server;
        this.server = null;
        s.close(() => resolve());
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
        for (const vm of PAPERCLIP_VIRTUAL_MODELS) {
          modelSet.add(vm.id);
        }
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
          this.router = new Eluvix(this.config);
          this.emit('config-updated', this.config);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, detected: detectedMap, config: this.config }));
          return;
        }

        let targetUpstream = this.config.upstreams.find(u => u.id === body.id);
        if (!targetUpstream && body.endpoint) {
          const endpointGuard = validateUpstreamHttpEndpoint(String(body.endpoint), {
            allowLoopbackAndLan: true
          });
          if (!endpointGuard.ok) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: false,
                error: endpointGuard.reason || 'Blocked unsafe endpoint URL',
                code: 'ssrf_blocked'
              })
            );
            return;
          }
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

        if (
          targetUpstream.endpoint &&
          !targetUpstream.endpoint.startsWith('cli://') &&
          !targetUpstream.endpoint.startsWith('acp://')
        ) {
          const targetGuard = validateUpstreamHttpEndpoint(targetUpstream.endpoint, {
            allowLoopbackAndLan: true
          });
          if (!targetGuard.ok) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: false,
                error: targetGuard.reason || 'Blocked unsafe upstream endpoint',
                code: 'ssrf_blocked'
              })
            );
            return;
          }
        }

        const detected = await detectUpstreamModels(targetUpstream, 5000);
        if (detected.length > 0 && targetUpstream.id !== 'custom-detect') {
          targetUpstream.models = detected;
          this.router = new Eluvix(this.config);
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

        // The desktop app is a single-user local app: its callers share
        // the owner's 'default' identity partition, passed explicitly.
        const abortController = new AbortController();
        req.on('close', () => {
          if (!res.writableEnded) {
            abortController.abort(new DOMException('Client closed connection', 'AbortError'));
          }
        });
        const upstreamResponse = await this.router.routeChatCompletion(chatReq, {
          signal: abortController.signal,
          scope: { userId: 'default', origin: 'client' }
        });
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

        const forwardedHeaders: Record<string, string> = {};
        upstreamResponse.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (lower.startsWith('x-eluvix-') || lower === 'retry-after') {
            forwardedHeaders[key] = value;
          }
        });

        const contentType = upstreamResponse.headers.get('content-type') || '';
        const isSse = contentType.includes('text/event-stream');

        if (chatReq.stream && upstreamResponse.body && isSse) {
          res.writeHead(upstreamResponse.status, {
            ...forwardedHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          const reader = upstreamResponse.body.getReader();
          let closed = false;
          req.on('close', () => {
            closed = true;
            try { reader.cancel(); } catch {}
          });
          try {
            while (!closed) {
              const { done, value } = await reader.read();
              if (done || closed) break;
              res.write(value);
            }
          } finally {
            try { reader.releaseLock(); } catch {}
            if (!closed && !res.writableEnded) res.end();
          }
          return;
        }

        const data = await upstreamResponse.json().catch(() => ({}));
        res.writeHead(upstreamResponse.status, {
          ...forwardedHeaders,
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify(data));
        return;
      }

      // OpenAI-compatible Image & Media Generation (`/v1/images/generations`)
      if (
        (pathname === '/v1/images/generations' || pathname === '/api/v1/images/generations') &&
        req.method === 'POST'
      ) {
        this.providerAgent.notifyConsumerActive(30000);
        const startTime = Date.now();
        const bodyStr = await this.readBody(req);
        const imgReq = JSON.parse(bodyStr || '{}');

        const rawHops = req.headers['x-eluvix-hops'];
        const hopsHeader = Array.isArray(rawHops) ? rawHops[0] : rawHops;
        const hops = Math.max(0, parseInt(hopsHeader || '0', 10) || 0);

        const abortController = new AbortController();
        req.on('close', () => {
          if (!res.writableEnded) {
            abortController.abort(new DOMException('Client closed connection', 'AbortError'));
          }
        });

        const imgResponse = await this.router.routeImageGeneration(imgReq, {
          signal: abortController.signal,
          hops
        });
        const durationMs = Date.now() - startTime;
        const actualUpstream = imgResponse.headers.get('x-eluvix-upstream') || 'ComfyUI';
        const servedModel = imgResponse.headers.get('x-eluvix-model') || imgReq.model || 'comfyui-diffusion';

        const logEntry: RequestLog = {
          id: `img-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          timestamp: new Date().toLocaleTimeString(),
          model: servedModel,
          upstream: actualUpstream,
          status: imgResponse.status,
          durationMs,
          streaming: false
        };
        this.emit('request-logged', logEntry);

        const forwardedHeaders: Record<string, string> = {};
        imgResponse.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (lower.startsWith('x-eluvix-') || lower === 'retry-after') {
            forwardedHeaders[key] = value;
          }
        });

        const payload = await imgResponse.json().catch(() => ({}));
        res.writeHead(imgResponse.status, {
          ...forwardedHeaders,
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify(payload));
        return;
      }

      // Deterministic Non-Executing Route Explain (`/v1/route-explain`)
      if (
        (pathname === '/v1/route-explain' || pathname === '/api/v1/route-explain') &&
        req.method === 'POST'
      ) {
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          this.rejectJson(res, 400, 'Request must include a non-empty messages array.', 'missing_required_parameter');
          return;
        }

        const activeRouter =
          body.configOverride && Array.isArray(body.configOverride.upstreams)
            ? new Eluvix(body.configOverride as RouterConfig)
            : this.router;

        const explanation = activeRouter.explainRoute(
          {
            model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
            messages: body.messages,
            tools: Array.isArray(body.tools) ? body.tools : undefined,
            confidentialPolicy: body.confidentialPolicy,
            quantizationPolicy: body.quantizationPolicy,
            fabricPolicy: body.fabricPolicy,
            crsPolicy: body.crsPolicy,
            attentionPolicy: body.attentionPolicy,
            metadata: body.metadata
          },
          {
            scope: { userId: 'default', origin: body.origin === 'harness' ? 'harness' : 'client' },
            hops: typeof body.hops === 'number' ? body.hops : 0,
            memoryTainted: Boolean(body.memoryTainted),
            memoryTokens: typeof body.memoryTokens === 'number' ? body.memoryTokens : 0
          }
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(explanation));
        return;
      }

      // Anthropic Messages Wire Protocol (`/v1/messages` & `/api/v1/messages`)
      if (
        (pathname === '/v1/messages' || pathname === '/api/v1/messages') &&
        req.method === 'POST'
      ) {
        this.providerAgent.notifyConsumerActive(30000);
        const startTime = Date.now();
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');

        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: "Missing required parameter: 'messages' must be a non-empty array."
              }
            })
          );
          return;
        }

        const requestedModel =
          typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'claude-3-7-sonnet';
        const chatReq = anthropicToOpenAiChatRequest({ ...body, model: requestedModel }) as unknown as ChatRequest;
        const rawHops = req.headers['x-eluvix-hops'];
        const hopsHeader = Array.isArray(rawHops) ? rawHops[0] : rawHops;
        const hops = Math.max(0, parseInt(hopsHeader || '0', 10) || 0);

        const abortController = new AbortController();
        req.on('close', () => {
          if (!res.writableEnded) {
            abortController.abort(new DOMException('Client closed connection', 'AbortError'));
          }
        });

        const upstreamResponse = await this.router.routeChatCompletion(chatReq, {
          signal: abortController.signal,
          scope: { userId: 'default', origin: 'client' },
          hops
        });
        const durationMs = Date.now() - startTime;
        const actualUpstream = upstreamResponse.headers.get('x-eluvix-upstream') || 'unknown';

        this.emit('request-logged', {
          id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          timestamp: new Date().toLocaleTimeString(),
          model: requestedModel,
          upstream: actualUpstream,
          status: upstreamResponse.status,
          durationMs,
          streaming: Boolean(chatReq.stream)
        });

        const forwardedHeaders: Record<string, string> = {};
        upstreamResponse.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (lower.startsWith('x-eluvix-') || lower === 'retry-after') {
            forwardedHeaders[key] = value;
          }
        });

        if (upstreamResponse.status >= 400) {
          const errData = await upstreamResponse.json().catch(() => ({}));
          res.writeHead(upstreamResponse.status, {
            ...forwardedHeaders,
            'Content-Type': 'application/json'
          });
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: upstreamResponse.status === 429 ? 'rate_limit_error' : 'api_error',
                message: errData?.error?.message || `Upstream status ${upstreamResponse.status}`
              }
            })
          );
          return;
        }

        const contentType = upstreamResponse.headers.get('content-type') || '';
        if (chatReq.stream && upstreamResponse.body && contentType.includes('text/event-stream')) {
          const anthropicStream = transformOpenAiSseToAnthropicSse(
            upstreamResponse.body,
            requestedModel
          );
          await this.pipeWebStream(req, res, anthropicStream, upstreamResponse.status, {
            ...forwardedHeaders,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });
          return;
        }

        const openAiJson = await upstreamResponse.json().catch(() => ({}));
        const anthropicMsg = openAiToAnthropicMessageResponse(openAiJson, requestedModel);
        res.writeHead(upstreamResponse.status, {
          ...forwardedHeaders,
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify(anthropicMsg));
        return;
      }

      // OpenAI Stateful Responses API (`/v1/responses` & `/api/v1/responses`)
      if (
        (pathname === '/v1/responses' || pathname === '/api/v1/responses') &&
        req.method === 'POST'
      ) {
        this.providerAgent.notifyConsumerActive(30000);
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');
        if (body.input === undefined || body.input === null) {
          this.rejectJson(res, 400, "Missing required parameter: 'input' is required.", 'missing_required_parameter');
          return;
        }

        let priorMessages: Array<Record<string, any>> = [];
        const previousResponseId =
          typeof body.previous_response_id === 'string' && body.previous_response_id.trim()
            ? body.previous_response_id.trim()
            : null;
        if (previousResponseId) {
          const prior = getStoredResponse(previousResponseId, 'default');
          if (!prior) {
            this.rejectJson(
              res,
              404,
              `Previous response '${previousResponseId}' not found.`,
              'previous_response_not_found'
            );
            return;
          }
          priorMessages = Array.isArray(prior.messages) ? prior.messages : [];
        }

        const { chatRequest } = responsesInputToChatRequest(body, priorMessages);
        const chatReq = chatRequest as unknown as ChatRequest;
        const shouldStore = body.store !== false;
        const rawHops = req.headers['x-eluvix-hops'];
        const hopsHeader = Array.isArray(rawHops) ? rawHops[0] : rawHops;
        const hops = Math.max(0, parseInt(hopsHeader || '0', 10) || 0);

        const abortController = new AbortController();
        req.on('close', () => {
          if (!res.writableEnded) {
            abortController.abort(new DOMException('Client closed connection', 'AbortError'));
          }
        });

        const upstreamResponse = await this.router.routeChatCompletion(chatReq, {
          signal: abortController.signal,
          scope: { userId: 'default', origin: 'client' },
          hops
        });

        const forwardedHeaders: Record<string, string> = {};
        upstreamResponse.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (lower.startsWith('x-eluvix-') || lower === 'retry-after') {
            forwardedHeaders[key] = value;
          }
        });

        if (upstreamResponse.status >= 400) {
          const errPayload = await upstreamResponse.json().catch(() => ({}));
          res.writeHead(upstreamResponse.status, {
            ...forwardedHeaders,
            'Content-Type': 'application/json'
          });
          res.end(JSON.stringify(errPayload));
          return;
        }

        const servedModel =
          upstreamResponse.headers.get('x-eluvix-model') || chatReq.model || body.model || 'eluvix-default';
        const contentType = upstreamResponse.headers.get('content-type') || '';

        if (chatReq.stream && upstreamResponse.body && contentType.includes('text/event-stream')) {
          const responsesStream = transformOpenAiSseToResponsesSse({
            openAiStream: upstreamResponse.body,
            requestedModel: servedModel,
            previousResponseId,
            store: shouldStore,
            onCompleted: ({ responseObject, assistantMessage }) => {
              if (!shouldStore) return;
              saveStoredResponse({
                id: responseObject.id,
                userId: 'default',
                previousResponseId,
                model: servedModel,
                messages: [...chatRequest.messages, assistantMessage],
                response: responseObject
              });
            }
          });
          await this.pipeWebStream(req, res, responsesStream, upstreamResponse.status, {
            ...forwardedHeaders,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });
          return;
        }

        const openAiJson = await upstreamResponse.json().catch(() => ({}));
        const { responseObject, assistantMessage } = openAiChatToResponsesObject({
          chatJson: openAiJson,
          requestedModel: servedModel,
          previousResponseId,
          store: shouldStore
        });
        if (shouldStore) {
          saveStoredResponse({
            id: responseObject.id,
            userId: 'default',
            previousResponseId,
            model: servedModel,
            messages: [...chatRequest.messages, assistantMessage],
            response: responseObject
          });
        }
        res.writeHead(upstreamResponse.status, {
          ...forwardedHeaders,
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify(responseObject));
        return;
      }

      // Retrieve / Delete Stored Response (`/v1/responses/:id` & `/api/v1/responses/:id`)
      if (
        (pathname.startsWith('/v1/responses/') || pathname.startsWith('/api/v1/responses/')) &&
        (req.method === 'GET' || req.method === 'DELETE')
      ) {
        const respId = decodeURIComponent(
          pathname.replace(/^\/(?:api\/)?v1\/responses\//, '')
        ).trim();
        if (!respId) {
          this.rejectJson(res, 400, 'Response ID is required.', 'invalid_request');
          return;
        }
        if (req.method === 'GET') {
          const stored = getStoredResponse(respId, 'default');
          if (!stored) {
            this.rejectJson(res, 404, `Response '${respId}' not found.`, 'response_not_found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(stored.response));
          return;
        }
        const deleted = deleteStoredResponse(respId, 'default');
        if (!deleted) {
          this.rejectJson(res, 404, `Response '${respId}' not found.`, 'response_not_found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: respId, object: 'response.deleted', deleted: true }));
        return;
      }

      // OpenAI Embeddings Router (`/v1/embeddings` & `/api/v1/embeddings`)
      if (
        (pathname === '/v1/embeddings' || pathname === '/api/v1/embeddings') &&
        req.method === 'POST'
      ) {
        this.providerAgent.notifyConsumerActive(15000);
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');
        if (body.input === undefined || body.input === null) {
          this.rejectJson(res, 400, "Missing required parameter: 'input' is required.", 'missing_required_parameter');
          return;
        }
        const rawHops = req.headers['x-eluvix-hops'];
        const hopsHeader = Array.isArray(rawHops) ? rawHops[0] : rawHops;
        const hops = Math.max(0, parseInt(hopsHeader || '0', 10) || 0);

        const embResponse = await this.router.routeEmbeddings(body, {
          scope: { userId: 'default', origin: 'client' },
          hops
        });
        const forwardedHeaders: Record<string, string> = {};
        embResponse.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (lower.startsWith('x-eluvix-') || lower === 'retry-after') {
            forwardedHeaders[key] = value;
          }
        });
        const payload = await embResponse.json().catch(() => ({}));
        res.writeHead(embResponse.status, {
          ...forwardedHeaders,
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify(payload));
        return;
      }

      // Sovereign Headless Audio STT (`/v1/audio/transcriptions` & `/api/v1/audio/transcriptions`)
      if (
        (pathname === '/v1/audio/transcriptions' || pathname === '/api/v1/audio/transcriptions') &&
        req.method === 'POST'
      ) {
        this.providerAgent.notifyConsumerActive(30000);
        const contentType = req.headers['content-type'] || '';
        const rawBuf = await this.readBodyBuffer(req);
        const syntheticReq = new Request('http://127.0.0.1/upload', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: new Uint8Array(rawBuf)
        });
        const formData = await syntheticReq.formData();
        const fileField = formData.get('file');
        if (!fileField || typeof fileField === 'string') {
          this.rejectJson(res, 400, "Missing required multipart field: 'file'.", 'missing_required_parameter');
          return;
        }
        const rawHops = req.headers['x-eluvix-hops'];
        const hopsHeader = Array.isArray(rawHops) ? rawHops[0] : rawHops;
        const hops = Math.max(0, parseInt(hopsHeader || '0', 10) || 0);

        const model = formData.get('model');
        const language = formData.get('language');
        const prompt = formData.get('prompt');
        const responseFormat = formData.get('response_format');

        const sttRes = await this.router.routeAudioTranscription(
          {
            file: fileField as Blob,
            filename: (fileField as File).name || 'audio.wav',
            mimeType: (fileField as Blob).type || 'audio/wav',
            ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
            ...(typeof language === 'string' && language.trim() ? { language: language.trim() } : {}),
            ...(typeof prompt === 'string' && prompt.trim() ? { prompt: prompt.trim() } : {}),
            ...(typeof responseFormat === 'string' && responseFormat.trim()
              ? { response_format: responseFormat.trim() as any }
              : {})
          },
          {
            scope: { userId: 'default', origin: 'client' },
            hops
          }
        );
        const forwardedHeaders: Record<string, string> = {
          'Content-Type': sttRes.headers.get('content-type') || 'application/json'
        };
        sttRes.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (lower.startsWith('x-eluvix-') || lower === 'retry-after') {
            forwardedHeaders[key] = value;
          }
        });
        const outBytes = Buffer.from(await sttRes.arrayBuffer());
        res.writeHead(sttRes.status, forwardedHeaders);
        res.end(outBytes);
        return;
      }

      // Sovereign Headless Audio TTS (`/v1/audio/speech` & `/api/v1/audio/speech`)
      if (
        (pathname === '/v1/audio/speech' || pathname === '/api/v1/audio/speech') &&
        req.method === 'POST'
      ) {
        this.providerAgent.notifyConsumerActive(30000);
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');
        if (typeof body.input !== 'string' || !body.input.trim()) {
          this.rejectJson(res, 400, "Missing required parameter: 'input' must be a non-empty string.", 'missing_required_parameter');
          return;
        }
        const rawHops = req.headers['x-eluvix-hops'];
        const hopsHeader = Array.isArray(rawHops) ? rawHops[0] : rawHops;
        const hops = Math.max(0, parseInt(hopsHeader || '0', 10) || 0);

        const ttsRes = await this.router.routeAudioSpeech(body, {
          scope: { userId: 'default', origin: 'client' },
          hops
        });
        const forwardedHeaders: Record<string, string> = {
          'Content-Type': ttsRes.headers.get('content-type') || 'audio/mpeg'
        };
        ttsRes.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (lower.startsWith('x-eluvix-') || lower === 'retry-after') {
            forwardedHeaders[key] = value;
          }
        });
        const outBytes = Buffer.from(await ttsRes.arrayBuffer());
        res.writeHead(ttsRes.status, forwardedHeaders);
        res.end(outBytes);
        return;
      }

      // Dataset & Distillation Export (`/v1/export` & `/api/v1/export`)
      if ((pathname === '/v1/export' || pathname === '/api/v1/export') && req.method === 'GET') {
        const format = (url.searchParams.get('format') || 'chat').toLowerCase();
        const minScoreRaw = url.searchParams.get('minScore');
        const minScore =
          minScoreRaw !== null && Number.isFinite(parseFloat(minScoreRaw))
            ? Math.max(0, Math.min(1, parseFloat(minScoreRaw)))
            : format === 'dpo'
            ? 0.75
            : 0.6;
        const limitRaw = url.searchParams.get('limit');
        const limit =
          limitRaw !== null && Number.isFinite(parseInt(limitRaw, 10))
            ? Math.max(1, Math.min(5000, parseInt(limitRaw, 10)))
            : 1000;

        if (format === 'sft') {
          const pairs = listDistillationPairs('default', { minScore, limit });
          const rawJsonl = formatDistillationAsSftJsonl(pairs);
          res.writeHead(200, {
            'Content-Type': 'application/jsonl',
            'x-eluvix-export-format': 'sft',
            'x-eluvix-export-count': String(pairs.length),
          });
          res.end(rawJsonl ? `${rawJsonl}\n` : '');
          return;
        }
        if (format === 'dpo') {
          const pairs = listDistillationPairs('default', { minScore, limit });
          const rawJsonl = formatDistillationAsDpoJsonl(pairs);
          const count = rawJsonl ? rawJsonl.split('\n').filter(Boolean).length : 0;
          res.writeHead(200, {
            'Content-Type': 'application/jsonl',
            'x-eluvix-export-format': 'dpo',
            'x-eluvix-export-count': String(count),
          });
          res.end(rawJsonl ? `${rawJsonl}\n` : '');
          return;
        }
        if (format !== 'chat') {
          this.rejectJson(res, 400, `Unsupported export format "${format}".`, 'invalid_format');
          return;
        }
        const db = getDb();
        const messages = db
          .prepare(
            'SELECT session_id, role, content FROM chat_history WHERE user_id = ? ORDER BY session_id, id ASC'
          )
          .all('default') as Array<{ session_id: string; role: string; content: string }>;
        const sessions = new Map<string, any[]>();
        for (const msg of messages) {
          if (!sessions.has(msg.session_id)) sessions.set(msg.session_id, []);
          sessions.get(msg.session_id)!.push({ role: msg.role, content: msg.content });
        }
        let jsonl = '';
        for (const msgs of Array.from(sessions.values())) {
          if (msgs.length > 0) jsonl += JSON.stringify({ messages: msgs }) + '\n';
        }
        res.writeHead(200, { 'Content-Type': 'application/jsonl' });
        res.end(jsonl);
        return;
      }

      // Arena Human Preference Vote (`/v1/distillation/vote` & `/api/v1/distillation/vote`)
      if (
        (pathname === '/v1/distillation/vote' || pathname === '/api/v1/distillation/vote') &&
        req.method === 'POST'
      ) {
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');
        const chosenText = typeof body.chosenText === 'string' ? body.chosenText.trim() : '';
        const rejectedText = typeof body.rejectedText === 'string' ? body.rejectedText.trim() : '';
        if (!chosenText || !rejectedText) {
          this.rejectJson(
            res,
            400,
            'Both chosenText and rejectedText must be non-empty strings.',
            'missing_required_parameter'
          );
          return;
        }
        const promptMessages = Array.isArray(body.messages)
          ? body.messages
          : typeof body.prompt === 'string' && body.prompt.trim()
          ? [{ role: 'user', content: body.prompt }]
          : [];
        if (promptMessages.length === 0) {
          this.rejectJson(res, 400, 'prompt or messages[] is required.', 'missing_required_parameter');
          return;
        }
        const winnerUpstreamId = String(body.winnerUpstreamId || body.winnerModel || 'arena-winner');
        const loserUpstreamId = String(body.loserUpstreamId || body.loserModel || 'arena-loser');
        const complexity = estimatePromptComplexity(promptMessages as any);
        const tier = String(body.complexityTier || complexity.label);

        const winnerArm = recordBanditArmOutcome({
          upstreamId: winnerUpstreamId,
          complexityTier: tier,
          success: true,
          weight: 2.0,
        });
        const loserArm =
          loserUpstreamId !== winnerUpstreamId
            ? recordBanditArmOutcome({
                upstreamId: loserUpstreamId,
                complexityTier: tier,
                success: false,
                weight: 1.5,
              })
            : null;
        const pair = captureDistillationPair({
          userId: 'default',
          source: 'arena-vote',
          teacherUpstreamId: winnerUpstreamId,
          studentUpstreamId: loserUpstreamId,
          teacherModel: String(body.winnerModel || winnerUpstreamId),
          studentModel: String(body.loserModel || loserUpstreamId),
          promptMessages,
          chosenText,
          rejectedText,
          privacyConfig: this.config.privacyGuard,
          judgeScoreOverride: 1.0,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, pairId: pair?.id ?? null, winnerArm, loserArm }));
        return;
      }

      // Streamable-HTTP Model Context Protocol (`/v1/mcp` & `/api/v1/mcp`)
      if (pathname === '/v1/mcp' || pathname === '/api/v1/mcp') {
        if (req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'mcp-protocol-version': ELUVIX_MCP_PROTOCOL_VERSION,
          });
          res.end(
            JSON.stringify({
              name: 'eluvix-sovereign-ai-os',
              protocolVersion: ELUVIX_MCP_PROTOCOL_VERSION,
              transport: 'streamable-http',
              tools: ELUVIX_MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
              resources: ELUVIX_MCP_RESOURCES,
            })
          );
          return;
        }

        if (req.method === 'POST') {
          this.providerAgent.notifyConsumerActive(30000);
          const rawHops = req.headers['x-eluvix-hops'];
          const hopsHeader = Array.isArray(rawHops) ? rawHops[0] : rawHops;
          const incomingHops = Math.max(0, parseInt(hopsHeader || '0', 10) || 0);
          if (incomingHops >= 2) {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'mcp-protocol-version': ELUVIX_MCP_PROTOCOL_VERSION,
            });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: {
                  code: -32000,
                  message: `MCP recursion loop blocked (x-eluvix-hops=${incomingHops} >= 2).`,
                },
              })
            );
            return;
          }

          const bodyStr = await this.readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr || '{}');
          } catch {
            res.writeHead(400, {
              'Content-Type': 'application/json',
              'mcp-protocol-version': ELUVIX_MCP_PROTOCOL_VERSION,
            });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error: invalid JSON body' },
              })
            );
            return;
          }

          const rpcResponse = await handleEluvixMcpPayload(parsed, {
            router: this.router,
            config: this.config,
            scope: { userId: 'default', origin: 'client' },
            hops: incomingHops,
          });

          if (rpcResponse === null) {
            res.writeHead(202, { 'mcp-protocol-version': ELUVIX_MCP_PROTOCOL_VERSION });
            res.end();
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'mcp-protocol-version': ELUVIX_MCP_PROTOCOL_VERSION,
            'x-eluvix-hops': String(incomingHops + 1),
          });
          res.end(JSON.stringify(rpcResponse));
          return;
        }
      }

      // Golden Eval Suite Runner (`/v1/evals/run` & `/api/v1/evals/run`)
      if (
        (pathname === '/v1/evals/run' || pathname === '/api/v1/evals/run') &&
        req.method === 'POST'
      ) {
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');
        const mode = body?.mode === 'live' ? 'live' : 'dry-run';

        const suite =
          body?.suite && typeof body.suite === 'object' && Array.isArray(body.suite.cases)
            ? body.suite
            : typeof body?.suiteId === 'string'
              ? STARTER_GOLDEN_EVAL_SUITES.find((s) => s.id === body.suiteId)
              : STARTER_GOLDEN_EVAL_SUITES[0];

        if (!suite || !Array.isArray(suite.cases) || suite.cases.length === 0) {
          this.rejectJson(
            res,
            400,
            'A valid Golden Eval suite (with non-empty cases[]) or suiteId is required.',
            'missing_required_parameter'
          );
          return;
        }

        let effectiveConfig: RouterConfig = this.config;
        if (body?.configOverride && typeof body.configOverride === 'object') {
          if (!Array.isArray(body.configOverride.upstreams)) {
            this.rejectJson(res, 400, 'configOverride.upstreams must be an array.', 'invalid_request_error');
            return;
          }
          for (const u of body.configOverride.upstreams) {
            if (u?.endpoint && /^https?:\/\//i.test(u.endpoint)) {
              const check = validateUpstreamHttpEndpoint(u.endpoint, { allowLoopbackAndLan: true });
              if (!check.ok) {
                this.rejectJson(
                  res,
                  400,
                  `Unsafe upstream endpoint in configOverride ("${u.id}"): ${check.reason}`,
                  'ssrf_blocked'
                );
                return;
              }
            }
          }
          effectiveConfig = body.configOverride as RouterConfig;
        }

        const report = await runEvalSuite(suite, effectiveConfig, {
          mode,
          scope: { userId: 'default', origin: 'playground' },
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-eluvix-eval-passed': String(report.passed),
          'x-eluvix-eval-mode': report.mode,
        });
        res.end(JSON.stringify(report));
        return;
      }

      // Cross-Encoder & Sovereign Reranker (`/v1/rerank` & `/api/v1/rerank`)
      if ((pathname === '/v1/rerank' || pathname === '/api/v1/rerank') && req.method === 'POST') {
        const bodyStr = await this.readBody(req);
        const body = JSON.parse(bodyStr || '{}');
        const rerankRes = await this.router.routeRerank(body, { userId: 'default' });
        const outText = await rerankRes.text();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        rerankRes.headers.forEach((v, k) => {
          if (k.toLowerCase().startsWith('x-eluvix-')) headers[k] = v;
        });
        res.writeHead(rerankRes.status, headers);
        res.end(outText);
        return;
      }

      // Tamper-Evident Audit Log (`/v1/audit` & `/api/v1/audit`)
      if ((pathname === '/v1/audit' || pathname === '/api/v1/audit') && req.method === 'GET') {
        const verify =
          url.searchParams.get('verify') === '1' ||
          url.searchParams.get('verify') === 'true';
        const limit = Math.max(
          1,
          Math.min(500, parseInt(url.searchParams.get('limit') || '100', 10) || 100)
        );
        const events = listAuditEvents({ limit });
        const verification = verify ? verifyAuditChain() : undefined;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(verification ? { 'x-eluvix-audit-chain-valid': String(verification.valid) } : {}),
        });
        res.end(
          JSON.stringify({
            object: 'list',
            data: events,
            ...(verification ? { verification } : {}),
          })
        );
        return;
      }

      // Versioned Prompt Registry (`/v1/prompts` & `/api/v1/prompts`)
      if (pathname === '/v1/prompts' || pathname === '/api/v1/prompts') {
        if (req.method === 'GET') {
          const resolveRef = url.searchParams.get('resolve');
          if (resolveRef) {
            const resolved = resolvePromptTemplate(resolveRef);
            if (!resolved) {
              this.rejectJson(res, 404, `Prompt "${resolveRef}" not found.`, 'not_found_error');
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(resolved));
            return;
          }
          const id = url.searchParams.get('id') || undefined;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: listPromptVersions(id) }));
          return;
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await this.readBody(req)) || '{}');
          if (body?.action === 'promote') {
            const aliasRec = promotePromptAlias({
              promptId: String(body.promptId || body.id || ''),
              alias: String(body.alias || 'production'),
              version: Number(body.version || 1),
              minEvalScore: typeof body.minEvalScore === 'number' ? body.minEvalScore : undefined,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(aliasRec));
            return;
          }
          const verRec = registerPromptVersion({
            id: String(body.id || ''),
            systemTemplate: String(body.systemTemplate || ''),
            description: body.description,
            variablesSchema: body.variablesSchema,
            modelHint: body.modelHint,
            evalScore: typeof body.evalScore === 'number' ? body.evalScore : undefined,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(verRec));
          return;
        }
      }

      // Batch Files (`/v1/files` & `/api/v1/files`)
      if (pathname === '/v1/files' || pathname === '/api/v1/files') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: listBatchFiles('default') }));
          return;
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await this.readBody(req)) || '{}');
          const created = createBatchFile({
            filename: body.filename || 'batch.jsonl',
            purpose: body.purpose || 'batch',
            contentJsonl: body.content || body.content_jsonl || '',
            userId: 'default',
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(created));
          return;
        }
      }

      const fileContentMatch = /^\/(?:api\/)?v1\/files\/([^/]+)\/content$/.exec(pathname);
      if (fileContentMatch && req.method === 'GET') {
        const content = getBatchFileContent(fileContentMatch[1], 'default');
        if (content === null) {
          this.rejectJson(res, 404, 'File not found', 'not_found_error');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/jsonl; charset=utf-8' });
        res.end(content);
        return;
      }

      // Batch Jobs (`/v1/batches` & `/api/v1/batches`)
      if (pathname === '/v1/batches' || pathname === '/api/v1/batches') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: listBatchJobs('default') }));
          return;
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await this.readBody(req)) || '{}');
          const job = createBatchJob({
            input_file_id: String(body.input_file_id || ''),
            endpoint: body.endpoint,
            completion_window: body.completion_window,
            metadata: body.metadata,
            userId: 'default',
          });
          if (job.status === 'in_progress') {
            if (body.await_completion === true) {
              const done = await executeBatchJob(job.id, this.router, { userId: 'default' });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(done || job));
              return;
            }
            queueMicrotask(() => {
              void executeBatchJob(job.id, this.router, { userId: 'default' }).catch(() => {});
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(job));
          return;
        }
      }

      const batchIdMatch = /^\/(?:api\/)?v1\/batches\/([^/]+)(?:\/cancel)?$/.exec(pathname);
      if (batchIdMatch) {
        const batchId = batchIdMatch[1];
        if (req.method === 'GET') {
          const job = getBatchJob(batchId, 'default');
          if (!job) {
            this.rejectJson(res, 404, 'Batch not found', 'not_found_error');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(job));
          return;
        }
        if (req.method === 'POST') {
          const cancelled = cancelBatchJob(batchId, 'default');
          if (!cancelled) {
            this.rejectJson(res, 404, 'Batch not found', 'not_found_error');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cancelled));
          return;
        }
      }

      // Alerting Webhooks (`/v1/webhooks` & `/api/v1/webhooks`)
      if (pathname === '/v1/webhooks' || pathname === '/api/v1/webhooks') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: listAlertWebhooks('default') }));
          return;
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await this.readBody(req)) || '{}');
          if (body?.action === 'test') {
            const dispatched = await dispatchAlertWebhooks({
              event: body.event || 'budget.threshold',
              severity: body.severity || 'info',
              summary: body.summary || 'Desktop test webhook',
              data: body.data || {},
              userId: 'default',
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(dispatched));
            return;
          }
          const created = registerAlertWebhook({
            name: String(body.name || 'Alert Webhook'),
            url: String(body.url || ''),
            provider: body.provider,
            secret: body.secret,
            events: body.events,
            enabled: body.enabled,
            userId: 'default',
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(created));
          return;
        }
        if (req.method === 'DELETE') {
          const id = url.searchParams.get('id') || '';
          const deleted = deleteAlertWebhook(id, 'default');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, deleted }));
          return;
        }
      }

      // Paperclip Integration Routes (`/v1/paperclip/*` & `/api/v1/paperclip/*`)
      if (pathname === '/v1/paperclip/whoami' || pathname === '/api/v1/paperclip/whoami') {
        const cfg = this.router.getConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          userId: 'default',
          via: 'desktop-token',
          paperclipIntegrationEnabled: Boolean(cfg.integrations?.paperclip?.enabled),
          trustHeadersFrom: cfg.integrations?.paperclip?.trustHeadersFrom ?? 'scoped-key',
          egressPolicy: cfg.egressPolicy ?? 'allow-egress',
          rolling24hSpendUsd: getRollingSpendUsd(24, 'default'),
          maxDailySpendUsd: cfg.switchyard?.maxDailySpendUsd ?? null,
        }));
        return;
      }

      if (pathname === '/v1/paperclip/capabilities' || pathname === '/api/v1/paperclip/capabilities') {
        const cfg = this.router.getConfig();
        const upstreams = this.router.getUpstreams().map((u) => {
          const local = isLocalUpstream(u);
          return {
            id: u.id,
            name: u.name,
            type: u.type,
            isLocal: local,
            healthy: globalCircuitBreaker.getState(u.id) !== 'open',
            models: u.models || [],
            costPer1kTokens: getEffectiveCostPer1kTokens(u),
            estimatedLatencyMs: u.latencyMs ?? (local ? 750 : 1400),
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'eluvix.switchyard.capabilities',
          egressPolicy: cfg.egressPolicy ?? 'allow-egress',
          strategy: cfg.switchyard?.strategy ?? cfg.strategy ?? 'cost-complexity',
          virtualModels: PAPERCLIP_VIRTUAL_MODELS,
          paperclipPolicy: cfg.integrations?.paperclip ?? { enabled: false },
          upstreams,
        }));
        return;
      }

      if ((pathname === '/v1/paperclip/classify' || pathname === '/api/v1/paperclip/classify') && req.method === 'POST') {
        const body = JSON.parse((await this.readBody(req)) || '{}');
        const classification = classifyPaperclipTask({
          issueId: typeof body.issueId === 'string' ? body.issueId : undefined,
          title: String(body.title || ''),
          description: typeof body.description === 'string' ? body.description : undefined,
          priority: body.priority,
          labels: Array.isArray(body.labels) ? body.labels.map(String) : undefined,
          sensitivity: body.sensitivity,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(classification));
        return;
      }

      if ((pathname === '/v1/paperclip/recommend-assignee' || pathname === '/api/v1/paperclip/recommend-assignee') && req.method === 'POST') {
        const body = JSON.parse((await this.readBody(req)) || '{}');
        const task = {
          issueId: typeof body.task?.issueId === 'string' ? body.task.issueId : undefined,
          title: String(body.task?.title || ''),
          description: typeof body.task?.description === 'string' ? body.task.description : undefined,
          priority: body.task?.priority,
          labels: Array.isArray(body.task?.labels) ? body.task.labels.map(String) : undefined,
          sensitivity: body.task?.sensitivity,
        };
        const classification = classifyPaperclipTask(task);
        const priors = getPaperclipOutcomePriors(classification.taskClass, 'default');
        const fleet = this.router.getUpstreams().map((u) => ({
          id: u.id,
          name: u.name,
          type: u.type,
          isLocal: isLocalUpstream(u),
          healthy: globalCircuitBreaker.getState(u.id) !== 'open',
          models: u.models || [],
          costPer1kTokens: getEffectiveCostPer1kTokens(u),
          estimatedLatencyMs: u.latencyMs ?? (isLocalUpstream(u) ? 750 : 1400),
        }));
        const result = recommendPaperclipAssignees(
          task,
          (body.candidates || []) as PaperclipCandidateAgent[],
          fleet,
          body.weights,
          priors
        );
        const topN = typeof body.topN === 'number' && body.topN > 0 ? Math.min(20, body.topN) : undefined;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ...result,
          recommendations: topN ? result.recommendations.slice(0, topN) : result.recommendations,
        }));
        return;
      }

      if ((pathname === '/v1/paperclip/feedback' || pathname === '/api/v1/paperclip/feedback') && req.method === 'POST') {
        const body = JSON.parse((await this.readBody(req)) || '{}');
        recordPaperclipAssignmentOutcome({
          userId: 'default',
          issueId: String(body.issueId || ''),
          agentId: String(body.agentId || ''),
          taskClass: String(body.taskClass || 'text:moderate'),
          success: Boolean(body.success),
          costUsd: typeof body.costUsd === 'number' ? body.costUsd : 0,
          durationMs: typeof body.durationMs === 'number' ? body.durationMs : 0,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const pcUsageMatch = /^\/(?:api\/)?v1\/paperclip\/usage\/([^/]+)$/.exec(pathname);
      if (pcUsageMatch && req.method === 'GET') {
        const runId = decodeURIComponent(pcUsageMatch[1]);
        const summary = getPaperclipUsageByCorrelation(runId, 'default');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary));
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

  private async pipeWebStream(
    req: IncomingMessage,
    res: ServerResponse,
    stream: ReadableStream<Uint8Array>,
    status: number,
    headers: Record<string, string>
  ): Promise<void> {
    res.writeHead(status, headers);
    const reader = stream.getReader();
    let closed = false;
    req.on('close', () => {
      closed = true;
      try {
        reader.cancel();
      } catch {}
    });
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        res.write(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
      if (!closed && !res.writableEnded) res.end();
    }
  }

  private readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      let settled = false;

      const timer = setTimeout(() => {
        fail(Object.assign(new Error('Request body read timed out'), { statusCode: 408 }), true);
      }, BODY_READ_TIMEOUT_MS);
      timer.unref?.();

      const fail = (err: Error & { statusCode?: number }, destroy = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (destroy) {
          try {
            req.destroy();
          } catch {}
        }
        reject(err);
      };

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
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
        resolve(Buffer.concat(chunks));
      });
      req.on('error', (err) => fail(err));
    });
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return this.readBodyBuffer(req).then((buf) => buf.toString('utf8'));
  }
}
