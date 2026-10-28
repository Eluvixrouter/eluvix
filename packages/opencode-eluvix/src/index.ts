import http from 'node:http';
import {
  computeHarnessKvPrefixHash,
  inspectHarnessObservation,
  isToolAutoApproved,
  selectSwitchyardStepTier,
  type HarnessApprovalPolicy,
  type HarnessMcpServerConfig,
  type HarnessMidLoopGuardConfig,
} from '../../router-core/src/harness/index.js';

export interface OpenCodeForkSession {
  id: string;
  title: string;
  kvPrefixHash: string;
  mcpServers: HarnessMcpServerConfig[];
  createdAt: string;
  messages: Array<{
    id: string;
    agent: string;
    parts: any[];
    tool_calls?: any[];
    switchyardTier: number;
  }>;
  permissions: Map<
    string,
    { id: string; tool: string; status: 'pending' | 'approved' | 'rejected'; reason?: string }
  >;
}

export interface EluvixOpenCodeServerOptions {
  port?: number;
  host?: string;
  defaultApprovalPolicy?: HarnessApprovalPolicy;
  defaultAutoApproveTools?: string[];
  midLoopGuard?: HarnessMidLoopGuardConfig;
  /**
   * Optional simulated or custom tool executor invoked when an approved tool runs.
   */
  toolExecutor?: (toolName: string, args: Record<string, unknown>) => Promise<string> | string;
}

export interface EluvixOpenCodeServerInstance {
  server: http.Server;
  sessions: Map<string, OpenCodeForkSession>;
  listen: (port?: number, host?: string) => Promise<{ url: string; port: number }>;
  close: () => Promise<void>;
}

export function createEluvixOpenCodeServer(
  options: EluvixOpenCodeServerOptions = {}
): EluvixOpenCodeServerInstance {
  const sessions = new Map<string, OpenCodeForkSession>();
  const defaultPolicy: HarnessApprovalPolicy =
    options.defaultApprovalPolicy || 'auto-approve-readonly';
  const defaultAutoApprove = options.defaultAutoApproveTools || [
    'read_file',
    'grep_search',
    'list_dir',
    'inspect_repo',
  ];

  const parseJsonBody = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
        if (raw.length > 5 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!raw.trim()) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ _raw: raw });
        }
      });
      req.on('error', reject);
    });

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'eluvix-opencode',
          fork: 'Eluvixrouter/opencode-eluvix',
          version: '1.0.10',
          features: [
            'client-tool-calling',
            'mcp-mesh-injection',
            'mid-loop-prompt-privacy-guard',
            'switchyard-step-tiering',
            'deepseek-mla-kv-prefix-pinning',
          ],
          activeSessions: sessions.size,
        })
      );
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'harness/opencode', object: 'model', owned_by: 'eluvix-opencode' },
            { id: 'opencode/build', object: 'model', owned_by: 'eluvix-opencode' },
            { id: 'opencode/plan', object: 'model', owned_by: 'eluvix-opencode' },
            { id: 'opencode/security-audit', object: 'model', owned_by: 'eluvix-opencode' },
          ],
        })
      );
      return;
    }

    // POST /session — Create session
    if (req.method === 'POST' && url.pathname === '/session') {
      const body = await parseJsonBody(req);
      const id = `oc_elx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const mcpServers: HarnessMcpServerConfig[] = Array.isArray(body?.mcpServers)
        ? body.mcpServers
        : [];
      const kvPrefixHash =
        typeof body?.kvPrefixHash === 'string' && body.kvPrefixHash
          ? body.kvPrefixHash
          : computeHarnessKvPrefixHash([], [], mcpServers);

      const session: OpenCodeForkSession = {
        id,
        title: String(body?.title || 'Eluvix-OpenCode Session'),
        kvPrefixHash,
        mcpServers,
        createdAt: new Date().toISOString(),
        messages: [],
        permissions: new Map(),
      };
      sessions.set(id, session);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-eluvix-harness-fork': 'eluvix-opencode',
        'x-eluvix-prefix-hash': kvPrefixHash,
      });
      res.end(
        JSON.stringify({
          id: session.id,
          title: session.title,
          kvPrefixHash: session.kvPrefixHash,
          mcpServers: session.mcpServers,
          createdAt: session.createdAt,
        })
      );
      return;
    }

    // POST /session/:id/permission/:permId/reply
    const permMatch = url.pathname.match(/^\/session\/([^/]+)\/permission\/([^/]+)\/reply$/);
    if (req.method === 'POST' && permMatch) {
      const sessionId = decodeURIComponent(permMatch[1]);
      const permId = decodeURIComponent(permMatch[2]);
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const body = await parseJsonBody(req);
      const approved = body?.response === 'once' || body?.response === 'always';
      session.permissions.set(permId, {
        id: permId,
        tool: String(body?.tool || 'tool'),
        status: approved ? 'approved' : 'rejected',
        reason: body?.reason,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: permId, status: approved ? 'approved' : 'rejected' }));
      return;
    }

    // POST /session/:id/message — Execute turn with mid-loop DLP, PromptGuard, Switchyard tiering & tool calling
    const msgMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === 'POST' && msgMatch) {
      const sessionId = decodeURIComponent(msgMatch[1]);
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      const body = await parseJsonBody(req);
      const agent = String(body?.agent || 'build');
      const inputParts: any[] = Array.isArray(body?.parts) ? body.parts : [];
      const promptText = inputParts
        .filter(p => p?.type === 'text' && typeof p?.text === 'string')
        .map(p => p.text)
        .join('\n');

      const policy: HarnessApprovalPolicy =
        body?.eluvix?.approvalPolicy || defaultPolicy;
      const autoApproveList: string[] = Array.isArray(body?.eluvix?.autoApproveTools)
        ? body.eluvix.autoApproveTools
        : defaultAutoApprove;

      // 1. Mid-loop guard on incoming prompt
      const promptGuardCheck = inspectHarnessObservation(
        promptText,
        'opencode_user_message',
        options.midLoopGuard
      );

      const step1Decision = selectSwitchyardStepTier(1, 'tool-selection', promptGuardCheck.sanitizedText);
      const step2Decision = selectSwitchyardStepTier(2, 'final-synthesis', promptGuardCheck.sanitizedText);

      const outParts: any[] = [];
      const toolCalls: any[] = [];

      // 2. Execute or prepare requested client tools & MCP tools
      const requestedTools: any[] = Array.isArray(body?.tools) ? body.tools : [];
      for (let i = 0; i < requestedTools.length; i++) {
        const t = requestedTools[i];
        const toolName = String(t?.function?.name || t?.name || `tool_${i}`);
        const approved = isToolAutoApproved(policy, [toolName], autoApproveList);

        if (!approved) {
          const permId = `perm_${Date.now()}_${i}`;
          session.permissions.set(permId, { id: permId, tool: toolName, status: 'pending' });
          outParts.push({
            type: 'permission_request',
            id: permId,
            tool: toolName,
            reason: `Tool "${toolName}" requires approval under policy "${policy}"`,
          });
          continue;
        }

        let rawToolOutput = `Executed tool "${toolName}" in Eluvix-OpenCode session ${session.id}`;
        if (options.toolExecutor) {
          rawToolOutput = await options.toolExecutor(toolName, { prompt: promptGuardCheck.sanitizedText });
        }

        // Mid-loop guard on tool observation before it enters the response/context!
        const obsCheck = inspectHarnessObservation(
          rawToolOutput,
          toolName,
          options.midLoopGuard
        );

        outParts.push({
          type: 'tool',
          tool: toolName,
          state: {
            status: 'completed',
            output: obsCheck.sanitizedText,
            piiRedacted: obsCheck.piiRedacted,
            injectionDetected: obsCheck.injectionDetected,
          },
        });

        toolCalls.push({
          id: `call_oc_${Date.now()}_${i}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify({ query: promptGuardCheck.sanitizedText.slice(0, 100) }),
          },
        });
      }

      const obsSummary = outParts
        .filter(p => p.type === 'tool')
        .map(p => `${p.tool}: ${p.state.output}`)
        .join(' | ');

      const synthesisText = obsSummary
        ? `[Eluvix-OpenCode (${agent})] ${promptGuardCheck.sanitizedText} — Tool Results: ${obsSummary}`
        : `[Eluvix-OpenCode (${agent})] ${promptGuardCheck.sanitizedText}`;

      outParts.push({
        type: 'text',
        text: synthesisText,
      });

      const msgRecord = {
        id: `msg_${Date.now()}`,
        agent,
        parts: outParts,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        switchyardTier: step2Decision.tier,
      };
      session.messages.push(msgRecord);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-eluvix-harness-fork': 'eluvix-opencode',
        'x-eluvix-prefix-hash': session.kvPrefixHash,
        'x-eluvix-switchyard-tier': `${step1Decision.tier}->${step2Decision.tier}`,
      });
      res.end(JSON.stringify(msgRecord));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
  };

  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    handleRequest(req, res).catch(err => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
      }
    });
  });

  return {
    server,
    sessions,
    listen(port = options.port ?? 0, host = options.host ?? '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address() as { port: number };
          resolve({
            url: `http://${host}:${addr.port}`,
            port: addr.port,
          });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
