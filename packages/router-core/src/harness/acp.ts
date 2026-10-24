import { spawn } from 'node:child_process';
import path from 'node:path';
import type { RequestScope } from '../context/types.js';
import type { ChatRequest, UpstreamConfig } from '../index.js';
import { resolveCliExecutable, ACP_CLI_BINARIES } from '../cli-exec.js';
import { buildHarnessPrompt } from './prompt.js';
import { buildChildEnv } from './env.js';
import { isToolAutoApproved } from './approval.js';
import type { HarnessApprovalPolicy } from './types.js';

/** Grace period between SIGTERM and SIGKILL when cleaning up an ACP child. */
const ACP_KILL_GRACE_MS = 2000;
/** Only the tail of the child's stderr is retained for diagnostics. */
const ACP_STDERR_TAIL_BYTES = 8192;

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
  const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);

  // Resolve through the central executable gate (audit M-1): the old
  // basename-only check let a config value like `/tmp/dropped/goose` pass
  // and execute. The resolver enforces the allowlist on the canonical
  // path — the file must exist, be executable, and not live under a
  // world-writable or config-controlled directory. The spawn below uses
  // the RESOLVED path, never the raw config value. (Test env keeps its
  // historical exception: `node`, used by the suite's fake ACP agents via
  // process.execPath.)
  const resolvedBin = resolveCliExecutable(rawBin, {
    allowedBasenames: isTestEnv ? [...ACP_CLI_BINARIES, 'node'] : ACP_CLI_BINARIES
  });
  const baseBin = path.basename(resolvedBin);

  // The ACP session/prompt channel carries text only: forwarding a
  // tool-bearing request would silently drop the tools. Fail the attempt
  // instead so router failover can pick an upstream that supports them.
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    throw new Error(
      'ACP harness does not support client tool calling; refusing to silently drop request tools'
    );
  }

  const approvalPolicy: HarnessApprovalPolicy =
    harnessCfg.approvals || harnessCfg.approvalPolicy || 'auto-deny';
  // ACP sessions are spawned per request, so the full conversation —
  // system context (incl. the injected <eluvix-memory> block) plus the
  // history transcript — is folded into the prompt.
  const promptText = buildHarnessPrompt(request.messages || [], { includeHistory: true });
  const cwd = harnessCfg.cwd || process.cwd();
  const servedModel = `acp/${baseBin}`;
  const completionId = `chatcmpl-acp-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const runAcpSession = (onDelta: (text: string) => void): Promise<string> => {
    return new Promise((resolve, reject) => {
      const child = spawn(resolvedBin, cmdArray.slice(1), {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Spawn-boundary env scrub (audit H-1 / D3): the agent never
        // inherits the router's own credentials — see harness/env.ts.
        env: buildChildEnv({
          ELUVIX_ORIGIN: 'harness',
          ELUVIX_HOPS: String(hops + 1)
        })
      });

      let fullText = '';
      let lineBuf = '';
      let settled = false;
      let childExited = false;
      let stderrTail = '';
      let killTimer: NodeJS.Timeout | null = null;
      let sessionId = 'acp-session-1';

      const cleanup = () => {
        clearTimeout(timer);
        if (childExited) return;
        try {
          if (!child.killed) {
            child.kill('SIGTERM');
            // Escalate if the agent ignores SIGTERM, otherwise a wedged
            // child outlives the request that spawned it.
            killTimer = setTimeout(() => {
              try {
                if (!childExited) child.kill('SIGKILL');
              } catch {}
            }, ACP_KILL_GRACE_MS);
            killTimer.unref?.();
          }
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
        try {
          if (child.stdin.writable) {
            child.stdin.write(JSON.stringify(msg) + '\n');
          }
        } catch {
          // Agent died mid-write; the close/error handlers settle the turn.
        }
      };

      // Writing to a dead agent's stdin raises EPIPE asynchronously; without
      // a listener that becomes an unhandled error that crashes the router.
      child.stdin.on('error', () => {});
      // stderr is piped, so it MUST be drained: an agent that logs more than
      // the OS pipe buffer (~64KB) blocks mid-turn and the request times
      // out. Consume it, retaining only a bounded rolling tail.
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-ACP_STDERR_TAIL_BYTES);
      });
      child.stderr.on('error', () => {});

      child.on('error', err => finishErr(err));
      child.on('close', code => {
        childExited = true;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        if (!settled) {
          if (fullText.length > 0 || code === 0) {
            finishOk();
          } else {
            const tail = stderrTail.trim();
            finishErr(
              new Error(
                `ACP process '${baseBin}' exited with code ${code}${tail ? `: ${tail.slice(-500)}` : ''}`
              )
            );
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

            // Auto-approval requires an exact allowlist match (audit
            // M-4): a read-only-looking title is never sufficient — the
            // title is supplied by the agent being approved.
            const toolIdentifiers = [
              msg.params?.toolCall?.name,
              msg.params?.toolCall?.toolName,
              msg.params?.toolCall?.title,
              msg.params?.title
            ].filter((v: any): v is string => typeof v === 'string' && v.length > 0);
            const shouldApprove = isToolAutoApproved(
              approvalPolicy,
              toolIdentifiers,
              harnessCfg.autoApproveTools
            );
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
