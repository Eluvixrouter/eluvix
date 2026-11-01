import {
  escapeShellArg,
  sanitizeSafeIdentifier
} from './shell-utils.js';
import type { HarnessMcpServerConfig } from './harness/types.js';

export type VectorCraftBackendMode = 'auto' | 'remote' | 'headless';

export type VectorCraftPromptPreset =
  | 'none'
  | 'poster'
  | 'icon-set'
  | 'recolor'
  | 'trace-and-style'
  | 'export-set';

export type VectorCraftAutoApproveTier =
  | 'readonly-inspect'
  | 'canvas-draw'
  | 'full-automation';

export type VectorCraftExportFormat =
  | 'svg'
  | 'svgz'
  | 'pdf'
  | 'ai'
  | 'eps'
  | 'png'
  | 'jpg'
  | 'webp'
  | 'psd'
  | 'vectorcraft';

export interface VectorCraftMcpConfig {
  enabled?: boolean;
  /** Path or binary name for vectorcraft-cli (default: 'vectorcraft-cli') */
  cliCommand?: string;
  /** Alias for cliCommand */
  cliBinary?: string;
  /** Execution backend: 'auto' (tries 127.0.0.1:7979 then headless), 'remote' (--connect), or 'headless' (--headless) */
  backendMode?: VectorCraftBackendMode;
  /** Alias for backendMode */
  mode?: VectorCraftBackendMode;
  /** Control socket address for remote mode (default: '127.0.0.1:7979') */
  controlAddress?: string;
  /** Alias for controlAddress */
  connectAddress?: string;
  /** Directories passed to --automation-read-root */
  readRoots?: string[];
  /** Directories passed to --automation-write-root */
  writeRoots?: string[];
  /** Built-in MCP workflow prompt template to prime the agent with */
  defaultPromptWorkflow?: VectorCraftPromptPreset;
  /** Alias for defaultPromptWorkflow */
  promptPreset?: VectorCraftPromptPreset;
  /** Tool auto-approval tier for agent harnesses */
  autoApproveTier?: VectorCraftAutoApproveTier;
  /** Preferred export format for generated artwork */
  defaultExportFormat?: VectorCraftExportFormat;
  /** MCP JSON-RPC protocol revision (default: '2025-06-18') */
  protocolVersion?: '2025-06-18' | '2025-03-26' | '2024-11-05' | '2026-07-28';
  /** Whether to inject the <eluvix-vectorcraft-mcp> system instructions into routed requests (default: true) */
  injectSystemInstructions?: boolean;
}

/**
 * 8 Read-only inspection tools advertised with `readOnlyHint: true` by `vectorcraft-cli mcp`.
 */
export const VECTORCRAFT_READONLY_TOOLS: readonly string[] = [
  'command_list',
  'list_commands',
  'doc_inspect',
  'inspect_document',
  'render_preview',
  'ui_inspect',
  'inspect_ui',
  'ui_screenshot'
] as const;

/**
 * 6 UI-only tools that require a live desktop GUI connection (`--connect 127.0.0.1:7979`)
 * and return tool errors in `--headless` mode.
 */
export const VECTORCRAFT_REMOTE_UI_ONLY_TOOLS: readonly string[] = [
  'inspect_ui',
  'ui_inspect',
  'type_text',
  'answer_dialog',
  'open_panel',
  'ui_screenshot'
] as const;

/**
 * In-memory canvas drawing, styling, typography, pathfinder, and batch tools
 * (excludes filesystem write/open mutations and GUI dialog actions).
 */
export const VECTORCRAFT_CANVAS_DRAW_TOOLS: readonly string[] = [
  ...VECTORCRAFT_READONLY_TOOLS,
  'draw_shape',
  'draw_path',
  'set_paint',
  'add_text',
  'apply_effect',
  'pathfinder',
  'transform',
  'create_graph',
  'text_wrap',
  'select_tool',
  'pointer_gesture',
  'command_run',
  'run_command',
  'command_batch',
  'undo',
  'redo'
] as const;

/**
 * Complete set of 33 MCP tools exposed by `vectorcraft-cli mcp` (v0.19+).
 */
export const VECTORCRAFT_ALL_TOOLS: readonly string[] = [
  ...VECTORCRAFT_CANVAS_DRAW_TOOLS,
  'press_key',
  'type_text',
  'answer_dialog',
  'invoke_menu',
  'open_panel',
  'screenshot',
  'open_file',
  'save_file',
  'export'
] as const;

export interface VectorCraftPromptSpec {
  name: Exclude<VectorCraftPromptPreset, 'none'>;
  title: string;
  description: string;
  requiredArgs: string[];
  optionalArgs: string[];
}

export const VECTORCRAFT_PROMPTS: readonly VectorCraftPromptSpec[] = [
  {
    name: 'poster',
    title: 'Design a poster',
    description:
      'Lay out a poster from a brief: live shapes, gradients, type and live effects, checked with screenshots before export.',
    requiredArgs: ['brief'],
    optionalArgs: ['palette', 'text']
  },
  {
    name: 'icon-set',
    title: 'Draw an icon set',
    description:
      'Build a row of consistent icons as live vector shapes on a grid, then check them as a set.',
    requiredArgs: ['subject'],
    optionalArgs: ['count', 'detail']
  },
  {
    name: 'recolor',
    title: 'Recolour artwork',
    description:
      'Recolour the selection with explicit rows, or cluster its colours first with recolor.colors.',
    requiredArgs: ['palette'],
    optionalArgs: ['method']
  },
  {
    name: 'trace-and-style',
    title: 'Trace an image and style it',
    description:
      'Trace an image with Image Trace and expand the trace, then apply a live effect and recolor the result.',
    requiredArgs: ['path'],
    optionalArgs: ['preset', 'effect']
  },
  {
    name: 'export-set',
    title: 'Export an artboard set',
    description:
      'Export every artboard in several formats at once, with per-format options, and report what each one lost.',
    requiredArgs: [],
    optionalArgs: ['formats', 'directory', 'scale']
  }
] as const;

export const VECTORCRAFT_RESOURCES = {
  fixed: [
    {
      uri: 'vectorcraft://document',
      name: 'document',
      title: 'Active document (summary)',
      description: 'Layer tree, artboards, selection and history of the active document (document.inspect)'
    },
    {
      uri: 'vectorcraft://document/json',
      name: 'document-json',
      title: 'Active document (full model)',
      description: 'The complete document model as JSON (document.json)'
    },
    {
      uri: 'vectorcraft://commands',
      name: 'commands',
      title: 'Command catalog',
      description: 'Command ids, labels, parameter descriptions and current enabled state'
    }
  ],
  templates: [
    {
      uriTemplate: 'vectorcraft://object/{id}',
      name: 'object',
      title: 'One layer or object',
      description: 'Single layer or object summary with bounds, paint (opacity 0–1 and opacityPct 0–100%), and children'
    },
    {
      uriTemplate: 'vectorcraft://command/{id}',
      name: 'command',
      title: 'One command',
      description: 'Command label, menu path, shortcut, parameter description, and enablement'
    },
    {
      uriTemplate: 'vectorcraft://effect/{id}',
      name: 'effect',
      title: 'One live effect',
      description: 'Live effect parameters and defaults (effect.list)'
    },
    {
      uriTemplate: 'vectorcraft://swatch/{name}',
      name: 'swatch',
      title: 'One swatch',
      description: 'Swatch, colour, gradient or pattern swatch (percent-encode spaces)'
    }
  ]
} as const;

export interface VectorCraftCliBuildResult {
  cliCommand: string;
  /** Alias for cliCommand */
  command: string;
  /** Arguments passed to `vectorcraft-cli` (starting with `'mcp'`) */
  mcpArgs: string[];
  /** Alias for mcpArgs */
  args: string[];
  /** Optional desktop app launch arguments (`vectorcraft --control ...`) when using `remote` mode */
  appLaunchArgs: string[];
  /** Effective backend mode after accounting for `--automation-*-root` flags */
  effectiveMode: VectorCraftBackendMode;
  /** Note when `--automation-*-root` is combined with `remote` mode (enforced by the GUI app, not `--connect`) */
  confinementNote?: string;
}

/**
 * Builds the exact CLI arguments for `vectorcraft-cli mcp` and `vectorcraft` desktop control mode.
 *
 * Per `docs/mcp.md`:
 * - `--automation-read-root` and `--automation-write-root` on `vectorcraft-cli mcp` confine the headless
 *   server and imply `--headless`; passing them together with `--connect` is an error on the CLI.
 * - For a live remote session (`--connect 127.0.0.1:7979`), the desktop app confines itself when started
 *   with `vectorcraft --control 7979 --automation-read-root <dir> --automation-write-root <dir>`.
 */
export function buildVectorCraftCliArgs(config: VectorCraftMcpConfig): VectorCraftCliBuildResult {
  const cliCommand = (config.cliCommand || config.cliBinary || 'vectorcraft-cli').trim() || 'vectorcraft-cli';
  const mode: VectorCraftBackendMode = config.backendMode || config.mode || 'auto';
  const controlAddr = (config.controlAddress || config.connectAddress || '127.0.0.1:7979').trim() || '127.0.0.1:7979';
  const portMatch = controlAddr.match(/:(\d+)$/);
  const controlPort = portMatch ? portMatch[1] : '7979';

  const readRoots = (config.readRoots || []).map(r => r.trim()).filter(Boolean);
  const writeRoots = (config.writeRoots || []).map(r => r.trim()).filter(Boolean);
  const hasRoots = readRoots.length > 0 || writeRoots.length > 0;

  const mcpArgs: string[] = ['mcp'];
  const appLaunchArgs: string[] = ['--control', controlPort];

  if (mode === 'remote') {
    mcpArgs.push('--connect', controlAddr);
    for (const r of readRoots) {
      appLaunchArgs.push('--automation-read-root', r);
    }
    for (const w of writeRoots) {
      appLaunchArgs.push('--automation-write-root', w);
    }
    return {
      cliCommand,
      command: cliCommand,
      mcpArgs,
      args: mcpArgs,
      appLaunchArgs,
      effectiveMode: 'remote',
      ...(hasRoots
        ? {
            confinementNote:
              'In remote mode (--connect), filesystem roots are passed to the running desktop app (`vectorcraft --control`) because `--automation-*-root` on `vectorcraft-cli mcp` implies `--headless`.'
          }
        : {})
    };
  }

  if (mode === 'headless') {
    mcpArgs.push('--headless');
  }

  for (const r of readRoots) {
    mcpArgs.push('--automation-read-root', r);
  }
  for (const w of writeRoots) {
    mcpArgs.push('--automation-write-root', w);
  }

  return {
    cliCommand,
    command: cliCommand,
    mcpArgs,
    args: mcpArgs,
    appLaunchArgs,
    effectiveMode: mode === 'headless' || hasRoots ? 'headless' : 'auto',
    ...(mode === 'auto' && hasRoots
      ? {
          confinementNote:
            'Passing `--automation-read-root` or `--automation-write-root` to `vectorcraft-cli mcp` automatically implies `--headless`.'
        }
      : {})
  };
}

/**
 * Returns the explicit tool allowlist for `HarnessConfig.autoApproveTools`
 * corresponding to the selected `VectorCraftAutoApproveTier` or `VectorCraftMcpConfig`.
 */
export function resolveVectorCraftAutoApproveTools(
  tierOrConfig: VectorCraftAutoApproveTier | VectorCraftMcpConfig = 'canvas-draw',
  backendMode: VectorCraftBackendMode = 'auto'
): string[] {
  let tier: VectorCraftAutoApproveTier = 'canvas-draw';
  let effectiveMode: VectorCraftBackendMode = backendMode;

  if (typeof tierOrConfig === 'object' && tierOrConfig !== null) {
    tier = tierOrConfig.autoApproveTier || 'canvas-draw';
    effectiveMode = buildVectorCraftCliArgs(tierOrConfig).effectiveMode;
  } else {
    tier = tierOrConfig;
  }

  const baseList =
    tier === 'readonly-inspect'
      ? [...VECTORCRAFT_READONLY_TOOLS]
      : tier === 'full-automation'
        ? [...VECTORCRAFT_ALL_TOOLS]
        : [...VECTORCRAFT_CANVAS_DRAW_TOOLS];

  if (effectiveMode === 'headless') {
    const uiOnly = new Set<string>(VECTORCRAFT_REMOTE_UI_ONLY_TOOLS);
    return baseList.filter(t => !uiOnly.has(t));
  }
  return baseList;
}

/**
 * Converts a `VectorCraftMcpConfig` into a governed `HarnessMcpServerConfig`
 * for injection into Eluvix agent harnesses (`TrueForge`, `OpenCode`, `Cline`, `Aider`, `ACP`).
 */
export function toHarnessMcpServerConfig(config: VectorCraftMcpConfig): HarnessMcpServerConfig {
  const built = buildVectorCraftCliArgs(config);
  const tier = config.autoApproveTier || 'canvas-draw';
  const tools = resolveVectorCraftAutoApproveTools(tier, built.effectiveMode);

  return {
    name: 'vectorcraft',
    endpoint: `stdio://${built.cliCommand} ${built.mcpArgs.join(' ')}`,
    transport: 'stdio',
    tools
  };
}

/**
 * Detects whether a user prompt is asking to create, edit, inspect, trace, or export vector art / SVGs.
 */
export function isVectorArtPrompt(promptText: string): boolean {
  if (!promptText) return false;
  return /\b(vectorcraft|svg|vector\s+art|illustrator|artboard|pathfinder|bezier|draw_shape|draw_path|icon\s+set|poster\s+design|vector\s+illustration|recolor\s+artwork|image\s+trace)\b/i.test(
    promptText
  );
}

/**
 * Builds the `<eluvix-vectorcraft-mcp>` system context block so any routed LLM or agent harness
 * understands VectorCraft's coordinate system, `opacityPct` scale, resource templates, and `command_batch` semantics.
 */
export function buildVectorCraftSystemInstructions(config: VectorCraftMcpConfig): string {
  const built = buildVectorCraftCliArgs(config);
  const exportFmt = config.defaultExportFormat || 'svg';
  const presetName = config.defaultPromptWorkflow || config.promptPreset;
  const workflow = presetName && presetName !== 'none'
    ? VECTORCRAFT_PROMPTS.find(p => p.name === presetName)
    : undefined;

  const lines: string[] = [
    '<eluvix-vectorcraft-mcp>',
    `VectorCraft MCP Server (stdio JSON-RPC 2.0, revision ${config.protocolVersion || '2025-06-18'}, mode=${built.effectiveMode}):`,
    '- Coordinate Space: Points in document space (origin `(0, 0)` at first artboard top-left, `y` points DOWN, default artboard `612 x 792` US Letter).',
    '- Drawing Tools: Use `draw_shape` (`rectangle`, `ellipse`, `polygon`, `star`, `line`), `draw_path` (`points` or SVG `d` path string, `closed`, `fill`, `stroke`, `strokeWidth`, `opacity`, `effects`), and `add_text` (point type, area type, or `onPath`, with `vertical: true` for vertical CJK).',
    '- Atomic Batching: Use `command_batch` (`steps: [{id, params}]`, up to 256 steps, `atomic: true`, `label`) to group multi-shape illustrations into a single undo step and reference earlier created object IDs via `"$0.id"` or `"$last.id"`.',
    '- Opacity Scale Rule: `doc_inspect` reports `opacity` (0–1 fraction) AND `opacityPct` (0–100%). Always pass `opacityPct` (0–100) back to `draw_shape`, `draw_path`, `object.setProps`, and `transparency.set`.',
    '- Context-Efficient Inspection: Drill instead of dumping the full model — call `doc_inspect {depth: 0}` for top-level skeleton, `command_run` with `document.find` to locate objects, and read `vectorcraft://object/{id}` for single nodes.',
    `- Verification & Export: Preview work with \`render_preview {max_side: 1024}\` or \`screenshot\`, and export final artwork via \`export {format: "${exportFmt}"}\`.`
  ];

  if (built.effectiveMode === 'headless') {
    lines.push(
      `- Headless Constraint: UI-only tools (${VECTORCRAFT_REMOTE_UI_ONLY_TOOLS.join(', ')}) are disabled in headless mode; use \`doc_inspect\` and \`render_preview\` instead.`
    );
  }
  if (workflow) {
    lines.push(
      `- Active Workflow Preset: \`${workflow.name}\` (${workflow.title}) — ${workflow.description}`
    );
  }
  lines.push('</eluvix-vectorcraft-mcp>');
  return lines.join('\n');
}

/**
 * Generates a shell-safe setup & registration script (`vectorcraft-mcp-setup.sh`)
 * for Claude Code, Agent Harnesses, and MCP clients.
 */
export function generateVectorCraftSetupScript(
  nodeId: string,
  config: VectorCraftMcpConfig
): string {
  const safeId = sanitizeSafeIdentifier(nodeId, 'vectorcraft-mcp');
  const built = buildVectorCraftCliArgs(config);
  const safeCli = escapeShellArg(built.cliCommand, 'vectorcraft-cli');
  const escapedMcpArgs = built.mcpArgs.map(a => escapeShellArg(a, 'mcp')).join(' ');
  const escapedAppArgs = built.appLaunchArgs.map(a => escapeShellArg(a, '--control')).join(' ');
  const exportFmt = sanitizeSafeIdentifier(config.defaultExportFormat || 'svg', 'svg');

  const mcpServersJson = JSON.stringify(
    {
      mcpServers: {
        vectorcraft: {
          command: built.cliCommand,
          args: built.mcpArgs
        }
      }
    },
    null,
    2
  );

  const lines: string[] = [
    '#!/usr/bin/env bash',
    '# ==============================================================================',
    `# Eluvix VectorCraft MCP Server Setup (${safeId})`,
    `# Backend Mode: ${built.effectiveMode} | Protocol: ${config.protocolVersion || '2025-06-18'} | Export: ${exportFmt}`,
    '# ==============================================================================',
    'set -euo pipefail',
    ''
  ];

  if (built.confinementNote) {
    lines.push(`# NOTE: ${built.confinementNote}`);
    lines.push('');
  }

  if (built.effectiveMode === 'remote') {
    lines.push('# 1. Start VectorCraft Desktop GUI with Live Control Port before connecting MCP:');
    lines.push(`# vectorcraft ${escapedAppArgs} &`);
    lines.push('');
  }

  lines.push('# 2. Register VectorCraft MCP Server with Claude Code:');
  lines.push(`claude mcp add vectorcraft -- ${safeCli} ${escapedMcpArgs}`);
  lines.push('');
  lines.push('# 3. Standard MCP Client Configuration (mcpServers JSON):');
  lines.push("cat << 'EOF' > vectorcraft-mcp-config.json");
  lines.push(mcpServersJson);
  lines.push('EOF');
  lines.push('');
  lines.push('# 4. Smoke-Test VectorCraft Headless Art Pipeline (Atomic command_batch + Export):');
  lines.push(`printf '%s\\n' \\`);
  lines.push(
    `  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"eluvix-router","version":"1.0.17"}}}' \\`
  );
  lines.push(
    `  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"command_batch","arguments":{"atomic":true,"label":"Eluvix Generative Art","steps":[{"id":"draw_shape","params":{"shape":"rectangle","x":72,"y":72,"width":468,"height":648,"radius":24,"fill":"#0f172a","stroke":"#38bdf8","strokeWidth":3}},{"id":"draw_shape","params":{"shape":"star","cx":306,"cy":396,"radius1":140,"radius2":60,"points":5,"fill":"#f59e0b","stroke":"none"}}]}}}' \\`
  );
  lines.push(`  | ${safeCli} ${escapedMcpArgs}`);

  return lines.join('\n');
}
