import type { ChatRequest, UpstreamConfig } from './index.js';

export type ConsensusStrategy = 'judge-synthesize' | 'majority-vote' | 'fastest-first';

export interface ConsensusGroupConfig {
  id: string;
  name?: string;
  strategy: ConsensusStrategy;
  candidateUpstreamIds: string[];
  judgeModel?: string;
  minQuorum?: number;
  timeoutMs?: number;
}

export async function executeConsensusGroup(
  group: ConsensusGroupConfig,
  candidates: UpstreamConfig[],
  request: ChatRequest,
  dispatchToUpstream: (
    upstream: UpstreamConfig,
    req: ChatRequest,
    signal?: AbortSignal
  ) => Promise<Response>,
  clientSignal?: AbortSignal
): Promise<Response> {
  const strategy = group.strategy || 'judge-synthesize';
  const minQuorum = Math.max(1, Math.min(candidates.length, group.minQuorum ?? 2));
  const nonStreamReq: ChatRequest = { ...request, stream: false };

  if (strategy === 'fastest-first') {
    const controllers = candidates.map(() => new AbortController());
    if (clientSignal) {
      clientSignal.addEventListener(
        'abort',
        () => controllers.forEach((c) => c.abort(clientSignal.reason)),
        { once: true }
      );
    }

    const winner = await Promise.any(
      candidates.map(async (u, idx) => {
        const res = await dispatchToUpstream(u, nonStreamReq, controllers[idx].signal);
        if (!res.ok) {
          throw new Error(`Upstream ${u.id} returned ${res.status}`);
        }
        return { upstream: u, res, idx };
      })
    );

    controllers.forEach((c, i) => {
      if (i !== winner.idx) c.abort();
    });

    const bodyText = await winner.res.text();
    const headers = new Headers(winner.res.headers);
    headers.set('x-eluvix-consensus-strategy', 'fastest-first');
    headers.set('x-eluvix-consensus-winner', winner.upstream.id);
    headers.set('x-eluvix-consensus-candidates', candidates.map((c) => c.id).join(','));

    if (request.stream) {
      let content = '';
      try {
        const parsed = JSON.parse(bodyText);
        content = parsed?.choices?.[0]?.message?.content || parsed?.content || bodyText;
      } catch {
        content = bodyText;
      }
      const completionId = `chatcmpl-fastest-${Date.now()}`;
      const modelId = request.model || winner.upstream.id;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
              })}\n\n`
            )
          );
          ctrl.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
              })}\n\n`
            )
          );
          ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
          ctrl.close();
        }
      });
      headers.set('Content-Type', 'text/event-stream');
      return new Response(stream, { status: 200, headers });
    }

    return new Response(bodyText, { status: 200, headers });
  }

  // Parallel fan-out for 'majority-vote' and 'judge-synthesize'
  const settled = await Promise.allSettled(
    candidates.map(async (u) => {
      const res = await dispatchToUpstream(u, nonStreamReq, clientSignal);
      if (!res.ok) {
        throw new Error(`Upstream ${u.id} failed with HTTP ${res.status}`);
      }
      const data: any = await res.json();
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      return { upstream: u, text, raw: data };
    })
  );

  const successes = settled
    .filter((r): r is PromiseFulfilledResult<{ upstream: UpstreamConfig; text: string; raw: any }> => r.status === 'fulfilled' && Boolean(r.value.text))
    .map((r) => r.value);

  if (successes.length < minQuorum) {
    throw new Error(`Consensus group "${group.id}" failed to reach quorum (${successes.length}/${candidates.length} succeeded, minimum ${minQuorum} required)`);
  }

  let finalContent = successes[0].text;
  if (strategy === 'majority-vote' || successes.length === 1) {
    // Pick the response with highest token overlap similarity to all peer responses
    let bestScore = -1;
    for (const candidate of successes) {
      const wordsA = new Set(candidate.text.toLowerCase().split(/\W+/).filter(Boolean));
      let agreement = 0;
      for (const peer of successes) {
        if (peer === candidate) continue;
        const wordsB = new Set(peer.text.toLowerCase().split(/\W+/).filter(Boolean));
        let intersection = 0;
        wordsA.forEach((w) => {
          if (wordsB.has(w)) intersection++;
        });
        const union = wordsA.size + wordsB.size - intersection;
        agreement += union > 0 ? intersection / union : 0;
      }
      if (agreement > bestScore) {
        bestScore = agreement;
        finalContent = candidate.text;
      }
    }
  } else {
    // 'judge-synthesize': pick an upstream supporting group.judgeModel if available, or fall back to first candidate
    const judgeModelTarget = group.judgeModel && group.judgeModel !== 'auto' ? group.judgeModel : request.model;
    const judgeUpstream =
      (group.judgeModel && candidates.find((u) => u.models?.some((m) => m === group.judgeModel || m.includes(group.judgeModel!)))) ||
      successes[0].upstream;
    const draftsBlock = successes
      .map((s, idx) => `--- Candidate ${idx + 1} (${s.upstream.name || s.upstream.id}) ---\n${s.text}`)
      .join('\n\n');
    const lastUser =
      [...request.messages].reverse().find((m) => m.role === 'user')?.content || '';
    
    // Preserve system context and prior history while augmenting with judge instructions
    const existingSys = request.messages.filter((m) => m.role === 'system');
    const existingNonSys = request.messages.filter((m) => m.role !== 'system');
    const judgeSysPrompt = 'You are the Eluvix Consensus Judge. Synthesize the candidate model responses into a single, accurate, well-structured answer, respecting all system constraints.';
    const judgeMessages = existingSys.length > 0
      ? existingSys.map((m) => ({
          ...m,
          content: `${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}\n\n${judgeSysPrompt}`
        }))
      : [{ role: 'system' as const, content: judgeSysPrompt }];
    const priorTurns = existingNonSys.slice(0, -1).map((m) => ({
      ...m,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }));
    judgeMessages.push(...priorTurns);
    judgeMessages.push({
      role: 'user',
      content: `Original Request:\n${typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser)}\n\nCandidate Responses to Synthesize:\n${draftsBlock}`
    });

    const judgeReq: ChatRequest = {
      model: judgeModelTarget,
      stream: false,
      messages: judgeMessages
    };
    try {
      const judgeRes = await dispatchToUpstream(judgeUpstream, judgeReq, clientSignal);
      if (judgeRes.ok) {
        const jData: any = await judgeRes.json();
        const synthesized = String(jData?.choices?.[0]?.message?.content || '').trim();
        if (synthesized) finalContent = synthesized;
      }
    } catch {
      // Fallback to first candidate if judge synthesis call fails
    }
  }

  const completionId = `chatcmpl-consensus-${Date.now()}`;
  const modelId = request.model || 'consensus';

  if (request.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ index: 0, delta: { role: 'assistant', content: finalContent }, finish_reason: null }]
            })}\n\n`
          )
        );
        ctrl.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            })}\n\n`
          )
        );
        ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
        ctrl.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'x-eluvix-consensus-strategy': strategy,
        'x-eluvix-consensus-candidates': successes.map((s) => s.upstream.id).join(',')
      }
    });
  }

  return new Response(
    JSON.stringify({
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: finalContent },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-eluvix-consensus-strategy': strategy,
        'x-eluvix-consensus-candidates': successes.map((s) => s.upstream.id).join(',')
      }
    }
  );
}
