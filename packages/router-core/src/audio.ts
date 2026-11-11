import {
  escapeShellArg,
  sanitizeSafeIdentifier,
  sanitizePositiveInt,
} from './shell-utils.js';

/**
 * Browser-safe Sovereign Audio & Speech definitions, backend presets, MIME
 * helpers, and container launch script generators for `/v1/audio/transcriptions`
 * and `/v1/audio/speech`.
 *
 * IMPORTANT: Keep ZERO `node:*` imports in this file so `compiler.ts`,
 * `decompiler.ts`, and `AudioVoiceNode.tsx` can import from `@eluvix/router-core/audio`.
 */

export type AudioNodeMode = 'both' | 'stt' | 'tts';

export type SttBackendPreset = 'speaches' | 'whisper-cpp' | 'lemonade' | 'openai';

export type TtsBackendPreset = 'kokoro' | 'piper' | 'lemonade' | 'openai';

export type AudioResponseFormat = 'mp3' | 'wav' | 'opus' | 'flac' | 'pcm';

export type TranscriptionResponseFormat =
  | 'json'
  | 'text'
  | 'verbose_json'
  | 'srt'
  | 'vtt';

export interface AudioVoiceConfig {
  mode?: AudioNodeMode;
  sttBackend?: SttBackendPreset;
  ttsBackend?: TtsBackendPreset;
  sttEndpoint?: string;
  ttsEndpoint?: string;
  defaultSttModel?: string;
  defaultTtsModel?: string;
  defaultVoice?: string;
  responseFormat?: AudioResponseFormat;
  sampleRateHz?: number;
  scrubTranscriptPii?: boolean;
  vramFootprintGb?: number;
}

export interface AudioPresetMetadata {
  label: string;
  defaultEndpoint: string;
  defaultModel: string;
  defaultVoice?: string;
  estimatedVramGb: number;
}

export const STT_BACKEND_PRESETS: Record<SttBackendPreset, AudioPresetMetadata> = {
  speaches: {
    label: 'Speaches / Faster-Whisper (CUDA/ROCm/CPU)',
    defaultEndpoint: 'http://localhost:8005',
    defaultModel: 'Systran/faster-whisper-large-v3-turbo',
    estimatedVramGb: 2.2,
  },
  'whisper-cpp': {
    label: 'whisper.cpp HTTP Server (GGML / Vulkan / Metal)',
    defaultEndpoint: 'http://localhost:8086',
    defaultModel: 'ggml-large-v3-turbo.bin',
    estimatedVramGb: 1.6,
  },
  lemonade: {
    label: 'Lemonade Unified Audio Router (NPU / GPU)',
    defaultEndpoint: 'http://localhost:13305',
    defaultModel: 'whisper-large-v3-turbo',
    estimatedVramGb: 1.5,
  },
  openai: {
    label: 'OpenAI Cloud Whisper / GPT-4o Transcribe',
    defaultEndpoint: 'https://api.openai.com',
    defaultModel: 'gpt-4o-mini-transcribe',
    estimatedVramGb: 0,
  },
};

export const TTS_BACKEND_PRESETS: Record<TtsBackendPreset, AudioPresetMetadata> = {
  kokoro: {
    label: 'Kokoro-FastAPI 82M Neural TTS (:8880)',
    defaultEndpoint: 'http://localhost:8880',
    defaultModel: 'kokoro',
    defaultVoice: 'af_heart',
    estimatedVramGb: 0.8,
  },
  piper: {
    label: 'Piper ONNX Ultra-Fast CPU/GPU TTS (:8880)',
    defaultEndpoint: 'http://localhost:8880',
    defaultModel: 'en_US-lessac-medium',
    defaultVoice: 'lessac',
    estimatedVramGb: 0.3,
  },
  lemonade: {
    label: 'Lemonade Unified TTS (:13305)',
    defaultEndpoint: 'http://localhost:13305',
    defaultModel: 'kokoro-v1',
    defaultVoice: 'af_heart',
    estimatedVramGb: 0.6,
  },
  openai: {
    label: 'OpenAI Cloud TTS',
    defaultEndpoint: 'https://api.openai.com',
    defaultModel: 'gpt-4o-mini-tts',
    defaultVoice: 'alloy',
    estimatedVramGb: 0,
  },
};

export function isDedicatedAudioUpstreamType(type?: string): boolean {
  return (
    type === 'audio' ||
    type === 'whisper' ||
    type === 'speaches' ||
    type === 'kokoro-tts'
  );
}

export function inferAudioMimeType(format?: string): string {
  switch ((format || 'mp3').toLowerCase()) {
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/opus';
    case 'flac':
      return 'audio/flac';
    case 'pcm':
      return 'audio/pcm';
    case 'aac':
      return 'audio/aac';
    case 'mp3':
    default:
      return 'audio/mpeg';
  }
}

export function estimateAudioNodeVramGb(cfg?: AudioVoiceConfig): number {
  if (!cfg) return 2.5;
  if (typeof cfg.vramFootprintGb === 'number' && cfg.vramFootprintGb >= 0) {
    return Number(cfg.vramFootprintGb.toFixed(2));
  }
  const mode = cfg.mode || 'both';
  const stt = STT_BACKEND_PRESETS[cfg.sttBackend || 'speaches']?.estimatedVramGb ?? 2.0;
  const tts = TTS_BACKEND_PRESETS[cfg.ttsBackend || 'kokoro']?.estimatedVramGb ?? 0.8;
  if (mode === 'stt') return Number(stt.toFixed(2));
  if (mode === 'tts') return Number(tts.toFixed(2));
  return Number((stt + tts).toFixed(2));
}

function extractPortFromUrl(rawUrl: string | undefined, fallbackPort: number): number {
  if (!rawUrl) return fallbackPort;
  try {
    const parsed = new URL(rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`);
    if (parsed.port) {
      return sanitizePositiveInt(parseInt(parsed.port, 10), fallbackPort, 65535);
    }
  } catch {}
  return fallbackPort;
}

/**
 * Generates a reproducible Podman/Docker launch script for Sovereign Audio
 * engines (`Speaches` Faster-Whisper STT and `Kokoro-FastAPI` / `Piper` TTS).
 */
export function generateAudioVoiceSetupScript(
  nodes: Array<{
    id: string;
    name?: string;
    endpoint?: string;
    audio?: AudioVoiceConfig;
  }>
): string {
  if (!Array.isArray(nodes) || nodes.length === 0) return '';

  const lines: string[] = [
    '#!/usr/bin/env bash',
    '# Generated by Eluvix Visual Node Routing Editor — Sovereign Audio & Speech Stack',
    'set -euo pipefail',
    '',
    'ENGINE="${CONTAINER_ENGINE:-podman}"',
    'if ! command -v "$ENGINE" >/dev/null 2>&1; then ENGINE="docker"; fi',
    '',
  ];

  for (const node of nodes) {
    const safeId = sanitizeSafeIdentifier(node.id, 'audio-voice');
    const cfg = node.audio || {};
    const mode = cfg.mode || 'both';
    const sttBackend = cfg.sttBackend || 'speaches';
    const ttsBackend = cfg.ttsBackend || 'kokoro';

    lines.push(`# --- Audio Node: ${sanitizeSafeIdentifier(node.name || node.id, safeId)} (${mode}) ---`);

    if (mode !== 'tts' && sttBackend === 'speaches') {
      const sttPort = extractPortFromUrl(cfg.sttEndpoint || node.endpoint, 8005);
      const sttModel = escapeShellArg(
        cfg.defaultSttModel || STT_BACKEND_PRESETS.speaches.defaultModel
      );
      lines.push(
        `"$ENGINE" run -d --replace --name ${escapeShellArg(`eluvix-stt-${safeId}`)} \\`,
        `  -p 127.0.0.1:${sttPort}:8000 \\`,
        `  -e WHISPER__MODEL=${sttModel} \\`,
        `  ghcr.io/speaches-ai/speaches:latest-cuda`
      );
      lines.push('');
    } else if (mode !== 'tts' && sttBackend === 'whisper-cpp') {
      const sttPort = extractPortFromUrl(cfg.sttEndpoint || node.endpoint, 8086);
      const sttModel = escapeShellArg(
        cfg.defaultSttModel || STT_BACKEND_PRESETS['whisper-cpp'].defaultModel
      );
      lines.push(
        `# whisper.cpp OpenAI-compatible HTTP server on 127.0.0.1:${sttPort}`,
        `whisper-server --host 127.0.0.1 --port ${sttPort} -m ${sttModel} &`
      );
      lines.push('');
    }

    if (mode !== 'stt' && ttsBackend === 'kokoro') {
      const ttsPort = extractPortFromUrl(
        cfg.ttsEndpoint || (mode === 'tts' ? node.endpoint : 'http://localhost:8880'),
        8880
      );
      lines.push(
        `"$ENGINE" run -d --replace --name ${escapeShellArg(`eluvix-tts-${safeId}`)} \\`,
        `  -p 127.0.0.1:${ttsPort}:8880 \\`,
        `  ghcr.io/remsky/kokoro-fastapi-gpu:latest`
      );
      lines.push('');
    } else if (mode !== 'stt' && ttsBackend === 'piper') {
      const ttsPort = extractPortFromUrl(
        cfg.ttsEndpoint || (mode === 'tts' ? node.endpoint : 'http://localhost:8880'),
        8880
      );
      const piperModel = escapeShellArg(
        cfg.defaultTtsModel || TTS_BACKEND_PRESETS.piper.defaultModel
      );
      lines.push(
        `"$ENGINE" run -d --replace --name ${escapeShellArg(`eluvix-piper-${safeId}`)} \\`,
        `  -p 127.0.0.1:${ttsPort}:8880 \\`,
        `  -e PIPER_VOICE=${piperModel} \\`,
        `  rhasspy/wyoming-piper:latest`
      );
      lines.push('');
    }
  }

  return lines.join('\n').trim() + '\n';
}
