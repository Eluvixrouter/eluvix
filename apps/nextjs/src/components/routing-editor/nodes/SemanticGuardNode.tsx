"use client";

import { useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function SemanticGuardNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [routeName, setRouteName] = useState(data?.routeName || 'prompt-injection-guard');
  const [encoder, setEncoder] = useState(data?.encoder || 'deberta-v3-injection');
  const [similarityThreshold, setSimilarityThreshold] = useState(data?.threshold ?? 0.82);
  const [action, setAction] = useState(data?.enforcementAction || data?.action || 'block');

  // Ensure default structure
  if (data) {
    if (!data.routeName) data.routeName = routeName;
    if (!data.encoder) data.encoder = encoder;
    if (data.threshold === undefined) data.threshold = similarityThreshold;
    if (!data.enforcementAction) data.enforcementAction = action;
    if (!data.threatVectors) {
      data.threatVectors = {
        instructionOverride: true,
        danJailbreak: true,
        systemPromptLeak: true,
        obfuscation: true
      };
    }
    if (!data.bannedPhrases) data.bannedPhrases = [];
  }

  const syncData = (updates: Record<string, any>) => {
    if (data) Object.assign(data, updates);
    if (id) updateNodeData(id, updates);
  };

  const handleRouteChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setRouteName(val);
    syncData({ routeName: val });
  };

  const handleEncoderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setEncoder(val);
    syncData({ encoder: val });
  };

  const handleActionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setAction(val);
    syncData({ enforcementAction: val, action: val });
  };

  const handleThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value) || 0;
    setSimilarityThreshold(val);
    syncData({ threshold: val });
  };

  const threatVectors = data?.threatVectors || {
    instructionOverride: true,
    danJailbreak: true,
    systemPromptLeak: true,
    obfuscation: true
  };
  const activeVectors = Object.values(threatVectors).filter(Boolean).length;

  return (
    <div className="bg-gray-900 border-2 border-orange-500 rounded-lg p-3.5 min-w-[280px] max-w-[320px] shadow-2xl transition hover:shadow-orange-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-orange-500 -left-2" />
      
      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">🎯</span>
          <div>
            <div className="font-bold text-orange-400 text-sm">Semantic Router Guard</div>
            <div className="text-[10px] text-gray-400 font-mono">Embedding &amp; Injection Defense</div>
          </div>
        </div>
        <span className="text-[10px] bg-orange-500/20 text-orange-300 px-1.5 py-0.5 rounded font-mono">
          {action.toUpperCase()}
        </span>
      </div>
      
      <div className="text-xs text-gray-300 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Route Name</label>
            <input 
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-orange-500 rounded p-1.5 text-white text-[11px] outline-none transition" 
              value={routeName}
              onChange={handleRouteChange}
              placeholder="e.g. prompt-injection-guard"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Action</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-orange-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
              value={action}
              onChange={handleActionChange}
            >
              <option value="block">🚫 Block (400)</option>
              <option value="strip">✂️ Strip Injection</option>
              <option value="divert">🔀 Divert/Honeypot</option>
              <option value="warn">⚠️ Warn &amp; Pass</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Classifier / Encoder Model</label>
          <select 
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-orange-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
            value={encoder}
            onChange={handleEncoderChange}
          >
            <optgroup label="🛡️ Prompt Injection Classifiers">
              <option value="deberta-v3-injection">DeBERTa-v3 (protectai/prompt-injection-v2)</option>
              <option value="distilbert-injection">DistilBERT Injection (fmops/distilbert-fast)</option>
              <option value="llama-guard-3">Llama-Guard-3:1b (Meta Local Guard)</option>
              <option value="granite-guardian">IBM Granite Guardian 3.0 (2B RAG Guard)</option>
              <option value="shieldgemma-2b">ShieldGemma 2B (Google Safety)</option>
            </optgroup>
            <optgroup label="⚡ Semantic Vector Encoders">
              <option value="fastembed">FastEmbed (Local BAAI/bge-small-en-v1.5)</option>
              <option value="ollama-nomic">Ollama (nomic-embed-text)</option>
              <option value="cohere">Cohere (embed-multilingual-v3.0)</option>
              <option value="openai">OpenAI (text-embedding-3-small)</option>
              <option value="huggingface">HuggingFace (sentence-transformers)</option>
              <option value="billama">Billama Semantic Mesh</option>
            </optgroup>
          </select>
        </div>

        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[10px] font-semibold text-gray-400">Sensitivity Threshold</label>
            <span className="text-[10px] font-mono text-orange-400 font-bold">{similarityThreshold}</span>
          </div>
          <input
            type="range"
            min="0.5"
            max="0.99"
            step="0.01"
            className="nodrag w-full accent-orange-500 cursor-pointer"
            value={similarityThreshold}
            onChange={handleThresholdChange}
          />
        </div>

        {/* Quick Badges Strip */}
        <div className="pt-2 border-t border-gray-800 grid grid-cols-2 gap-1.5 text-[9px] font-mono text-gray-400">
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🛡️</span>
            <span>Vectors: {activeVectors}/4</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🚫</span>
            <span>Banned: {data?.bannedPhrases?.length || 0}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>⚡</span>
            <span>Sens: {similarityThreshold}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🎯</span>
            <span>Act: {action}</span>
          </div>
        </div>
      </div>

      {/* Dual Out Handles */}
      <div className="mt-3 pt-2 border-t border-gray-800 space-y-2">
        <div className="relative flex items-center justify-between">
          <span className="text-[10px] font-semibold text-orange-400">Match / Safe Stream</span>
          <Handle type="source" position={Position.Right} id="match" className="w-3.5 h-3.5 bg-orange-500 -right-2" />
        </div>
        <div className="relative flex items-center justify-between">
          <span className="text-[10px] font-semibold text-red-400">Threat / Honeypot Sink</span>
          <Handle type="source" position={Position.Right} id="nomatch" className="w-3.5 h-3.5 bg-red-500 -right-2" />
        </div>
      </div>
    </div>
  );
}
