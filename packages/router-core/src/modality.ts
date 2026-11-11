export type SynthesisIntent = 'text' | 'image-gen' | 'video-gen' | '3d-gen';

export interface ModalityProfile {
  hasVisionInput: boolean;
  hasAudioInput: boolean;
  hasToolDefinitions: boolean;
  synthesisIntent: SynthesisIntent;
  matchedTrigger?: string;
}

const CODE_OR_DIAGRAM_EXCLUSION_RE =
  /\b(react|vue|svelte|angular|component|html|css|tailwind|jsx|tsx|dom|mermaid|plantuml|graphviz|ascii|sql|schema|database|json|yaml|toml|xml|typescript|javascript|python|rust|golang|c\+\+|java|function|method|class|interface|regex|dockerfile|kubernetes|bash|shell|unit\s+test|markdown\s+table)\b/i;

const SLASH_3D_RE = /^\/(?:3d|mesh|glb)\b/i;
const SLASH_VIDEO_RE = /^\/(?:video|animate|wan)\b/i;
const SLASH_IMAGE_RE = /^\/(?:imagine|draw|paint|comfy|render-image)\b/i;

const INTENT_3D_RE =
  /\b(?:generate|create|render|synthesize|sculpt|build)\s+(?:a\s+|an\s+|me\s+a\s+)?(?:detailed\s+|stylized\s+|low[- ]poly\s+|high[- ]poly\s+)*(?:3d\s+(?:mesh|model|asset|object|glb)|glb\s+(?:mesh|model)|hunyuan3d\s+(?:mesh|model))\b/i;

const INTENT_VIDEO_RE =
  /\b(?:generate|create|render|synthesize|animate)\s+(?:a\s+|an\s+|me\s+a\s+)?(?:short\s+|cinematic\s+|animated\s+|looping\s+|slow[- ]motion\s+|4k\s+)*(?:video(?:\s+animation|\s+clip)?|animation|footage|wan\s*2\.?1\s+video)\s+(?:of|showing|depicting|with|featuring|where)\b/i;

const INTENT_IMAGE_RE =
  /\b(?:generate|create|render|draw|paint|illustrate|synthesize)\s+(?:a\s+|an\s+|me\s+a\s+)?(?:photorealistic\s+|cinematic\s+|high[- ]res(?:olution)?\s+|ultra[- ]detailed\s+|detailed\s+|digital\s+|oil\s+|watercolor\s+|concept\s+|cyberpunk\s+|solarpunk\s+|anime\s+|studio\s+|flux\s+|sdxl\s+)*(?:image|picture|photo|photograph|illustration|portrait|poster|wallpaper|artwork|painting|concept\s+art)\s+(?:of|showing|depicting|with|featuring|for|in)\b/i;

/**
 * Deterministically classifies input modalities (vision, audio, tools) and
 * output media synthesis intent ('text' | 'image-gen' | 'video-gen' | '3d-gen')
 * for Switchyard routing and `/api/v1/route-explain`.
 */
export function classifyRequestModality(request: {
  model?: string;
  messages?: Array<{ role: string; content: any }>;
  tools?: any[];
  metadata?: Record<string, any>;
  audio?: any;
}): ModalityProfile {
  let hasVisionInput = false;
  let hasAudioInput = Boolean(request.audio);
  const hasToolDefinitions = Array.isArray(request.tools) && request.tools.length > 0;

  let latestUserText = '';
  const messages = Array.isArray(request.messages) ? request.messages : [];

  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue;
        if (
          part.type === 'image_url' ||
          part.type === 'input_image' ||
          (typeof part.image_url?.url === 'string' && part.image_url.url.length > 0)
        ) {
          hasVisionInput = true;
        }
        if (part.type === 'input_audio' || part.type === 'audio_url') {
          hasAudioInput = true;
        }
      }
    } else if (typeof m?.content === 'string') {
      if (/data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(m.content)) {
        hasVisionInput = true;
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') {
      if (typeof m.content === 'string') {
        latestUserText = m.content.trim();
      } else if (Array.isArray(m.content)) {
        latestUserText = m.content
          .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
          .map((p: any) => p.text)
          .join('\n')
          .trim();
      }
      if (latestUserText) break;
    }
  }

  // Explicit metadata override when valid and no tool calls are active
  const metaIntent = request.metadata?.synthesisIntent;
  if (
    !hasToolDefinitions &&
    (metaIntent === 'image-gen' || metaIntent === 'video-gen' || metaIntent === '3d-gen' || metaIntent === 'text')
  ) {
    return {
      hasVisionInput,
      hasAudioInput,
      hasToolDefinitions,
      synthesisIntent: metaIntent,
      matchedTrigger: 'metadata.synthesisIntent',
    };
  }

  // Tool-bearing requests always require a text/tool-calling LLM or harness
  if (hasToolDefinitions || !latestUserText) {
    return {
      hasVisionInput,
      hasAudioInput,
      hasToolDefinitions,
      synthesisIntent: 'text',
    };
  }

  // Explicit slash commands override code/diagram exclusion heuristics
  if (SLASH_3D_RE.test(latestUserText)) {
    return {
      hasVisionInput,
      hasAudioInput,
      hasToolDefinitions,
      synthesisIntent: '3d-gen',
      matchedTrigger: latestUserText.match(SLASH_3D_RE)?.[0],
    };
  }
  if (SLASH_VIDEO_RE.test(latestUserText)) {
    return {
      hasVisionInput,
      hasAudioInput,
      hasToolDefinitions,
      synthesisIntent: 'video-gen',
      matchedTrigger: latestUserText.match(SLASH_VIDEO_RE)?.[0],
    };
  }
  if (SLASH_IMAGE_RE.test(latestUserText)) {
    return {
      hasVisionInput,
      hasAudioInput,
      hasToolDefinitions,
      synthesisIntent: 'image-gen',
      matchedTrigger: latestUserText.match(SLASH_IMAGE_RE)?.[0],
    };
  }

  // Guard against software/diagram prompts ("render a React component", "generate SQL schema", "draw Mermaid diagram")
  if (CODE_OR_DIAGRAM_EXCLUSION_RE.test(latestUserText)) {
    return {
      hasVisionInput,
      hasAudioInput,
      hasToolDefinitions,
      synthesisIntent: 'text',
    };
  }

  const m3d = latestUserText.match(INTENT_3D_RE);
  if (m3d) {
    return {
      hasVisionInput,
      hasAudioInput,
      hasToolDefinitions,
      synthesisIntent: '3d-gen',
      matchedTrigger: m3d[0],
    };
  }

  const mVid = latestUserText.match(INTENT_VIDEO_RE);
  if (mVid) {
    return {
      hasVisionInput,
      hasAudioInput,
      hasToolDefinitions,
      synthesisIntent: 'video-gen',
      matchedTrigger: mVid[0],
    };
  }

  const mImg = latestUserText.match(INTENT_IMAGE_RE);
  if (mImg) {
    return {
      hasVisionInput,
      hasAudioInput,
      hasToolDefinitions,
      synthesisIntent: 'image-gen',
      matchedTrigger: mImg[0],
    };
  }

  return {
    hasVisionInput,
    hasAudioInput,
    hasToolDefinitions,
    synthesisIntent: 'text',
  };
}

/**
 * Determines whether a model identifier explicitly names a diffusion/media checkpoint or model.
 */
export function isExplicitMediaModelId(modelName: string): boolean {
  if (!modelName || modelName === 'auto' || modelName === 'default' || modelName === '*') {
    return false;
  }
  return (
    /\.(?:safetensors|ckpt|pt|pth|bin)$/i.test(modelName) ||
    /^(?:comfyui|flux\.?1|flux-|sdxl|sd_xl|sd3\.?5|wan2\.?1|hunyuan3d|dall-e|gpt-image)/i.test(modelName)
  );
}
