"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import NodeHealthIndicator from '../NodeHealthIndicator';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import {
  STT_BACKEND_PRESETS,
  TTS_BACKEND_PRESETS,
  type AudioNodeMode,
  type SttBackendPreset,
  type TtsBackendPreset,
  type AudioResponseFormat,
} from '@eluvix/router-core/audio';

export default function AudioVoiceNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();

  const [endpoint, setEndpoint] = useState<string>(data?.endpoint || 'http://localhost:8005');
  const [priority, setPriority] = useState<number>(data?.priority ?? 20);
  const [mode, setMode] = useState<AudioNodeMode>(data?.audio?.mode || 'both');
  const [sttPreset, setSttPreset] = useState<SttBackendPreset>(
    data?.audio?.sttBackend || data?.audio?.sttPreset || 'speaches'
  );
  const [ttsPreset, setTtsPreset] = useState<TtsBackendPreset>(
    data?.audio?.ttsBackend || data?.audio?.ttsPreset || 'kokoro'
  );
  const [ttsEndpoint, setTtsEndpoint] = useState<string>(
    data?.audio?.ttsEndpoint || 'http://localhost:8880'
  );
  const [defaultVoice, setDefaultVoice] = useState<string>(
    data?.audio?.defaultVoice || 'af_heart'
  );
  const [responseFormat, setResponseFormat] = useState<AudioResponseFormat>(
    data?.audio?.responseFormat || 'mp3'
  );
  const [scrubTranscriptPii, setScrubTranscriptPii] = useState<boolean>(
    data?.audio?.scrubTranscriptPii ?? true
  );
  const [expanded, setExpanded] = useState<boolean>(false);

  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!data) return;
    setEndpoint(data.endpoint || 'http://localhost:8005');
    setPriority(data.priority ?? 20);
    if (data.audio) {
      setMode(data.audio.mode || 'both');
      setSttPreset(data.audio.sttBackend || data.audio.sttPreset || 'speaches');
      setTtsPreset(data.audio.ttsBackend || data.audio.ttsPreset || 'kokoro');
      setTtsEndpoint(data.audio.ttsEndpoint || 'http://localhost:8880');
      setDefaultVoice(data.audio.defaultVoice || 'af_heart');
      setResponseFormat(data.audio.responseFormat || 'mp3');
      setScrubTranscriptPii(data.audio.scrubTranscriptPii ?? true);
    }
  }, [data]);

  const syncData = useCallback(
    (patch: Record<string, any>) => {
      updateNodeData(id, patch);
      if (typeof dataRef.current?.onChange === 'function') {
        dataRef.current.onChange(id, { ...dataRef.current, ...patch });
      }
    },
    [id, updateNodeData]
  );

  const syncAudioConfig = useCallback(
    (audioPatch: Record<string, any>, topPatch?: Record<string, any>) => {
      const nextSttPreset = (audioPatch.sttBackend ?? audioPatch.sttPreset ?? sttPreset) as SttBackendPreset;
      const nextTtsPreset = (audioPatch.ttsBackend ?? audioPatch.ttsPreset ?? ttsPreset) as TtsBackendPreset;
      const nextMode = (audioPatch.mode ?? mode) as AudioNodeMode;
      const sttSpec = STT_BACKEND_PRESETS[nextSttPreset] || STT_BACKEND_PRESETS.speaches;
      const ttsSpec = TTS_BACKEND_PRESETS[nextTtsPreset] || TTS_BACKEND_PRESETS.kokoro;

      const models: string[] = [];
      if (nextMode === 'both' || nextMode === 'stt') {
        models.push(sttSpec.defaultModel, 'whisper-1');
      }
      if (nextMode === 'both' || nextMode === 'tts') {
        models.push(ttsSpec.defaultModel, 'tts-1');
      }

      const nextAudio = {
        mode: nextMode,
        sttBackend: nextSttPreset,
        ttsBackend: nextTtsPreset,
        ttsEndpoint,
        defaultVoice,
        responseFormat,
        scrubTranscriptPii,
        ...(dataRef.current?.audio || {}),
        ...audioPatch,
      };
      syncData({
        models: Array.from(new Set(models)),
        audio: nextAudio,
        ...(topPatch || {}),
      });
    },
    [mode, sttPreset, ttsPreset, ttsEndpoint, defaultVoice, responseFormat, scrubTranscriptPii, syncData]
  );

  let portNum = '8005';
  try {
    const parsed = new URL(endpoint);
    if (parsed.port) portNum = parsed.port;
  } catch {
    // default 8005
  }

  return (
    <div className="bg-cyan-950/85 border-2 border-cyan-500/80 rounded-lg p-4 shadow-xl w-80 text-white backdrop-blur-sm relative">
      <Handle
        type="target"
        position={Position.Left}
        className="w-3.5 h-3.5 bg-cyan-400 -left-2"
      />
      <NodeHealthIndicator serviceName="audio" liveTelemetry={data?.liveTelemetry} />

      <div className="flex items-center justify-between border-b border-cyan-800/70 pb-2 mb-3 pr-14">
        <div className="flex items-center space-x-2">
          <span className="text-xl" role="img" aria-label="Sovereign Audio">
            🎙️
          </span>
          <div>
            <div className="font-bold text-sm text-cyan-200">Sovereign Audio &amp; Voice</div>
            <div className="text-[10px] text-cyan-300/80 font-mono">
              Headless STT + TTS · :{portNum}
            </div>
          </div>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded font-mono uppercase bg-cyan-900/70 text-cyan-200 border border-cyan-600/50">
          {mode === 'both' ? 'STT+TTS' : mode.toUpperCase()}
        </span>
      </div>

      <div className="space-y-2.5 text-xs">
        {/* Pipeline Mode */}
        <div>
          <label className="text-gray-300 block mb-1 font-semibold">Audio Modality Role</label>
          <select
            aria-label="Audio Modality Role"
            value={mode}
            onChange={(e) => {
              const next = e.target.value as AudioNodeMode;
              setMode(next);
              syncAudioConfig({ mode: next });
            }}
            className="w-full bg-gray-900 border border-cyan-700/70 rounded p-1.5 text-cyan-100 text-[11px]"
          >
            <option value="both">Bidirectional (Whisper STT + Kokoro/Piper TTS)</option>
            <option value="stt">Speech-to-Text Only (/v1/audio/transcriptions)</option>
            <option value="tts">Text-to-Speech Only (/v1/audio/speech)</option>
          </select>
        </div>

        {/* Primary STT / Audio Endpoint */}
        <div>
          <label className="text-gray-300 block mb-1 font-semibold">
            {mode === 'tts' ? 'TTS Server Endpoint' : 'STT / Primary Audio Endpoint'}
          </label>
          <input
            type="text"
            aria-label="Audio Endpoint"
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              syncData({ endpoint: e.target.value });
            }}
            className="w-full bg-gray-900 border border-gray-700 rounded p-1.5 text-gray-200 font-mono text-[11px]"
          />
        </div>

        {/* STT Preset */}
        {(mode === 'both' || mode === 'stt') && (
          <div>
            <label className="text-gray-300 block mb-1 font-semibold">STT Engine Preset</label>
            <select
              aria-label="STT Engine Preset"
              value={sttPreset}
              onChange={(e) => {
                const next = e.target.value as SttBackendPreset;
                setSttPreset(next);
                const defaultEp = STT_BACKEND_PRESETS[next]?.defaultEndpoint || endpoint;
                setEndpoint(defaultEp);
                syncAudioConfig({ sttBackend: next }, { endpoint: defaultEp });
              }}
              className="w-full bg-gray-900 border border-gray-700 rounded p-1.5 text-gray-200 text-[11px]"
            >
              {Object.entries(STT_BACKEND_PRESETS).map(([key, spec]) => (
                <option key={key} value={key}>
                  {spec.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* TTS Preset */}
        {(mode === 'both' || mode === 'tts') && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-gray-300 block mb-1 font-semibold">TTS Engine</label>
              <select
                aria-label="TTS Engine"
                value={ttsPreset}
                onChange={(e) => {
                  const next = e.target.value as TtsBackendPreset;
                  const spec = TTS_BACKEND_PRESETS[next];
                  setTtsPreset(next);
                  if (spec) {
                    setTtsEndpoint(spec.defaultEndpoint);
                    setDefaultVoice(spec.defaultVoice || 'af_heart');
                    syncAudioConfig({
                      ttsBackend: next,
                      ttsEndpoint: spec.defaultEndpoint,
                      defaultVoice: spec.defaultVoice || 'af_heart',
                    });
                  } else {
                    syncAudioConfig({ ttsBackend: next });
                  }
                }}
                className="w-full bg-gray-900 border border-gray-700 rounded p-1.5 text-gray-200 text-[11px]"
              >
                {Object.entries(TTS_BACKEND_PRESETS).map(([key, spec]) => (
                  <option key={key} value={key}>
                    {spec.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-gray-300 block mb-1 font-semibold">Voice / Format</label>
              <div className="flex gap-1">
                <input
                  type="text"
                  aria-label="Default Voice"
                  value={defaultVoice}
                  onChange={(e) => {
                    setDefaultVoice(e.target.value);
                    syncAudioConfig({ defaultVoice: e.target.value });
                  }}
                  className="w-3/5 bg-gray-900 border border-gray-700 rounded p-1.5 text-gray-200 font-mono text-[10px]"
                />
                <select
                  aria-label="Audio Output Format"
                  value={responseFormat}
                  onChange={(e) => {
                    const fmt = e.target.value as AudioResponseFormat;
                    setResponseFormat(fmt);
                    syncAudioConfig({ responseFormat: fmt });
                  }}
                  className="w-2/5 bg-gray-900 border border-gray-700 rounded p-1 text-gray-200 font-mono text-[10px]"
                >
                  <option value="mp3">mp3</option>
                  <option value="wav">wav</option>
                  <option value="opus">opus</option>
                  <option value="flac">flac</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Collapsible Advanced Controls */}
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="w-full text-left text-[10px] font-mono text-cyan-300 hover:text-cyan-200 flex items-center justify-between pt-1"
        >
          <span>{expanded ? '▾ Hide Voice & Privacy Options' : '▸ Voice Split Port & PII Scrub'}</span>
          <span className="text-gray-400">prio {priority}</span>
        </button>

        {expanded && (
          <div className="space-y-2 pt-1.5 border-t border-cyan-900/60">
            {mode === 'both' && (
              <div>
                <label className="text-gray-400 block mb-0.5 text-[10px]">
                  Dedicated TTS Endpoint (Kokoro / Piper)
                </label>
                <input
                  type="text"
                  value={ttsEndpoint}
                  onChange={(e) => {
                    setTtsEndpoint(e.target.value);
                    syncAudioConfig({ ttsEndpoint: e.target.value });
                  }}
                  className="w-full bg-gray-900 border border-gray-700 rounded p-1 text-gray-200 font-mono text-[10px]"
                />
              </div>
            )}

            <label className="flex items-center justify-between text-[11px] text-gray-200 cursor-pointer">
              <span>Scrub Transcript PII (PrivacyGuard)</span>
              <input
                type="checkbox"
                checked={scrubTranscriptPii}
                onChange={(e) => {
                  setScrubTranscriptPii(e.target.checked);
                  syncAudioConfig({ scrubTranscriptPii: e.target.checked });
                }}
                className="accent-cyan-500"
              />
            </label>
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="w-3.5 h-3.5 bg-cyan-400 -right-2"
      />
    </div>
  );
}
