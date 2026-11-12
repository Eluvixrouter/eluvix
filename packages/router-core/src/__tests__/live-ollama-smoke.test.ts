import { describe, it, expect } from 'vitest';
import { Eluvix } from '../index.js';

const runLiveOllama = process.env.ELUVIX_LIVE_OLLAMA === '1';

describe.skipIf(!runLiveOllama)('v1.2 Phase 4.4 — Opt-In Live Local Ollama Smoke Suite', () => {
  const endpoint = process.env.ELUVIX_OLLAMA_ENDPOINT || 'http://127.0.0.1:11434';

  it('discovers live Ollama models and completes a real local sovereign chat turn', async () => {
    const router = new Eluvix({
      strategy: 'priority',
      egressPolicy: 'local-only',
      upstreams: [
        {
          id: 'live-ollama',
          name: 'Live Local Ollama',
          type: 'ollama',
          endpoint,
          models: ['*'],
          priority: 1,
        },
      ],
    });

    const models = await router.detectModels('live-ollama', 4000);
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);

    const res = await router.routeChatCompletion({
      model: models[0],
      messages: [{ role: 'user', content: 'Reply with the single word Pong.' }],
      max_tokens: 16,
    });
    expect(res.status).toBe(200);
  });
});
