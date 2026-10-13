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
  getProviderJobLogs
} from '@eluvix/router-core';
import EventEmitter from 'node:events';

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

  constructor(port = 3001) {
    super();
    this.port = port;

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
    this.providerAgent.on('job-completed', (job) => {
      this.emit('provider-job-completed', job);
    });
  }

  public getProviderAgent(): EluvixProviderAgent {
    return this.providerAgent;
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

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`Port ${this.port} is in use, trying next port ${this.port + 1}...`);
          this.port += 1;
          this.server?.listen(this.port, '127.0.0.1');
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        const protocol = this.isHttps ? 'https' : 'http';
        console.log(`[Eluvix Desktop] Server listening on ${protocol}://127.0.0.1:${this.port} (TLS: ${this.isHttps ? 'Enabled via mkcert' : 'Disabled'})`);
        resolve(this.port);
      });
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

  private setCorsHeaders(res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    this.setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
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
        const targetUpstreams = this.config.upstreams.filter(u =>
          u.models.includes(chatReq.model) || u.models.includes('*')
        );
        if (targetUpstreams.length > 0) {
          chosenUpstreamName = targetUpstreams[0].name;
        }

        const upstreamResponse = await this.router.routeChatCompletion(chatReq);
        const durationMs = Date.now() - startTime;

        const logEntry: RequestLog = {
          id: `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          timestamp: new Date().toLocaleTimeString(),
          model: chatReq.model,
          upstream: chosenUpstreamName,
          status: upstreamResponse.status,
          durationMs,
          streaming: Boolean(chatReq.stream)
        };
        this.emit('request-logged', logEntry);

        if (chatReq.stream && upstreamResponse.body) {
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

        const data = await upstreamResponse.json();
        res.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      // Not found
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Route ${pathname} not found on Eluvix Desktop`, type: 'invalid_request_error' } }));
    } catch (err: any) {
      console.error('[Eluvix Server Error]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message || 'Internal Eluvix Error', type: 'api_error' } }));
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', err => reject(err));
    });
  }
}
