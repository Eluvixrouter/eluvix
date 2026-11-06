import {
  escapeShellArg,
  sanitizeSafeIdentifier
} from './shell-utils.js';
import type { HarnessMcpServerConfig } from './harness/types.js';
import {
  VECTORCRAFT_ALL_TOOLS,
  VECTORCRAFT_READONLY_TOOLS,
  VECTORCRAFT_REMOTE_UI_ONLY_TOOLS,
  VECTORCRAFT_PROMPTS,
  VECTORCRAFT_RESOURCES
} from './vectorcraft-mcp.js';

/**
 * All 14 open-source Rust creative, office, CAD, and engineering applications
 * from the ArtCraft Suite (https://getartcraft.com/apps / https://github.com/storytold).
 */
export type ArtCraftAppId =
  | 'vectorcraft'
  | 'photocraft'
  | 'filmcraft'
  | 'lightcraft'
  | 'pdfcraft'
  | 'effectcraft'
  | 'designcraft'
  | 'figcraft'
  | 'wordcraft'
  | 'soundcraft'
  | 'deckcraft'
  | 'cadcraft'
  | 'gridcraft'
  | 'craft-anything';

export type ArtCraftBackendMode = 'auto' | 'remote' | 'headless';

export type ArtCraftAutoApproveTier =
  | 'readonly-inspect'
  | 'workspace-edit'
  | 'full-automation';

export type ArtCraftRemoteFlagStyle = 'connect' | 'bridge' | 'attach' | 'none';

export interface ArtCraftAppSpec {
  id: ArtCraftAppId;
  name: string;
  tagline: string;
  category: 'creative' | 'video-audio' | 'design-layout' | 'documents-data' | 'engineering';
  icon: string;
  cliBinary: string;
  desktopBinary: string;
  defaultControlPort: number | null;
  remoteFlagStyle: ArtCraftRemoteFlagStyle;
  /** Environment variable used for control channel token authentication when applicable */
  controlTokenEnv?: string;
  supportsAutomationRoots: boolean;
  /** Additional app-specific CLI flags supported on `<app>-cli mcp` */
  extraFlagHint?: string;
  defaultExportFormat: string;
  exportFormats: readonly string[];
  readOnlyTools: readonly string[];
  remoteUiOnlyTools: readonly string[];
  allTools: readonly string[];
  resources: readonly string[];
  prompts: readonly string[];
  conventionsSummary: string[];
  promptKeywords: RegExp;
}

export const ARTCRAFT_APPS_CATALOG: Record<ArtCraftAppId, ArtCraftAppSpec> = {
  vectorcraft: {
    id: 'vectorcraft',
    name: 'VectorCraft',
    tagline: 'Vector illustration, Bézier paths, Pathfinder & multi-artboard SVG/PDF/AI studio',
    category: 'creative',
    icon: '🎨',
    cliBinary: 'vectorcraft-cli',
    desktopBinary: 'vectorcraft',
    defaultControlPort: 7979,
    remoteFlagStyle: 'connect',
    supportsAutomationRoots: true,
    defaultExportFormat: 'svg',
    exportFormats: ['svg', 'svgz', 'pdf', 'ai', 'eps', 'png', 'jpg', 'webp', 'psd', 'vectorcraft'],
    readOnlyTools: VECTORCRAFT_READONLY_TOOLS,
    remoteUiOnlyTools: VECTORCRAFT_REMOTE_UI_ONLY_TOOLS,
    allTools: VECTORCRAFT_ALL_TOOLS,
    resources: [
      ...VECTORCRAFT_RESOURCES.fixed.map(r => r.uri),
      ...VECTORCRAFT_RESOURCES.templates.map(t => t.uriTemplate)
    ],
    prompts: VECTORCRAFT_PROMPTS.map(p => p.name),
    conventionsSummary: [
      'Coordinates are points in document space (`612 x 792` US Letter default, origin `(0,0)` top-left, `y` down).',
      'Always pass `opacityPct` (`0..100`) to `draw_shape`, `draw_path`, `object.setProps`, and `transparency.set`.',
      'Use `command_batch` (`atomic: true`, up to 256 steps) with `"$0.id"` / `"$last.id"` references for multi-shape illustrations.'
    ],
    promptKeywords: /\b(vectorcraft|svg|vector\s+art|illustrator|artboard|pathfinder|bezier|draw_shape|draw_path|icon\s+set|vector\s+illustration)\b/i
  },

  photocraft: {
    id: 'photocraft',
    name: 'PhotoCraft',
    tagline: 'Layered raster image editing, masks, adjustment layers, brushes & PSD/OpenRaster studio',
    category: 'creative',
    icon: '🖼️',
    cliBinary: 'photocraft-cli',
    desktopBinary: 'photocraft',
    defaultControlPort: 9878,
    remoteFlagStyle: 'bridge',
    controlTokenEnv: 'PHOTOCRAFT_CONTROL_TOKEN',
    supportsAutomationRoots: true,
    defaultExportFormat: 'png',
    exportFormats: ['png', 'jpg', 'tiff', 'webp', 'psd', 'psb', 'ora', 'pdf', 'pcraft'],
    readOnlyTools: ['command_list', 'doc_inspect', 'render_preview', 'ui_inspect', 'ui_screenshot'],
    remoteUiOnlyTools: ['ui_inspect', 'ui_screenshot'],
    allTools: [
      'command_list',
      'command_run',
      'command_batch',
      'doc_inspect',
      'render_preview',
      'doc_open',
      'doc_save',
      'doc_export',
      'ui_inspect',
      'ui_screenshot'
    ],
    resources: ['photocraft://document', 'photocraft://commands'],
    prompts: [],
    conventionsSummary: [
      'Use `doc_inspect` to read the layer tree, active selection, and history (`document: null` when empty).',
      'Use `render_preview {max_side: 1024}` (up to 2048) to inspect composited raster changes before `doc_export`.',
      '`doc_save` and `doc_export` overwrite existing files only when they match an image/document format PhotoCraft writes.'
    ],
    promptKeywords: /\b(photocraft|photoshop|raster\s+layer|adjustment\s+layer|layer\s+mask|openraster|psb|retouch|pixel\s+edit)\b/i
  },

  filmcraft: {
    id: 'filmcraft',
    name: 'FilmCraft',
    tagline: 'Non-linear video editor (NLE), Lumetri color grading, 24-track DSP audio mixer & FCPXML/AAF',
    category: 'video-audio',
    icon: '🎬',
    cliBinary: 'filmcraft-cli',
    desktopBinary: 'filmcraft',
    defaultControlPort: 9876,
    remoteFlagStyle: 'bridge',
    controlTokenEnv: 'FILMCRAFT_CONTROL_TOKEN',
    supportsAutomationRoots: true,
    defaultExportFormat: 'mp4',
    exportFormats: ['mp4', 'mov', 'mkv', 'webm', 'fcpxml', 'aaf', 'edl', 'wav', 'gif', 'png'],
    readOnlyTools: [
      'command_list',
      'doc_inspect',
      'project_inspect',
      'sequence_inspect',
      'render_preview',
      'render_frame',
      'ui_inspect',
      'ui_elements',
      'ui_screenshot'
    ],
    remoteUiOnlyTools: [
      'ui_inspect',
      'ui_elements',
      'ui_click',
      'ui_drag',
      'ui_key',
      'ui_type',
      'ui_screenshot',
      'ui_control'
    ],
    allTools: [
      'command_list',
      'command_run',
      'command_batch',
      'doc_inspect',
      'project_inspect',
      'sequence_inspect',
      'media_import',
      'render_preview',
      'render_frame',
      'ui_inspect',
      'ui_elements',
      'ui_click',
      'ui_drag',
      'ui_key',
      'ui_type',
      'ui_screenshot',
      'ui_control'
    ],
    resources: ['filmcraft://project', 'filmcraft://sequence', 'filmcraft://commands'],
    prompts: [],
    conventionsSummary: [
      'Over 650 engine commands (`sequence.addEdit`, `timeline.move`, `file.exportMedia`) dispatch via `command_run` or `command_batch`.',
      'Use `doc_inspect` (or `project_inspect` + `sequence_inspect`) to inspect bins, tracks, clip timecodes, and Lumetri color keyframes.',
      'Use `render_frame {seconds}` to verify the Program monitor picture at any timestamp.'
    ],
    promptKeywords: /\b(filmcraft|video\s+edit|timeline\s+cut|lumetri|fcpxml|b-roll|color\s+grade|nle|sequence_inspect|render_frame)\b/i
  },

  lightcraft: {
    id: 'lightcraft',
    name: 'LightCraft',
    tagline: 'RAW photography darkroom, non-destructive catalog, develop sliders, presets & lens corrections',
    category: 'creative',
    icon: '📸',
    cliBinary: 'lightcraft-cli',
    desktopBinary: 'lightcraft',
    defaultControlPort: 7980,
    remoteFlagStyle: 'connect',
    supportsAutomationRoots: false,
    extraFlagHint: '--demo or --library <DIR>',
    defaultExportFormat: 'jpg',
    exportFormats: ['jpg', 'png', 'tiff', 'dng', 'webp', 'avif'],
    readOnlyTools: [
      'command_list',
      'list_commands',
      'doc_inspect',
      'render_preview',
      'query_photos',
      'list_controls',
      'get_develop',
      'render_photo',
      'inspect_ui',
      'list_widgets',
      'screenshot'
    ],
    remoteUiOnlyTools: [
      'screenshot',
      'inspect_ui',
      'set_ui',
      'list_widgets',
      'click',
      'press_key',
      'type_text',
      'clipboard',
      'pointer_gesture'
    ],
    allTools: [
      'command_list',
      'command_run',
      'command_batch',
      'doc_inspect',
      'render_preview',
      'list_commands',
      'run_command',
      'import',
      'query_photos',
      'select_photos',
      'list_controls',
      'get_develop',
      'set_develop',
      'apply_preset',
      'crop',
      'render_photo',
      'export',
      'screenshot',
      'inspect_ui',
      'set_ui',
      'list_widgets',
      'click',
      'press_key',
      'type_text',
      'clipboard',
      'pointer_gesture'
    ],
    resources: [
      'lightcraft://library',
      'lightcraft://photos',
      'lightcraft://photo/active',
      'lightcraft://develop/active',
      'lightcraft://controls'
    ],
    prompts: [],
    conventionsSummary: [
      'A LightCraft library (`--library DIR`) holds a `catalog.lock`; use `--connect 127.0.0.1:7980` when the desktop app already has the library open.',
      'Use `list_controls`, `get_develop`, and `set_develop {values: {"light.exposure": 0.5}}` for non-destructive RAW grading.',
      'Use `render_photo` or `render_preview` to inspect developed output without changing catalog selection.'
    ],
    promptKeywords: /\b(lightcraft|lightroom|raw\s+develop|photo\s+catalog|exposure\s+slider|set_develop|query_photos|darkroom)\b/i
  },

  pdfcraft: {
    id: 'pdfcraft',
    name: 'PdfCraft',
    tagline: 'PDF inspection, page assembly, OCR, redaction, form filling, accessibility & digital signatures',
    category: 'documents-data',
    icon: '📄',
    cliBinary: 'pdfcraft-cli',
    desktopBinary: 'pdfcraft',
    defaultControlPort: null,
    remoteFlagStyle: 'none',
    supportsAutomationRoots: true,
    extraFlagHint: '--root <DIR> --compact',
    defaultExportFormat: 'pdf',
    exportFormats: ['pdf', 'png', 'txt', 'html', 'docx', 'json'],
    readOnlyTools: ['command_list', 'doc_inspect', 'render_preview'],
    remoteUiOnlyTools: [],
    allTools: [
      'command_list',
      'command_run',
      'command_batch',
      'doc_inspect',
      'render_preview',
      'doc_open',
      'doc_save',
      'doc_combine',
      'doc_split',
      'doc_reduce',
      'doc_optimize',
      'page_extract',
      'page_insert_file',
      'page_replace',
      'ocr_recognize_files',
      'form_merge_data',
      'sign_document',
      'comments_summarize',
      'doc_compare_report'
    ],
    resources: ['pdfcraft://document', 'pdfcraft://commands'],
    prompts: [],
    conventionsSummary: [
      '`pdfcraft-cli mcp` runs strictly over stdio and opens no network port; use `--root <DIR>` or `--automation-read-root` / `--automation-write-root` to confine file access.',
      'Use `doc_inspect` to inspect pages, outlines, form fields, signatures, and annotations, and `render_preview {page: 1, max_side: 1024}` to view rendered pages.'
    ],
    promptKeywords: /\b(pdfcraft|pdf\s+redact|pdf\s+ocr|pdf\s+form|pdf\s+merge|pdf\s+split|sign_document|page_extract)\b/i
  },

  effectcraft: {
    id: 'effectcraft',
    name: 'EffectCraft',
    tagline: 'Keyframe motion graphics, node/layer compositing, visual effects & render queue automation',
    category: 'video-audio',
    icon: '✨',
    cliBinary: 'effectcraft-cli',
    desktopBinary: 'effectcraft',
    defaultControlPort: 9877,
    remoteFlagStyle: 'bridge',
    supportsAutomationRoots: true,
    defaultExportFormat: 'mp4',
    exportFormats: ['mp4', 'mov', 'webm', 'png', 'exr', 'gif'],
    readOnlyTools: ['command_list', 'list_commands', 'doc_inspect', 'render_preview'],
    remoteUiOnlyTools: ['ui_click', 'ui_key', 'ui_type', 'ui_drag', 'ui_set', 'script_ui', 'control'],
    allTools: [
      'command_list',
      'command_run',
      'command_batch',
      'doc_inspect',
      'render_preview',
      'list_commands',
      'execute_command',
      'batch',
      'ui_click',
      'ui_key',
      'ui_type',
      'ui_drag',
      'ui_set',
      'script_ui',
      'control'
    ],
    resources: ['effectcraft://document', 'effectcraft://commands'],
    prompts: [],
    conventionsSummary: [
      'Create and animate compositions with `command_run` (`comp.new`, layer transforms, effects, and keyframes) or atomic `batch`.',
      'Verify motion frames at any timestamp using `render_preview {comp, time, max_side, transparent}` before queuing `renderQueue.render`.'
    ],
    promptKeywords: /\b(effectcraft|after\s+effects|motion\s+graphics|vfx\s+compositing|renderQueue\.render|comp\.new)\b/i
  },

  designcraft: {
    id: 'designcraft',
    name: 'DesignCraft',
    tagline: 'Multi-page desktop publishing, master spreads, threaded text stories, preflight & print layout',
    category: 'design-layout',
    icon: '📰',
    cliBinary: 'designcraft-cli',
    desktopBinary: 'designcraft',
    defaultControlPort: 7979,
    remoteFlagStyle: 'connect',
    supportsAutomationRoots: true,
    defaultExportFormat: 'pdf',
    exportFormats: ['pdf', 'png', 'jpg', 'idml', 'epub', 'html', 'designcraft'],
    readOnlyTools: ['list_commands', 'inspect_document', 'get_story', 'render_page', 'screenshot', 'menu_list', 'ui_inspect'],
    remoteUiOnlyTools: [
      'screenshot',
      'click',
      'drag',
      'menu_list',
      'ui_inspect',
      'ui_set',
      'dialog_set',
      'dialog_confirm',
      'dialog_cancel'
    ],
    allTools: [
      'list_commands',
      'execute',
      'batch',
      'inspect_document',
      'get_story',
      'set_story_text',
      'new_document',
      'open_document',
      'save_document',
      'place_image',
      'render_page',
      'export_png',
      'select_tool',
      'pointer',
      'key',
      'type_text',
      'ime',
      'screenshot',
      'click',
      'drag',
      'menu_list',
      'ui_inspect',
      'ui_set',
      'dialog_set',
      'dialog_confirm',
      'dialog_cancel'
    ],
    resources: ['designcraft://document', 'designcraft://commands'],
    prompts: [],
    conventionsSummary: [
      'Inspect pages, spreads, threaded stories, and overset text flags via `inspect_document` and `get_story`.',
      'Use `place_image` with fitting modes (`fillProportionally`, `fitProportionally`, `fitFrameToContent`) and verify layouts via `render_page`.'
    ],
    promptKeywords: /\b(designcraft|indesign|desktop\s+publishing|master\s+spread|threaded\s+story|overset\s+text|set_story_text|place_image)\b/i
  },

  figcraft: {
    id: 'figcraft',
    name: 'FigCraft',
    tagline: 'UI/UX interface design, auto-layout frames, components, design variables, FigJam & prototyping',
    category: 'design-layout',
    icon: '📐',
    cliBinary: 'figcraft-cli',
    desktopBinary: 'figcraft',
    defaultControlPort: 7979,
    remoteFlagStyle: 'attach',
    supportsAutomationRoots: true,
    extraFlagHint: '--timeout 300',
    defaultExportFormat: 'svg',
    exportFormats: ['svg', 'png', 'jpg', 'pdf', 'figcraft', 'json'],
    readOnlyTools: [
      'list_commands',
      'inspect_document',
      'get_node',
      'screenshot',
      'inspect_ui'
    ],
    remoteUiOnlyTools: ['wait_for_changes'],
    allTools: [
      'list_commands',
      'run_command',
      'batch',
      'create_node',
      'set_properties',
      'inspect_document',
      'get_node',
      'select',
      'export',
      'screenshot',
      'open_file',
      'save_file',
      'undo',
      'redo',
      'pointer',
      'key',
      'type_text',
      'inspect_ui',
      'wait_for_changes'
    ],
    resources: [
      'figcraft://document',
      'figcraft://commands',
      'figcraft://comments',
      'figcraft://node/{id}',
      'figcraft://command/{id}'
    ],
    prompts: [
      'mobile_screen',
      'design_system',
      'landing_page',
      'prototype_flow',
      'fix_comments',
      'watch_comments'
    ],
    conventionsSummary: [
      '`create_node` and `set_properties` take `x`/`y` relative to the parent frame (or page when top-level).',
      'Remote live sessions use `--attach <port>` (e.g. `figcraft-cli mcp --attach 7979 --timeout 300`).',
      'Use `batch` to group multi-node UI component trees and auto-layout mutations into one undo step.'
    ],
    promptKeywords: /\b(figcraft|figma|auto-layout|design\s+system|ui\s+mockup|wireframe|prototype_flow|create_node|mobile_screen)\b/i
  },

  wordcraft: {
    id: 'wordcraft',
    name: 'WordCraft',
    tagline: 'Structured word processor, character/paragraph styles, tracked changes, mail merge & DOCX/PDF/LaTeX',
    category: 'documents-data',
    icon: '📝',
    cliBinary: 'wordcraft-cli',
    desktopBinary: 'wordcraft',
    defaultControlPort: 7981,
    remoteFlagStyle: 'connect',
    controlTokenEnv: 'WORDCRAFT_CONTROL_KEY',
    supportsAutomationRoots: true,
    extraFlagHint: '--author "Claude (copyedit)"',
    defaultExportFormat: 'docx',
    exportFormats: ['docx', 'pdf', 'odt', 'rtf', 'html', 'md', 'tex', 'txt', 'png'],
    readOnlyTools: [
      'list_commands',
      'list_documents',
      'get_text',
      'inspect_document',
      'render_page',
      'parity',
      'screenshot',
      'ui_inspect'
    ],
    remoteUiOnlyTools: ['screenshot', 'click', 'key', 'ui_inspect'],
    allTools: [
      'list_commands',
      'execute',
      'batch',
      'new_document',
      'open_document',
      'save_document',
      'list_documents',
      'type_text',
      'select_text',
      'get_text',
      'inspect_document',
      'render_page',
      'parity',
      'screenshot',
      'click',
      'key',
      'ui_inspect'
    ],
    resources: ['wordcraft://document', 'wordcraft://commands'],
    prompts: [],
    conventionsSummary: [
      'Start with `--author "Agent"` and enable `review.trackChanges {"value": true}` when recording attributed copyedits.',
      'Use `get_text` and `inspect_document` for fast structural verification and `render_page` for visual typography checks.'
    ],
    promptKeywords: /\b(wordcraft|docx|tracked\s+changes|mail\s+merge|word\s+processor|typeset\s+document|save_document)\b/i
  },

  soundcraft: {
    id: 'soundcraft',
    name: 'SoundCraft',
    tagline: 'Digital Audio Workstation (DAW), multitrack recording, MIDI, sampler, DSP mixing & LUFS stem bounce',
    category: 'video-audio',
    icon: '🎵',
    cliBinary: 'soundcraft-cli',
    desktopBinary: 'soundcraft',
    defaultControlPort: 7801,
    remoteFlagStyle: 'connect',
    supportsAutomationRoots: true,
    extraFlagHint: '--demo',
    defaultExportFormat: 'wav',
    exportFormats: ['wav', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'mid', 'scraft'],
    readOnlyTools: ['list_commands', 'inspect_session', 'parity', 'screenshot', 'ui_inspect'],
    remoteUiOnlyTools: ['screenshot', 'ui_inspect', 'ui_set', 'menu_invoke', 'click', 'drag', 'key'],
    allTools: [
      'list_commands',
      'execute',
      'batch',
      'inspect_session',
      'new_session',
      'open_session',
      'save_session',
      'import_audio',
      'bounce_mix',
      'parity',
      'screenshot',
      'ui_inspect',
      'ui_set',
      'menu_invoke',
      'click',
      'drag',
      'key'
    ],
    resources: ['soundcraft://session', 'soundcraft://commands'],
    prompts: [],
    conventionsSummary: [
      'Use `batch` (up to 1000 commands) to build tracks, MIDI clips, synth patches, and mixer routing.',
      'Use `inspect_session` to inspect tracks, clips, plugins, and automation, and `bounce_mix` to render audio with peak dBFS and integrated LUFS metrics.'
    ],
    promptKeywords: /\b(soundcraft|daw|midi\s+track|bounce_mix|audio\s+stems|lufs|synthesizer|inspect_session)\b/i
  },

  deckcraft: {
    id: 'deckcraft',
    name: 'DeckCraft',
    tagline: 'Presentation & slide deck studio, slide masters, speaker notes, charts, animations & PPTX/PDF export',
    category: 'documents-data',
    icon: '📊',
    cliBinary: 'deckcraft-cli',
    desktopBinary: 'deckcraft',
    defaultControlPort: 7990,
    remoteFlagStyle: 'connect',
    supportsAutomationRoots: true,
    extraFlagHint: '--sample',
    defaultExportFormat: 'pptx',
    exportFormats: ['pptx', 'pdf', 'png', 'jpg', 'html', 'deckcraft'],
    readOnlyTools: ['list_commands', 'inspect_document', 'inspect_slide', 'render_slide', 'screenshot'],
    remoteUiOnlyTools: ['screenshot', 'call_app'],
    allTools: [
      'list_commands',
      'run_command',
      'batch',
      'new_presentation',
      'open_presentation',
      'save_presentation',
      'export',
      'inspect_document',
      'inspect_slide',
      'render_slide',
      'add_slide',
      'go_to_slide',
      'add_shape',
      'add_text_box',
      'set_text',
      'insert_picture',
      'insert_table',
      'insert_chart',
      'select',
      'pointer',
      'select_tool',
      'key',
      'type_text',
      'screenshot',
      'call_app'
    ],
    resources: ['deckcraft://document', 'deckcraft://commands'],
    prompts: [],
    conventionsSummary: [
      'Use `inspect_document` and `inspect_slide` to inspect slide layouts, placeholders, and animations.',
      'Verify visual slide balance with `render_slide` before exporting to `.pptx` or `.pdf` via `export`.'
    ],
    promptKeywords: /\b(deckcraft|powerpoint|pptx|slide\s+deck|presentation\s+slides|render_slide|inspect_slide)\b/i
  },

  cadcraft: {
    id: 'cadcraft',
    name: 'CADCraft',
    tagline: '2D/3D parametric CAD, command-line drafting, DXF/DWG blocks, exact closed-loop & area verifiers',
    category: 'engineering',
    icon: '⚙️',
    cliBinary: 'cadcraft-cli',
    desktopBinary: 'cadcraft',
    defaultControlPort: 7979,
    remoteFlagStyle: 'connect',
    supportsAutomationRoots: false,
    extraFlagHint: '--lazy --launch',
    defaultExportFormat: 'dxf',
    exportFormats: ['dxf', 'dwg', 'svg', 'pdf', 'png', 'step', 'stl'],
    readOnlyTools: [
      'list_commands',
      'inspect_drawing',
      'query_entities',
      'find_text',
      'render',
      'screenshot',
      'ui_inspect'
    ],
    remoteUiOnlyTools: ['screenshot', 'ui_inspect', 'ui_click'],
    allTools: [
      'command_line',
      'script',
      'execute',
      'list_commands',
      'inspect_drawing',
      'query_entities',
      'find_text',
      'render',
      'new_drawing',
      'open',
      'save',
      'cancel',
      'screenshot',
      'ui_inspect',
      'ui_click'
    ],
    resources: ['cadcraft://drawing', 'cadcraft://commands'],
    prompts: [],
    conventionsSummary: [
      'Drive CADCraft via `command_line {"text": "rectang 0,0 100,60"}`, multi-line `.scr` `script`, or structured `execute {command, params}`.',
      'Verify geometry mathematically with `execute {"command": "shapes"}` (exact perimeter, area, centroid, self-intersections) and `execute {"command": "loops"}` before `render`.'
    ],
    promptKeywords: /\b(cadcraft|autocad|dxf|dwg|parametric\s+cad|technical\s+drawing|inspect_drawing|query_entities)\b/i
  },

  gridcraft: {
    id: 'gridcraft',
    name: 'GridCraft',
    tagline: 'Spreadsheet & formula engine, financial modeling, pivot tables, AutoFilter, charts & XLSX/CSV',
    category: 'documents-data',
    icon: '📈',
    cliBinary: 'gridcraft-cli',
    desktopBinary: 'gridcraft',
    defaultControlPort: 7979,
    remoteFlagStyle: 'connect',
    controlTokenEnv: 'GRIDCRAFT_CONTROL_TOKEN',
    supportsAutomationRoots: false,
    extraFlagHint: '--sample budget or --in <book.xlsx>',
    defaultExportFormat: 'xlsx',
    exportFormats: ['xlsx', 'csv', 'tsv', 'json', 'html', 'pdf'],
    readOnlyTools: [
      'list_commands',
      'list_windows',
      'inspect_workbook',
      'read_range',
      'get_cell',
      'evaluate_formula',
      'list_functions',
      'screenshot'
    ],
    remoteUiOnlyTools: ['screenshot'],
    allTools: [
      'execute_command',
      'list_commands',
      'list_windows',
      'inspect_workbook',
      'read_range',
      'write_range',
      'set_cell',
      'get_cell',
      'evaluate_formula',
      'select',
      'format_range',
      'insert_chart',
      'create_table',
      'sort_range',
      'filter',
      'open_workbook',
      'save_workbook',
      'new_workbook',
      'undo',
      'redo',
      'screenshot',
      'list_functions'
    ],
    resources: ['gridcraft://workbook', 'gridcraft://commands', 'gridcraft://functions'],
    prompts: [],
    conventionsSummary: [
      'Use `write_range` for 2D cell blocks (strings starting with `=` become live formulas) and `evaluate_formula` to test formulas non-destructively.',
      'Use `inspect_workbook` and `read_range` to verify calculated values, tables, and charts.'
    ],
    promptKeywords: /\b(gridcraft|spreadsheet|xlsx|workbook|pivot\s+table|evaluate_formula|write_range|inspect_workbook)\b/i
  },

  'craft-anything': {
    id: 'craft-anything',
    name: 'Craft Anything',
    tagline: '284-tool reverse engineering (Ghidra/Rizin/GDB/Frida), web/Electron decompilation & clean-room rebuilder',
    category: 'engineering',
    icon: '🔬',
    cliBinary: 'craft-anything-cli',
    desktopBinary: 'craft-anything',
    defaultControlPort: null,
    remoteFlagStyle: 'none',
    supportsAutomationRoots: false,
    extraFlagHint: '--deep --all-tools',
    defaultExportFormat: 'json',
    exportFormats: ['json', 'zip', 'tar.gz', 'html', 'md'],
    readOnlyTools: [
      'core_session_show',
      'core_targets_list',
      'core_evidence_show',
      'core_evidence_browse',
      'js_app_map',
      'js_electron_pages_list',
      'js_electron_fuses_show',
      'native_window_capture',
      'runtime_ui_read',
      'frida_devices_find',
      'frida_targets_list',
      'app_coverage_evaluate',
      'db_sqlite_show',
      'project_list',
      'project_show',
      'engines_list',
      'settings_show',
      'build_files_list',
      'build_file_read'
    ],
    remoteUiOnlyTools: [],
    allTools: [
      'core_target_open',
      'core_target_close',
      'core_session_show',
      'core_targets_list',
      'core_target_select',
      'core_evidence_show',
      'core_evidence_browse',
      'core_action_approve',
      'core_person_ask',
      'web_standin_start',
      'web_standin_stop',
      'web_standin_show',
      'web_coverage_measure',
      'web_listeners_list',
      'web_modules_trace',
      'js_app_map',
      'js_runtime_code_match',
      'js_source_locate',
      'js_sources_restore',
      'js_electron_pages_list',
      'js_electron_page_show',
      'js_electron_fuses_show',
      'native_window_capture',
      'runtime_walkthrough_record',
      'runtime_captures_compare',
      'native_gdb_session_begin',
      'native_gdb_command_run',
      'native_rizin_session_begin',
      'native_rizin_session_command_run',
      'frida_devices_find',
      'frida_targets_list',
      'frida_session_begin',
      'frida_script_run',
      'frida_instrument_run',
      'app_feature_follow',
      'app_ledger_build',
      'app_coverage_evaluate',
      'android_app_graph_build',
      'apple_app_graph_build',
      'db_sqlite_show',
      'project_list',
      'project_show',
      'build_files_list',
      'build_file_read',
      'build_file_write',
      'build_file_edit',
      'build_command_run'
    ],
    resources: [],
    prompts: [],
    conventionsSummary: [
      'Exposes 284 reverse-engineering & rebuild tools across `core`, `web`, `javascript`, `runtime` (GDB/Rizin), `frida`, `application`, `database`, and `build`.',
      'Large evidence outputs return a summary first; page through full decompilation/trace evidence with `core_evidence_browse`.'
    ],
    promptKeywords: /\b(craft-anything|clean-room\s+rebuild|rizin|frida_instrument_run|core_evidence_browse|js_sources_restore|app_ledger_build)\b/i
  }
};

export const ARTCRAFT_APP_IDS: readonly ArtCraftAppId[] = Object.keys(
  ARTCRAFT_APPS_CATALOG
) as ArtCraftAppId[];

export interface ArtCraftMcpConfig {
  enabled?: boolean;
  /** Primary ArtCraft application ID (default: 'vectorcraft') */
  app?: ArtCraftAppId;
  /** Optional multi-app studio bundle: when multiple ArtCraft apps are enabled on a single node */
  enabledApps?: ArtCraftAppId[];
  /** Alias for enabledApps */
  apps?: ArtCraftAppId[];
  /** Custom CLI binary override (defaults to `<app>-cli`) */
  cliCommand?: string;
  /** Alias for cliCommand */
  cliBinary?: string;
  /** Execution mode: 'auto', 'remote' (--connect / --bridge / --attach), or 'headless' */
  backendMode?: ArtCraftBackendMode;
  /** Alias for backendMode */
  mode?: ArtCraftBackendMode;
  /** Control socket address or port for remote desktop mode */
  controlAddress?: string;
  /** Alias for controlAddress */
  connectAddress?: string;
  /** Directories passed to --automation-read-root (or --root on pdfcraft) */
  readRoots?: string[];
  /** Directories passed to --automation-write-root */
  writeRoots?: string[];
  /** Optional MCP workflow prompt preset (for VectorCraft / FigCraft) */
  defaultPromptWorkflow?: string;
  /** Alias for defaultPromptWorkflow */
  promptPreset?: string;
  /** Tool auto-approval tier for agent harnesses */
  autoApproveTier?: ArtCraftAutoApproveTier;
  /** Preferred export format for generated artifacts */
  defaultExportFormat?: string;
  /** Optional extra CLI flags (e.g. '--demo', '--deep --all-tools', '--author "Claude"') */
  extraArgs?: string[];
  /** Whether to inject <eluvix-artcraft-mcp> system instructions */
  injectSystemInstructions?: boolean;
  /** MCP protocol version string (default: '2025-06-18') */
  protocolVersion?: string;
}

export interface ArtCraftCliBuildResult {
  app: ArtCraftAppId;
  spec: ArtCraftAppSpec;
  cliCommand: string;
  mcpArgs: string[];
  appLaunchArgs: string[];
  effectiveMode: ArtCraftBackendMode;
  confinementNote?: string;
}

function splitCliExtraArgs(extraArgs?: string[]): string[] {
  if (!Array.isArray(extraArgs)) return [];
  const tokens: string[] = [];
  for (const raw of extraArgs) {
    if (typeof raw !== 'string' || /[\r\n\0]/.test(raw)) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const matches = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    for (const m of matches) {
      const unquoted =
        (m.startsWith('"') && m.endsWith('"')) || (m.startsWith("'") && m.endsWith("'"))
          ? m.slice(1, -1)
          : m;
      if (unquoted) tokens.push(unquoted);
    }
  }
  return tokens;
}

/**
 * Builds the exact `<app>-cli mcp` arguments for any of the 14 ArtCraft applications,
 * respecting each app's remote flag convention (`--connect`, `--bridge`, `--attach`, or headless-only)
 * and `--automation-read-root` / `--automation-write-root` rules.
 */
export function buildArtCraftCliArgs(config: ArtCraftMcpConfig): ArtCraftCliBuildResult {
  const appId: ArtCraftAppId =
    config.app && ARTCRAFT_APPS_CATALOG[config.app] ? config.app : 'vectorcraft';
  const spec = ARTCRAFT_APPS_CATALOG[appId];
  const cliCommand = (config.cliCommand || config.cliBinary || spec.cliBinary).trim() || spec.cliBinary;
  const requestedMode: ArtCraftBackendMode = config.backendMode || config.mode || 'auto';

  const defaultPort = spec.defaultControlPort ?? 7979;
  const rawInputControl = (config.controlAddress || config.connectAddress || `127.0.0.1:${defaultPort}`).trim();
  const barePortMatch = rawInputControl.match(/^(\d{1,5})$/);
  const isBarePortValid = barePortMatch && Number(barePortMatch[1]) >= 1 && Number(barePortMatch[1]) <= 65535;
  const rawControl = isBarePortValid ? `127.0.0.1:${barePortMatch[1]}` : rawInputControl;
  const portMatch = rawControl.match(/:(\d+)$/);
  const controlPort = portMatch ? portMatch[1] : String(defaultPort);

  const readRoots = (config.readRoots || []).map(r => r.trim()).filter(Boolean);
  const writeRoots = (config.writeRoots || []).map(r => r.trim()).filter(Boolean);
  const hasRoots = readRoots.length > 0 || writeRoots.length > 0;

  const mcpArgs: string[] = ['mcp'];
  const appLaunchArgs: string[] = spec.defaultControlPort ? ['--control', controlPort] : [];

  // Remote mode handling per app's remoteFlagStyle
  if (requestedMode === 'remote' && spec.remoteFlagStyle !== 'none') {
    if (spec.remoteFlagStyle === 'connect') {
      mcpArgs.push('--connect', rawControl);
    } else if (spec.remoteFlagStyle === 'bridge') {
      mcpArgs.push('--bridge', rawControl);
    } else if (spec.remoteFlagStyle === 'attach') {
      mcpArgs.push('--attach', rawControl);
    }

    if (spec.supportsAutomationRoots) {
      for (const r of readRoots) {
        appLaunchArgs.push('--automation-read-root', r);
      }
      for (const w of writeRoots) {
        appLaunchArgs.push('--automation-write-root', w);
      }
    }

    mcpArgs.push(...splitCliExtraArgs(config.extraArgs));

    return {
      app: appId,
      spec,
      cliCommand,
      mcpArgs,
      appLaunchArgs,
      effectiveMode: 'remote',
      ...(hasRoots
        ? {
            confinementNote: `In remote mode (--${spec.remoteFlagStyle}), filesystem confinement roots are enforced by the running ${spec.name} desktop app rather than the stdio bridge.`
          }
        : {})
    };
  }

  // Headless / Auto mode
  if (appId === 'vectorcraft' && requestedMode === 'headless') {
    mcpArgs.push('--headless');
  }

  if (spec.supportsAutomationRoots) {
    for (const r of readRoots) {
      mcpArgs.push('--automation-read-root', r);
    }
    for (const w of writeRoots) {
      mcpArgs.push('--automation-write-root', w);
    }
  }

  const parsedExtra = splitCliExtraArgs(config.extraArgs);
  if (appId === 'craft-anything' && parsedExtra.length === 0) {
    mcpArgs.push('--deep', '--all-tools');
  } else {
    mcpArgs.push(...parsedExtra);
  }

  const effectiveMode: ArtCraftBackendMode =
    spec.remoteFlagStyle === 'none' || requestedMode === 'headless' || hasRoots
      ? 'headless'
      : 'auto';

  return {
    app: appId,
    spec,
    cliCommand,
    mcpArgs,
    appLaunchArgs,
    effectiveMode
  };
}

export function resolveSelectedArtCraftApps(config: ArtCraftMcpConfig): ArtCraftAppId[] {
  const list = config.enabledApps || config.apps;
  if (Array.isArray(list) && list.length > 0) {
    return Array.from(new Set(list.filter(a => Boolean(ARTCRAFT_APPS_CATALOG[a]))));
  }
  return [config.app && ARTCRAFT_APPS_CATALOG[config.app] ? config.app : 'vectorcraft'];
}

/**
 * Resolves the auto-approved tool allowlist for a given ArtCraft app and approval tier.
 */
export function resolveArtCraftAutoApproveTools(config: ArtCraftMcpConfig): string[] {
  const apps = resolveSelectedArtCraftApps(config);

  const tier: ArtCraftAutoApproveTier = config.autoApproveTier || 'workspace-edit';
  const collected = new Set<string>();

  for (const appId of apps) {
    const spec = ARTCRAFT_APPS_CATALOG[appId] || ARTCRAFT_APPS_CATALOG.vectorcraft;
    const built = buildArtCraftCliArgs({ ...config, app: appId });
    const uiOnly = new Set<string>(spec.remoteUiOnlyTools);

    let list: readonly string[];
    if (tier === 'readonly-inspect') {
      list = spec.readOnlyTools;
    } else if (tier === 'full-automation') {
      list = spec.allTools;
    } else {
      // workspace-edit: all non-UI tools except destructive system/process/save/export tools
      list = spec.allTools.filter(
        t =>
          !uiOnly.has(t) &&
          !/^(save$|save_|doc_save|export|bounce_mix|sign_document|project_delete|render_video|render_frame|build_command_run|build_file_write|build_file_edit|frida_script_run|frida_instrument_run|native_gdb_command_run|native_rizin_session_command_run|api_Repeater_send|api_Intruder_start|web_browser_Run_action)/.test(
            t
          )
      );
    }

    for (const tool of list) {
      if (built.effectiveMode === 'headless' && uiOnly.has(tool)) continue;
      collected.add(tool);
    }
  }

  return Array.from(collected);
}

/**
 * Converts an `ArtCraftMcpConfig` into one or more `HarnessMcpServerConfig` entries
 * for injection into Eluvix agent harnesses (`ACP`, `TrueForge`, `OpenCode`, `Cline`, `Aider`).
 */
export function toArtCraftHarnessMcpServers(config: ArtCraftMcpConfig): HarnessMcpServerConfig[] {
  const apps = resolveSelectedArtCraftApps(config);

  return apps.map(appId => {
    const isPrimarySingle = apps.length === 1 || appId === config.app;
    const singleCfg: ArtCraftMcpConfig = {
      ...config,
      app: appId,
      enabledApps: [appId],
      cliCommand: isPrimarySingle ? config.cliCommand : undefined,
      cliBinary: isPrimarySingle ? config.cliBinary : undefined,
      controlAddress: isPrimarySingle ? config.controlAddress : undefined,
      connectAddress: isPrimarySingle ? config.connectAddress : undefined
    };
    const built = buildArtCraftCliArgs(singleCfg);
    const tools = resolveArtCraftAutoApproveTools(singleCfg);
    return {
      name: appId,
      endpoint: `stdio://${built.cliCommand} ${built.mcpArgs.join(' ')}`,
      transport: 'stdio',
      tools
    };
  });
}

/**
 * Detects which ArtCraft applications are relevant to a user prompt.
 */
export function detectArtCraftAppsForPrompt(promptText: string): ArtCraftAppId[] {
  if (!promptText) return [];
  const matched: ArtCraftAppId[] = [];
  for (const appId of ARTCRAFT_APP_IDS) {
    const spec = ARTCRAFT_APPS_CATALOG[appId];
    if (spec.promptKeywords.test(promptText)) {
      matched.push(appId);
    }
  }
  return matched;
}

/**
 * Returns true if the prompt matches a specific ArtCraft app or any ArtCraft app in the suite.
 */
export function isArtCraftPrompt(promptText: string, appId?: ArtCraftAppId): boolean {
  if (!promptText) return false;
  if (appId && ARTCRAFT_APPS_CATALOG[appId]) {
    if (ARTCRAFT_APPS_CATALOG[appId].promptKeywords.test(promptText)) return true;
  }
  return detectArtCraftAppsForPrompt(promptText).length > 0;
}

/**
 * Builds the `<eluvix-artcraft-mcp>` system context block for all active ArtCraft apps.
 */
export function buildArtCraftSystemInstructions(config: ArtCraftMcpConfig): string {
  const apps = resolveSelectedArtCraftApps(config);

  const lines: string[] = [
    '<eluvix-artcraft-mcp>',
    `ArtCraft Open-Source Creative & Engineering MCP Suite (${apps.length} active server${apps.length === 1 ? '' : 's'} over stdio JSON-RPC 2.0, protocol 2025-06-18):`
  ];

  for (const appId of apps) {
    const built = buildArtCraftCliArgs({
      ...config,
      app: appId,
      cliCommand: apps.length === 1 ? config.cliCommand : undefined,
      cliBinary: apps.length === 1 ? config.cliBinary : undefined,
      controlAddress: apps.length === 1 ? config.controlAddress : undefined,
      connectAddress: apps.length === 1 ? config.connectAddress : undefined
    });
    const spec = built.spec;
    lines.push(
      `### ${spec.icon} ${spec.name} (\`${built.cliCommand} ${built.mcpArgs.join(' ')}\`, mode=${built.effectiveMode})`
    );
    lines.push(`- Role: ${spec.tagline}`);
    for (const rule of spec.conventionsSummary) {
      lines.push(`- ${rule}`);
    }
    if (spec.resources.length > 0) {
      lines.push(`- MCP Resources: ${spec.resources.map(r => `\`${r}\``).join(', ')}`);
    }
    if (spec.prompts.length > 0) {
      lines.push(`- MCP Workflow Prompts: ${spec.prompts.map(p => `\`${p}\``).join(', ')}`);
    }
  }

  lines.push('</eluvix-artcraft-mcp>');
  return lines.join('\n');
}

/**
 * Generates a shell-safe setup & registration script (`artcraft-mcp-setup.sh`)
 * for all selected ArtCraft applications.
 */
export function generateArtCraftSetupScript(nodeId: string, config: ArtCraftMcpConfig): string {
  const safeId = sanitizeSafeIdentifier(nodeId, 'artcraft-mcp');
  const apps = resolveSelectedArtCraftApps(config);

  const mcpServersMap: Record<string, { command: string; args: string[] }> = {};
  const claudeCmds: string[] = [];
  const remoteLaunchComments: string[] = [];

  for (const appId of apps) {
    const built = buildArtCraftCliArgs({
      ...config,
      app: appId,
      cliCommand: apps.length === 1 ? config.cliCommand : undefined,
      cliBinary: apps.length === 1 ? config.cliBinary : undefined,
      controlAddress: apps.length === 1 ? config.controlAddress : undefined,
      connectAddress: apps.length === 1 ? config.connectAddress : undefined
    });
    mcpServersMap[appId] = {
      command: built.cliCommand,
      args: built.mcpArgs
    };
    const safeCli = escapeShellArg(built.cliCommand, built.spec.cliBinary);
    const escapedArgs = built.mcpArgs.map(a => escapeShellArg(a, 'mcp')).join(' ');
    claudeCmds.push(`claude mcp add ${appId} -- ${safeCli} ${escapedArgs}`);

    if (built.effectiveMode === 'remote' && built.spec.defaultControlPort) {
      const escapedAppArgs = built.appLaunchArgs.map(a => escapeShellArg(a, '--control')).join(' ');
      if (built.spec.controlTokenEnv) {
        remoteLaunchComments.push(
          `# export ${built.spec.controlTokenEnv}="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"`
        );
      }
      remoteLaunchComments.push(`# ${built.spec.desktopBinary} ${escapedAppArgs} &`);
    }
  }

  const lines: string[] = [
    '#!/usr/bin/env bash',
    '# ==============================================================================',
    `# Eluvix ArtCraft Suite MCP Registration (${safeId})`,
    `# Apps (${apps.length}): ${apps.join(', ')}`,
    '# ==============================================================================',
    'set -euo pipefail',
    ''
  ];

  if (remoteLaunchComments.length > 0) {
    lines.push('# 1. Launch Desktop GUI Control Channels (for Remote / Bridge / Attach mode):');
    lines.push(...remoteLaunchComments);
    lines.push('');
  }

  lines.push('# 2. Register ArtCraft MCP Servers with Claude Code:');
  lines.push(...claudeCmds);
  lines.push('');
  lines.push('# 3. Standard MCP Client Configuration (.mcp.json):');
  lines.push("cat << 'EOF' > artcraft-mcp-config.json");
  lines.push(JSON.stringify({ mcpServers: mcpServersMap }, null, 2));
  lines.push('EOF');

  return lines.join('\n');
}
