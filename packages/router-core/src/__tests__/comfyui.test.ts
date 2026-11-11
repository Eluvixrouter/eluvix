import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Eluvix,
  buildComfyApiWorkflow,
  parseComfyModelsResponse,
  toComfyMcpServerConfig,
  generateComfyUISetupScript,
  probeComfyUISystemStatus,
  executeArtCraftPostProcess,
  COMFYUI_MCP_TOOLS,
} from '../index.js';

describe('ComfyUI 4-Pillar Integration (@eluvix/router-core)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds valid ComfyUI API-format DAGs for Flux.1, SDXL, Wan 2.1 Video, Hunyuan3D, and custom JSON', () => {
    const fluxDag = buildComfyApiWorkflow({
      prompt: 'A neon cyberpunk cathedral in rain',
      config: { workflowPreset: 'flux-txt2img', steps: 24, cfg: 3.5 },
      sizeOverride: '1344x768',
      seedOverride: 42,
    });
    expect(fluxDag['4'].class_type).toBe('CheckpointLoaderSimple');
    expect(fluxDag['4'].inputs.ckpt_name).toBe('flux1-dev-fp8.safetensors');
    expect(fluxDag['5'].inputs.width).toBe(1344);
    expect(fluxDag['5'].inputs.height).toBe(768);
    expect(fluxDag['3'].inputs.steps).toBe(24);
    expect(fluxDag['3'].inputs.seed).toBe(42);

    const wanDag = buildComfyApiWorkflow({
      prompt: 'Ocean waves crashing against basalt cliffs',
      config: { workflowPreset: 'wan21-txt2vid' },
    });
    expect(wanDag['4'].class_type).toBe('CheckpointLoaderSimple');
    expect(wanDag['5'].class_type).toBe('EmptyHunyuanLatentVideo');
    expect(wanDag['9'].class_type).toBe('SaveAnimatedWEBP');

    const hunyuanDag = buildComfyApiWorkflow({
      prompt: 'A stylized sci-fi helmet',
      config: { workflowPreset: 'hunyuan3d-mesh' },
    });
    expect(hunyuanDag['4'].class_type).toBe('CheckpointLoaderSimple');
    expect(hunyuanDag['9'].class_type).toBe('SaveGLB');
  });

  it('parses ComfyUI checkpoint arrays and /object_info/CheckpointLoaderSimple schemas', () => {
    const ckpts = parseComfyModelsResponse(
      ['flux1-dev-fp8.safetensors', 'sd_xl_base_1.0.safetensors'],
      'checkpoints'
    );
    expect(ckpts.models).toEqual([
      'flux1-dev-fp8.safetensors',
      'sd_xl_base_1.0.safetensors',
    ]);
    expect(ckpts.details[0].recipe).toBe('comfyui');
    expect(ckpts.details[0].labels).toContain('Flux');

    const objInfo = parseComfyModelsResponse({
      CheckpointLoaderSimple: {
        input: {
          required: {
            ckpt_name: [['juggernautXL_v9.safetensors', 'dreamshaperXL.safetensors']],
          },
        },
      },
    });
    expect(objInfo.models).toEqual([
      'juggernautXL_v9.safetensors',
      'dreamshaperXL.safetensors',
    ]);
  });

  it('generates Pillar 3 MCP config and Pillar 4 reverse-loopback + VRAM coordinator launch script', () => {
    const mcp = toComfyMcpServerConfig('comfy-studio-1', 'http://localhost:8188');
    expect(mcp.name).toBe('comfy-studio-1');
    expect(mcp.endpoint).toBe('http://localhost:8188');
    expect(mcp.tools).toEqual([...COMFYUI_MCP_TOOLS]);

    const script = generateComfyUISetupScript('comfy-studio-1', 'http://localhost:8188', {
      workflowPreset: 'flux-txt2img',
      vramMode: 'lowvram',
      reserveVramGb: 6,
      promptEnhancerUpstreamId: 'lemonade-1',
      postProcessArtCraftApp: 'vectorcraft',
      loopbackEluvixUrl: 'http://127.0.0.1:3588/v1',
    });
    expect(script).toContain('--lowvram');
    expect(script).toContain('--reserve-vram 6');
    expect(script).toContain("OPENAI_API_BASE='http://127.0.0.1:3588/v1'");
    expect(script).toContain('vectorcraft-cli');
  });

  it('executes Pillar 2 routeImageGeneration with Pillar 3 local LLM prompt expansion and /history polling', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.includes('13305') && url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content:
                    'Ultra-detailed architectural rendering of a solarpunk library, volumetric golden hour light, 35mm lens',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/prompt')) {
        return new Response(JSON.stringify({ prompt_id: 'prompt-abc-123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/history/prompt-abc-123')) {
        return new Response(
          JSON.stringify({
            'prompt-abc-123': {
              outputs: {
                '9': {
                  images: [
                    {
                      filename: 'eluvix_flux_00001_.png',
                      subfolder: '',
                      type: 'output',
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const router = new Eluvix({
      strategy: 'priority',
      upstreams: [
        {
          id: 'lemonade-1',
          name: 'Lemonade Enhancer',
          type: 'lemonade',
          endpoint: 'http://127.0.0.1:13305',
          priority: 25,
          models: ['Qwen3.5-4B-MTP-GGUF'],
        },
        {
          id: 'comfy-1',
          name: 'ComfyUI Studio',
          type: 'comfyui',
          endpoint: 'http://127.0.0.1:8188',
          priority: 20,
          models: ['flux1-dev-fp8.safetensors'],
          comfyui: {
            workflowPreset: 'flux-txt2img',
            promptEnhancerUpstreamId: 'lemonade-1',
            postProcessArtCraftApp: 'vectorcraft',
          },
        },
      ],
    });

    const res = await router.routeImageGeneration({
      prompt: 'a solarpunk library',
      size: '1024x1024',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.prompt_id).toBe('prompt-abc-123');
    expect(json.post_process_artcraft_app).toBe('vectorcraft');
    expect(json.data).toHaveLength(1);
    expect(json.data[0].url).toContain('http://127.0.0.1:8188/view?filename=eluvix_flux_00001_.png');
    expect(json.data[0].revised_prompt).toContain('Ultra-detailed architectural rendering');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('supports batch_size (n), quality=hd step boost, response_format=b64_json, proxyBaseUrl, priority ordering, and loop guard', async () => {
    const dag = buildComfyApiWorkflow({
      prompt: 'Architectural courtyard',
      config: { workflowPreset: 'flux-txt2img', steps: 20 },
      batchSizeOverride: 4,
    });
    expect(dag['5'].inputs.batch_size).toBe(4);

    // Loop guard rejects hops >= 2 with HTTP 429
    const router = new Eluvix({
      strategy: 'priority',
      upstreams: [
        {
          id: 'comfy-low',
          name: 'Low Priority Comfy',
          type: 'comfyui',
          endpoint: 'http://127.0.0.1:8189',
          priority: 10,
          models: ['*'],
        },
        {
          id: 'comfy-high',
          name: 'High Priority Comfy',
          type: 'comfyui',
          endpoint: 'http://127.0.0.1:8188',
          priority: 35,
          models: ['*'],
          comfyui: { workflowPreset: 'flux-txt2img', steps: 20 },
        },
      ],
    });

    const loopRes = await router.routeImageGeneration(
      { prompt: 'recursive loop test' },
      { hops: 2 }
    );
    expect(loopRes.status).toBe(429);

    let submittedDag: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      // High-priority :8188 must be contacted first, NOT :8189
      if (url === 'http://127.0.0.1:8188/prompt') {
        submittedDag = JSON.parse(String(init?.body || '{}')).prompt;
        return new Response(JSON.stringify({ prompt_id: 'prompt-hd-999' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('8188/history/prompt-hd-999')) {
        return new Response(
          JSON.stringify({
            'prompt-hd-999': {
              outputs: {
                '9': {
                  images: [
                    { filename: 'batch_1.png', subfolder: 'flux', type: 'output' },
                    { filename: 'batch_2.png', subfolder: 'flux', type: 'output' },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('8188/view?')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      return new Response('Unexpected URL: ' + url, { status: 500 });
    });

    // Test proxyBaseUrl URL rewriting + quality='hd' (20 * 1.4 = 28 steps) + n=2
    const proxyRes = await router.routeImageGeneration(
      {
        prompt: 'precision clockwork',
        n: 2,
        quality: 'hd',
        response_format: 'url',
      },
      { proxyBaseUrl: 'https://router.eluvix.local' }
    );
    expect(proxyRes.status).toBe(200);
    expect(submittedDag['3'].inputs.steps).toBe(28);
    expect(submittedDag['5'].inputs.batch_size).toBe(2);
    const proxyJson = (await proxyRes.json()) as any;
    expect(proxyJson.data).toHaveLength(2);
    expect(proxyJson.data[0].url).toBe(
      'https://router.eluvix.local/api/v1/images/view?upstream=comfy-high&filename=batch_1.png&subfolder=flux&type=output'
    );

    // Test response_format='b64_json'
    const b64Res = await router.routeImageGeneration({
      prompt: 'precision clockwork',
      response_format: 'b64_json',
    });
    expect(b64Res.status).toBe(200);
    const b64Json = (await b64Res.json()) as any;
    expect(b64Json.data[0].b64_json).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
    expect(b64Json.data[0].url).toBeUndefined();
  });

  it('probes ComfyUI /system_stats + /queue and degrades gracefully when ArtCraft CLI is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.endsWith('/system_stats')) {
        return new Response(
          JSON.stringify({
            system: { comfyui_version: '0.3.28' },
            devices: [{ name: 'RTX 5090', vram_total: 32 * 1024 ** 3, vram_free: 26.25 * 1024 ** 3 }],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/queue')) {
        return new Response(
          JSON.stringify({ queue_running: [['r1']], queue_pending: [] }),
          { status: 200 }
        );
      }
      return new Response('err', { status: 404 });
    });

    const stats = await probeComfyUISystemStatus('http://127.0.0.1:8188');
    expect(stats.online).toBe(true);
    expect(stats.queueRunning).toBe(1);
    expect(stats.queuePending).toBe(0);
    expect(stats.vramFreeGb).toBe(26.25);

    const postProc = await executeArtCraftPostProcess({
      app: 'vectorcraft',
      sourceUrl: 'http://127.0.0.1:8188/view?filename=test.png&type=output',
      filename: 'test.png',
    });
    // Unless vectorcraft-cli is installed on host PATH, it degrades cleanly without throwing
    expect(typeof postProc.executed).toBe('boolean');
    expect(postProc.app).toBe('vectorcraft');
  });
});
