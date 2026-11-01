import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ARTCRAFT_APPS_CATALOG,
  ARTCRAFT_APP_IDS,
  buildArtCraftCliArgs,
  resolveArtCraftAutoApproveTools,
  toArtCraftHarnessMcpServers,
  detectArtCraftAppsForPrompt,
  isArtCraftPrompt,
  buildArtCraftSystemInstructions,
  generateArtCraftSetupScript,
  Eluvix
} from '../index.js';

describe('ArtCraft Suite 14-App MCP Catalog & Router Integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers all 14 ArtCraft applications with valid CLI binaries, ports, and tool catalogs', () => {
    expect(ARTCRAFT_APP_IDS).toHaveLength(14);
    expect(ARTCRAFT_APP_IDS).toEqual([
      'vectorcraft',
      'photocraft',
      'filmcraft',
      'lightcraft',
      'pdfcraft',
      'effectcraft',
      'designcraft',
      'figcraft',
      'wordcraft',
      'soundcraft',
      'deckcraft',
      'cadcraft',
      'gridcraft',
      'craft-anything'
    ]);

    for (const appId of ARTCRAFT_APP_IDS) {
      const spec = ARTCRAFT_APPS_CATALOG[appId];
      expect(spec.id).toBe(appId);
      expect(spec.cliBinary).toBe(`${appId}-cli`);
      expect(spec.allTools.length).toBeGreaterThanOrEqual(10);
      expect(spec.readOnlyTools.length).toBeGreaterThan(2);
      expect(spec.exportFormats.length).toBeGreaterThan(0);
    }
  });

  it('builds exact remote flags per app (--connect, --bridge, --attach, or headless-only)', () => {
    // 1. PhotoCraft uses --bridge on port 9878
    const photo = buildArtCraftCliArgs({
      app: 'photocraft',
      backendMode: 'remote',
      readRoots: ['/assets/photos'],
      writeRoots: ['/tmp/renders']
    });
    expect(photo.cliCommand).toBe('photocraft-cli');
    expect(photo.mcpArgs).toEqual(['mcp', '--bridge', '127.0.0.1:9878']);
    expect(photo.appLaunchArgs).toEqual([
      '--control',
      '9878',
      '--automation-read-root',
      '/assets/photos',
      '--automation-write-root',
      '/tmp/renders'
    ]);
    expect(photo.effectiveMode).toBe('remote');

    // 2. FilmCraft uses --bridge on port 9876
    const film = buildArtCraftCliArgs({
      app: 'filmcraft',
      backendMode: 'remote'
    });
    expect(film.mcpArgs).toEqual(['mcp', '--bridge', '127.0.0.1:9876']);

    // 3. EffectCraft uses --bridge on port 9877
    const effect = buildArtCraftCliArgs({
      app: 'effectcraft',
      backendMode: 'remote'
    });
    expect(effect.mcpArgs).toEqual(['mcp', '--bridge', '127.0.0.1:9877']);

    // 4. FigCraft uses --attach on port 7979
    const fig = buildArtCraftCliArgs({
      app: 'figcraft',
      backendMode: 'remote',
      extraArgs: ['--timeout', '300']
    });
    expect(fig.mcpArgs).toEqual(['mcp', '--attach', '127.0.0.1:7979', '--timeout', '300']);

    // 5. SoundCraft uses --connect on port 7801
    const sound = buildArtCraftCliArgs({
      app: 'soundcraft',
      backendMode: 'remote'
    });
    expect(sound.mcpArgs).toEqual(['mcp', '--connect', '127.0.0.1:7801']);

    // 6. Craft-Anything defaults to headless with --deep --all-tools
    const craftAny = buildArtCraftCliArgs({
      app: 'craft-anything',
      backendMode: 'remote'
    });
    expect(craftAny.effectiveMode).toBe('headless');
    expect(craftAny.mcpArgs).toEqual(['mcp', '--deep', '--all-tools']);
  });

  it('generates multi-app HarnessMcpServerConfig bundles and filters remote UI tools in headless mode', () => {
    const servers = toArtCraftHarnessMcpServers({
      enabled: true,
      enabledApps: ['vectorcraft', 'figcraft', 'cadcraft'],
      backendMode: 'headless',
      autoApproveTier: 'full-automation'
    });

    expect(servers).toHaveLength(3);
    expect(servers.map(s => s.name)).toEqual(['vectorcraft', 'figcraft', 'cadcraft']);
    expect(servers[0].endpoint).toBe('stdio://vectorcraft-cli mcp --headless');
    // Remote UI-only tools (set_tool, pan_canvas, zoom_canvas, wait_for_changes) are stripped in headless mode
    expect(servers[0].tools).not.toContain('set_tool');
    expect(servers[1].tools).toContain('create_node');
    expect(servers[1].tools).not.toContain('wait_for_changes');
    expect(servers[2].tools).toContain('command_line');
    expect(servers[2].tools).toContain('query_entities');
  });

  it('detects relevant ArtCraft apps from natural language prompts', () => {
    expect(detectArtCraftAppsForPrompt('Color grade my video timeline with Lumetri in FilmCraft')).toContain(
      'filmcraft'
    );
    expect(detectArtCraftAppsForPrompt('Redact SSNs and fill out the PDF form fields')).toContain(
      'pdfcraft'
    );
    expect(detectArtCraftAppsForPrompt('Design a mobile UI component with Auto Layout in FigCraft')).toContain(
      'figcraft'
    );
    expect(detectArtCraftAppsForPrompt('Draft a 2D DXF floorplan and verify closed loops in CADCraft')).toContain(
      'cadcraft'
    );
    expect(detectArtCraftAppsForPrompt('Run a clean-room rebuild with rizin and frida_instrument_run')).toContain(
      'craft-anything'
    );
    expect(isArtCraftPrompt('Master a 14 LUFS audio stem bounce in SoundCraft', 'soundcraft')).toBe(
      true
    );
  });

  it('generates shell-safe setup scripts for multi-app ArtCraft bundles', () => {
    const script = generateArtCraftSetupScript('studio-bundle', {
      enabledApps: ['photocraft', 'figcraft', 'soundcraft'],
      backendMode: 'remote'
    });
    expect(script).toContain(
      "claude mcp add photocraft -- 'photocraft-cli' 'mcp' '--bridge' '127.0.0.1:9878'"
    );
    expect(script).toContain(
      "claude mcp add figcraft -- 'figcraft-cli' 'mcp' '--attach' '127.0.0.1:7979'"
    );
    expect(script).toContain(
      "claude mcp add soundcraft -- 'soundcraft-cli' 'mcp' '--connect' '127.0.0.1:7801'"
    );
    expect(script).toContain('PHOTOCRAFT_CONTROL_TOKEN');
  });

  it('injects <eluvix-artcraft-mcp> context and sets x-eluvix-artcraft-* headers during routing', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-artcraft-1',
          choices: [{ message: { role: 'assistant', content: 'Created FigCraft UI frame.' } }],
          usage: { prompt_tokens: 45, completion_tokens: 18 }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const router = new Eluvix({
      upstreams: [
        {
          id: 'design-agent',
          name: 'Design Studio Agent',
          type: 'openai-compatible',
          endpoint: 'http://127.0.0.1:11434/v1',
          priority: 1,
          models: ['*'],
          artcraft: {
            enabled: true,
            app: 'figcraft',
            enabledApps: ['figcraft', 'photocraft'],
            backendMode: 'remote'
          }
        }
      ]
    });

    const res = await router.routeChatCompletion({
      model: 'claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Build a responsive mobile_screen wireframe in FigCraft.' }]
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-artcraft-apps')).toBe('figcraft,photocraft');
    expect(res.headers.get('x-eluvix-artcraft-mode')).toBe('remote');
    expect(res.headers.get('x-eluvix-artcraft-protocol')).toBe('2025-06-18');
    expect(res.headers.get('x-eluvix-artcraft-detected')).toContain('figcraft');

    const systemContent = capturedBody.messages
      .filter((m: any) => m.role === 'system')
      .map((m: any) => m.content)
      .join('\n');
    expect(systemContent).toContain('<eluvix-artcraft-mcp>');
    expect(systemContent).toContain('FigCraft');
    expect(systemContent).toContain('PhotoCraft');
  });
});
