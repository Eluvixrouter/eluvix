import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildVectorCraftCliArgs,
  resolveVectorCraftAutoApproveTools,
  toHarnessMcpServerConfig,
  isVectorArtPrompt,
  buildVectorCraftSystemInstructions,
  generateVectorCraftSetupScript,
  VECTORCRAFT_ALL_TOOLS,
  VECTORCRAFT_READONLY_TOOLS,
  VECTORCRAFT_REMOTE_UI_ONLY_TOOLS,
  VECTORCRAFT_PROMPTS,
  VECTORCRAFT_RESOURCES,
  Eluvix
} from '../index.js';

describe('VectorCraft MCP Integration (@eluvix/router-core)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the full VectorCraft v0.19.0 MCP tool, prompt, and resource catalog', () => {
    expect(VECTORCRAFT_ALL_TOOLS.length).toBe(33);
    expect(VECTORCRAFT_READONLY_TOOLS.length).toBe(8);
    expect(VECTORCRAFT_REMOTE_UI_ONLY_TOOLS.length).toBe(9);
    expect(VECTORCRAFT_PROMPTS.map(p => p.name)).toEqual([
      'poster',
      'icon-set',
      'recolor',
      'trace-and-style',
      'export-set'
    ]);
    expect(VECTORCRAFT_RESOURCES.fixed.map(r => r.uri)).toEqual([
      'vectorcraft://document',
      'vectorcraft://document/json',
      'vectorcraft://commands'
    ]);
    expect(VECTORCRAFT_RESOURCES.templates.length).toBe(4);
  });

  it('builds CLI args for auto, headless, and remote modes respecting --connect vs --automation-*-root constraints', () => {
    // 1. Default auto mode without roots
    const autoSpec = buildVectorCraftCliArgs({ backendMode: 'auto' });
    expect(autoSpec.command).toBe('vectorcraft-cli');
    expect(autoSpec.args).toEqual(['mcp']);
    expect(autoSpec.effectiveMode).toBe('auto');

    // 2. Auto mode with read/write roots automatically promotes to headless per docs/mcp.md
    const autoWithRoots = buildVectorCraftCliArgs({
      backendMode: 'auto',
      readRoots: ['/workspace/assets', '/workspace/fonts'],
      writeRoots: ['/workspace/exports']
    });
    expect(autoWithRoots.effectiveMode).toBe('headless');
    expect(autoWithRoots.args).toEqual([
      'mcp',
      '--automation-read-root',
      '/workspace/assets',
      '--automation-read-root',
      '/workspace/fonts',
      '--automation-write-root',
      '/workspace/exports'
    ]);

    // 3. Remote mode puts --connect on vectorcraft-cli mcp and moves --automation-*-root to appLaunchArgs
    const remoteSpec = buildVectorCraftCliArgs({
      backendMode: 'remote',
      controlAddress: '127.0.0.1:7979',
      readRoots: ['/workspace/assets'],
      writeRoots: ['/workspace/exports']
    });
    expect(remoteSpec.effectiveMode).toBe('remote');
    expect(remoteSpec.args).toEqual(['mcp', '--connect', '127.0.0.1:7979']);
    expect(remoteSpec.args).not.toContain('--automation-read-root');
    expect(remoteSpec.appLaunchArgs).toEqual([
      '--control',
      '7979',
      '--automation-read-root',
      '/workspace/assets',
      '--automation-write-root',
      '/workspace/exports'
    ]);
  });

  it('filters out remote UI-only tools when resolving auto-approve tools in headless mode', () => {
    const headlessFull = resolveVectorCraftAutoApproveTools({
      backendMode: 'headless',
      autoApproveTier: 'full-automation'
    });
    expect(headlessFull.length).toBe(24);
    for (const uiOnly of VECTORCRAFT_REMOTE_UI_ONLY_TOOLS) {
      expect(headlessFull).not.toContain(uiOnly);
    }

    const remoteFull = resolveVectorCraftAutoApproveTools({
      backendMode: 'remote',
      autoApproveTier: 'full-automation'
    });
    expect(remoteFull.length).toBe(33);
    for (const uiOnly of VECTORCRAFT_REMOTE_UI_ONLY_TOOLS) {
      expect(remoteFull).toContain(uiOnly);
    }
  });

  it('creates a valid HarnessMcpServerConfig for ACP and Claude Code', () => {
    const mcpCfg = toHarnessMcpServerConfig({
      backendMode: 'headless',
      cliCommand: 'vectorcraft-cli',
      readRoots: ['/art/in'],
      writeRoots: ['/art/out']
    });
    expect(mcpCfg.name).toBe('vectorcraft');
    expect(mcpCfg.transport).toBe('stdio');
    expect(mcpCfg.endpoint).toBe(
      'stdio://vectorcraft-cli mcp --headless --automation-read-root /art/in --automation-write-root /art/out'
    );
  });

  it('detects vector art prompts and builds <eluvix-vectorcraft-mcp> system instructions', () => {
    expect(isVectorArtPrompt('Design an SVG poster with an artboard and bezier curves')).toBe(true);
    expect(isVectorArtPrompt('What is 2 + 2?')).toBe(false);

    const sysBlock = buildVectorCraftSystemInstructions({
      backendMode: 'headless',
      defaultPromptWorkflow: 'poster',
      defaultExportFormat: 'svg',
      writeRoots: ['/tmp/art']
    });
    expect(sysBlock).toContain('<eluvix-vectorcraft-mcp>');
    expect(sysBlock).toContain('opacityPct');
    expect(sysBlock).toContain('command_batch');
    expect(sysBlock).toContain('Active Workflow Preset: `poster`');
    expect(sysBlock).toContain('</eluvix-vectorcraft-mcp>');
  });

  it('generates a shell-escaped setup script for remote and headless modes', () => {
    const script = generateVectorCraftSetupScript('vc-node-1', {
      backendMode: 'remote',
      controlAddress: '127.0.0.1:7979',
      readRoots: ['/home/user/assets'],
      writeRoots: ['/home/user/exports'],
      defaultPromptWorkflow: 'icon-set'
    });
    expect(script).toContain('--control');
    expect(script).toContain('claude mcp add vectorcraft');
  });

  it('injects VectorCraft MCP system instructions and sets x-eluvix-vectorcraft-* headers during routing', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-vc-1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Created SVG poster.' } }],
          usage: { prompt_tokens: 64, completion_tokens: 16 }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const router = new Eluvix({
      upstreams: [
        {
          id: 'vc-artist-upstream',
          name: 'VectorCraft Artist Node',
          type: 'openai-compatible',
          endpoint: 'http://127.0.0.1:11434/v1',
          priority: 1,
          models: ['*'],
          vectorcraft: {
            enabled: true,
            mode: 'headless',
            promptPreset: 'poster',
            readRoots: ['/tmp/vc-in'],
            writeRoots: ['/tmp/vc-out']
          }
        }
      ]
    });

    const res = await router.routeChatCompletion({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Create a geometric poster in VectorCraft and export to SVG.' }]
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-vectorcraft-mode')).toBe('headless');
    expect(res.headers.get('x-eluvix-vectorcraft-protocol')).toBe('2025-06-18');
    expect(res.headers.get('x-eluvix-vectorcraft-tools')).toBe('27');
    expect(res.headers.get('x-eluvix-vectorcraft-preset')).toBe('poster');

    expect(capturedBody).toBeTruthy();
    const systemMessages = capturedBody.messages.filter((m: any) => m.role === 'system');
    expect(systemMessages.some((m: any) => String(m.content).includes('<eluvix-vectorcraft-mcp>'))).toBe(true);
  });
});
