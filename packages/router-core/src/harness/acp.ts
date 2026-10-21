import { spawn } from 'node:child_process';
import path from 'node:path';
import type { RequestScope } from '../context/types.js';
import type { ChatMessage, ChatRequest, UpstreamConfig } from '../index.js';
import type { HarnessApprovalPolicy } from './types.js';

const ALLOWED_ACP_BINARIES = new Set([
  'goose',
  'opencode',
  'openhands',
  'claude-code-acp',
  'agy'
]);

function extractPromptFromMessages(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find(m => m.role === 'user') || messages[messages.length - 1];
  if (!lastUser) return '';
  if (typeof lastUser.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser.content)) {
    return lastUser.content
      .filter(p => p.type === 'text')
      .map(p => (p as { type: 'text'; text: string }).text)
      .join('\n');
  }
  return '';
}

function isReadonlyTool(title: string): boolean {
  return /^(read|get|list|search|find|fetch|query|view|inspect|cat|ls|grep)/i.test(title || '');
}

export async function forwardAcpHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  _scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const harnessCfg = upstream.harness || { kind: 'acp' as const };
  let cmdArray: string[];
  if (Array.isArray(harnessCfg.command) && harnessCfg.command.length > 0) {
    cmdArray = [...harnessCfg.command, ...(Array.isArray(harnessCfg.args) ? harnessCfg.args : [])];
  } else if (typeof harnessCfg.command === 'string' && harnessCfg.command.trim().length > 0) {
    cmdArray = [harnessCfg.command.trim(), ...(Array.isArray(harnessCfg.args) ? harnessCfg.args : [])];
  } else {
    cmdArray = ['goose', 'acp'];
  }
  const rawBin = cmdArray[0].trim();
  const baseBin = path.basename(rawBin);
  const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);

  if (!ALLOWED_ACP_BINARIES.has(baseBin) && !(isTestEnv && baseBin === 'node')) {
    throw new Error(`ACP execution denied: '${baseBin}' is not an authorized ACP agent binary.`);
  }

  const approvalPolicy: HarnessApprovalPolicy =
    harnessCfg.approvals || harnessCfg.approvalPolicy || 'auto-deny';
  const promptText = extractPromptFromMessages(request.messages || []);
  const cwd = harnessCfg.cwd || process.cwd();
  const servedModel = `acp/${baseBin}`;
  const completionId = `chatcmpl-acp-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const runAcpSession = (onDelta: (text: string) => void): Promise<string> => {
    return new Promise((resolve, reject) => {
      const child = spawn(rawBin, cmdArray.slice(1), {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ELUVIX_ORIGIN: 'harness',
          ELUVIX_HOPS: String(hops + 1)
        }
      });

      let fullText = '';
      let lineBuf = '';
      let settled = false;
      let sessionId = 'acp-session-1';

      const cleanup = () => {
        clearTimeout(timer);
        try {
          if (!child.killed) child.kill('SIGTERM');
        } catch {}
      };

      const finishOk = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(fullText);
      };

      const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const timer = setTimeout(() => {
        finishErr(new DOMException(`ACP agent timed out after ${timeoutMs}ms`, 'TimeoutError'));
      }, timeoutMs);

      if (clientSignal) {
        if (clientSignal.aborted) {
          finishErr(new DOMException('Client aborted request', 'AbortError'));
          return;
        }
        clientSignal.addEventListener(
          'abort',
          () => finishErr(new DOMException('Client aborted request', 'AbortError')),
          { once: true }
        );
      }

      const sendRpc = (msg: Record<string, any>) => {
        if (child.stdin.writable) {
          child.stdin.write(JSON.stringify(msg) + '\n');
        }
      };

      child.on('error', err => finishErr(err));
      child.on('close', code => {
        if (!settled) {
          if (fullText.length > 0 || code === 0) {
            finishOk();
          } else {
            finishErr(new Error(`ACP process '${baseBin}' exited with code ${code}`));
          }
        }
      });

      child.stdout.on('data', (chunk: Buffer) => {
        lineBuf += chunk.toString('utf8');
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }

          // 1. Response to initialize (id=1) -> send session/new (id=2)
          if (msg.id === 1 && msg.result) {
            sendRpc({
              jsonrpc: '2.0',
              id: 2,
              method: 'session/new',
              params: { cwd, mcpServers: [] }
            });
            continue;
          }

          // 2. Response to session/new (id=2) -> send session/prompt (id=3)
          if (msg.id === 2 && msg.result) {
            sessionId = String(msg.result.sessionId || sessionId);
            sendRpc({
              jsonrpc: '2.0',
              id: 3,
              method: 'session/prompt',
              params: {
                sessionId,
                prompt: [{ type: 'text', text: promptText }]
              }
            });
            continue;
          }

          // 3. Streaming notification: session/update
          if (msg.method === 'session/update') {
            const update = msg.params?.update || msg.params;
            const chunkText =
              update?.content?.text ??
              update?.delta?.text ??
              update?.text ??
              (typeof update?.delta === 'string' ? update.delta : '');
            if (typeof chunkText === 'string' && chunkText) {
              fullText += chunkText;
              onDelta(chunkText);
            }
            continue;
          }

          // 4. Permission request from agent: session/request_permission
          if (msg.method === 'session/request_permission' && msg.id != null) {
            const title = String(msg.params?.toolCall?.title || msg.params?.title || 'tool');
            const options: any[] = Array.isArray(msg.params?.options) ? msg.params.options : [];
            const allowOpt = options.find((o: any) => /allow|approve/i.test(String(o?.kind || o?.optionId || '')));
            const rejectOpt = options.find((o: any) => /reject|deny/i.test(String(o?.kind || o?.optionId || '')));

            if (approvalPolicy === 'surface') {
              const note = `\n[Approval Required: "${title}"]\n`;
              fullText += note;
              onDelta(note);
            }

            const shouldApprove = approvalPolicy === 'auto-approve-readonly' && isReadonlyTool(title);
            const selectedOptionId = shouldApprove
              ? allowOpt?.optionId || 'allow'
              : rejectOpt?.optionId || 'reject';

            sendRpc({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                outcome: {
                  outcome: 'selected',
                  optionId: selectedOptionId
                }
              }
            });
            continue;
          }

          // 5. Final response to session/prompt (id=3)
          if (msg.id === 3) {
            if (msg.error) {
              finishErr(new Error(msg.error.message || 'ACP session/prompt error'));
              return;
            }
            if (typeof msg.result?.text === 'string' && msg.result.text && !fullText) {
              fullText += msg.result.text;
              onDelta(msg.result.text);
            }
            finishOk();
            return;
          }
        }
      });

      // Kick off ACP handshake
      sendRpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
        }
      });
    });
  };

  if (!request.stream) {
    const text = await runAcpSession(() => {});
    const promptTokens = Math.ceil(promptText.length / 4);
    const completionTokens = Math.ceil(text.length / 4);
    const payload = {
      id: completionId,
      object: 'chat.completion',
      created,
      model: servedModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-eluvix-model': servedModel,
        'x-eluvix-harness': 'acp',
        'x-eluvix-prompt-tokens': String(promptTokens),
        'x-eluvix-completion-tokens': String(completionTokens)
      }
    });
  }

  const encoder = new TextEncoder();
  const outStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: servedModel,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
          })}\n\n`
        )
      );
      try {
        await runAcpSession(delta => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: servedModel,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
              })}\n\n`
            )
          );
        });
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model: servedModel,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            })}\n\n`
          )
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    }
  });

  return new Response(outStream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'x-eluvix-model': servedModel,
      'x-eluvix-harness': 'acp'
    }
  });
}
