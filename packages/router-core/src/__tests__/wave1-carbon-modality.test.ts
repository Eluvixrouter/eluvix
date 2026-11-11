import { describe, it, expect } from 'vitest';
import {
  Eluvix,
  DEFAULT_AGY_MODELS,
  isAntigravitySupportedModel,
  resolveAntigravityEffort,
  parseAgyModelsOutput,
  classifyRequestModality,
  isExplicitMediaModelId,
} from '../index.js';

describe('Wave 1 — Track 1: Gemini 4 Carbon First-Class AGY Support', () => {
  it('includes gemini-4-carbon at the top of DEFAULT_AGY_MODELS with 2M context & Frontier tier', () => {
    const carbon = DEFAULT_AGY_MODELS.find((m) => m.baseId === 'gemini-4-carbon');
    expect(carbon).toBeDefined();
    expect(carbon?.tier).toBe('Frontier');
    expect(carbon?.contextLimit).toBe(2_097_152);
    expect(carbon?.outputLimit).toBe(65_536);
    expect(carbon?.variants).toContain('gemini-4-carbon-xhigh');
    expect(carbon?.variants).toContain('gemini-4-carbon-max');
    expect(DEFAULT_AGY_MODELS[0].baseId).toBe('gemini-4-carbon');
  });

  it('recognizes gemini-4-carbon and -xhigh/-max variants on cold cache and resolves effort cleanly', () => {
    expect(isAntigravitySupportedModel('gemini-4-carbon', [])).toBe(true);
    expect(isAntigravitySupportedModel('gemini-4-carbon-high', [])).toBe(true);
    expect(isAntigravitySupportedModel('gemini-4-carbon-xhigh', [])).toBe(true);
    expect(isAntigravitySupportedModel('gemini-4-carbon-max', [])).toBe(true);

    expect(resolveAntigravityEffort('gemini-4-carbon-xhigh', 'auto', 1)).toEqual({
      baseModel: 'gemini-4-carbon',
      effort: 'high',
    });
    expect(resolveAntigravityEffort('gemini-4-carbon-max', 'low', 1)).toEqual({
      baseModel: 'gemini-4-carbon',
      effort: 'high',
    });
    expect(resolveAntigravityEffort('gemini-4-carbon', 'auto', 4)).toEqual({
      baseModel: 'gemini-4-carbon',
      effort: 'high',
    });

    const parsed = parseAgyModelsOutput(
      [
        'gemini-4-carbon-low        Gemini 4 Carbon (Low)',
        'gemini-4-carbon-medium     Gemini 4 Carbon (Medium)',
        'gemini-4-carbon-high       Gemini 4 Carbon (High)',
        'gemini-4-carbon-max        Gemini 4 Carbon (Max)',
      ].join('\n')
    );
    const entry = parsed.find((m) => m.baseId === 'gemini-4-carbon');
    expect(entry).toBeDefined();
    expect(entry?.tier).toBe('Frontier');
    expect(entry?.contextLimit).toBe(2_097_152);
  });
});

describe('Wave 1 — Track 3: Modality-Aware Switchyard Routing & Synthesis Intent Classifier', () => {
  it('classifies image, video, and 3D synthesis intents while rejecting code/diagram false positives', () => {
    const slashImagine = classifyRequestModality({
      messages: [
        { role: 'user', content: '/imagine a bioluminescent glass observatory on Europa' },
      ],
    });
    expect(slashImagine.synthesisIntent).toBe('image-gen');
    expect(slashImagine.matchedTrigger).toBe('/imagine');

    const naturalPhoto = classifyRequestModality({
      messages: [
        {
          role: 'user',
          content:
            'Generate a cinematic photorealistic portrait of an astronaut in golden hour lighting',
        },
      ],
    });
    expect(naturalPhoto.synthesisIntent).toBe('image-gen');

    const videoPrompt = classifyRequestModality({
      messages: [
        { role: 'user', content: 'Render a short video animation of basalt waves crashing at dusk' },
      ],
    });
    expect(videoPrompt.synthesisIntent).toBe('video-gen');

    const meshPrompt = classifyRequestModality({
      messages: [
        { role: 'user', content: 'Generate a 3D mesh GLB asset of a low-poly sci-fi rover' },
      ],
    });
    expect(meshPrompt.synthesisIntent).toBe('3d-gen');

    // Negative guards: UI code, SQL, and Mermaid diagrams MUST stay 'text'
    const reactCode = classifyRequestModality({
      messages: [
        { role: 'user', content: 'Create an image carousel component in React and TypeScript' },
      ],
    });
    expect(reactCode.synthesisIntent).toBe('text');

    const mermaidDiagram = classifyRequestModality({
      messages: [
        { role: 'user', content: 'Draw a Mermaid sequence diagram illustrating OAuth2 PKCE' },
      ],
    });
    expect(mermaidDiagram.synthesisIntent).toBe('text');

    // Tool definitions always force text/agent execution
    const withTools = classifyRequestModality({
      messages: [{ role: 'user', content: 'Generate an image of a cat' }],
      tools: [{ type: 'function', function: { name: 'lookup_cat' } }],
    });
    expect(withTools.hasToolDefinitions).toBe(true);
    expect(withTools.synthesisIntent).toBe('text');

    expect(isExplicitMediaModelId('flux1-dev-fp8.safetensors')).toBe(true);
    expect(isExplicitMediaModelId('wan2.1_t2v_1.3B.safetensors')).toBe(true);
    expect(isExplicitMediaModelId('gemini-4-carbon')).toBe(false);
    expect(isExplicitMediaModelId('qwen2.5-coder:7b')).toBe(false);
  });

  it('isolates text & vision chat away from wildcard ComfyUI upstreams while steering synthesis prompts to ComfyUI', () => {
    const router = new Eluvix({
      strategy: 'priority',
      switchyard: {
        strategy: 'cost-complexity',
        mediaIntentRouting: true,
      },
      upstreams: [
        {
          id: 'comfy-flux',
          name: 'ComfyUI Flux Studio',
          type: 'comfyui',
          endpoint: 'http://127.0.0.1:8188',
          priority: 50, // Deliberately higher priority than Ollama!
          models: ['*'],
          comfyui: { workflowPreset: 'flux-txt2img' },
        },
        {
          id: 'comfy-wan',
          name: 'ComfyUI Wan Video',
          type: 'comfyui',
          endpoint: 'http://127.0.0.1:8189',
          priority: 45,
          models: ['*'],
          comfyui: { workflowPreset: 'wan21-txt2vid' },
        },
        {
          id: 'ollama-coder',
          name: 'Ollama Qwen Coder',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 25,
          models: ['qwen2.5-coder:7b', 'llava:latest', '*'],
          capabilities: ['vision'],
        },
      ],
    });

    // 1. Standard coding prompt must NOT route to higher-priority wildcard ComfyUI
    const codeExplain = router.explainRoute({
      model: 'auto',
      messages: [{ role: 'user', content: 'Implement Dijkstra shortest path in TypeScript' }],
    });
    expect(codeExplain.chosenUpstreamId).toBe('ollama-coder');
    expect(codeExplain.steps.some((s) => s.stage === 'modality-filter')).toBe(true);
    expect(codeExplain.modality?.synthesisIntent).toBe('text');

    // 2. Multimodal image-input (VLM) prompt must route to Ollama (vision), NOT ComfyUI
    const visionExplain = router.explainRoute({
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What error is shown in this terminal screenshot?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        },
      ],
    });
    expect(visionExplain.modality?.hasVisionInput).toBe(true);
    expect(visionExplain.chosenUpstreamId).toBe('ollama-coder');

    // 3. Explicit image synthesis prompt on model='auto' steers directly to ComfyUI Flux
    const imageExplain = router.explainRoute({
      model: 'auto',
      messages: [{ role: 'user', content: '/imagine a brutalist concrete lighthouse in fog' }],
    });
    expect(imageExplain.modality?.synthesisIntent).toBe('image-gen');
    expect(imageExplain.chosenUpstreamId).toBe('comfy-flux');

    // 4. Explicit video synthesis prompt prefers the wan21-txt2vid ComfyUI upstream
    const videoExplain = router.explainRoute({
      model: 'auto',
      messages: [
        { role: 'user', content: 'Generate a short video animation of aurora borealis over fjords' },
      ],
    });
    expect(videoExplain.modality?.synthesisIntent).toBe('video-gen');
    expect(videoExplain.chosenUpstreamId).toBe('comfy-wan');
  });
});
