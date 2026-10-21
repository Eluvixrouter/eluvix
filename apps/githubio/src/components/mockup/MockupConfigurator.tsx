'use client';

import { useState } from 'react';

type ClientTab = 'claudecode' | 'cursor' | 'continue' | 'aider' | 'python' | 'env';

export function MockupConfigurator() {
  const [activeTab, setActiveTab] = useState<ClientTab>('cursor');
  const [protocol, setProtocol] = useState<'http' | 'https'>('http');
  const [copied, setCopied] = useState(false);

  const baseUrl = protocol === 'http' ? 'http://127.0.0.1:3580/v1' : 'https://127.0.0.1:3588/v1';

  const CONFIG_SNIPPETS: Record<ClientTab, { title: string; filename: string; code: string }> = {
    cursor: {
      title: 'Cursor IDE (Settings -> Models)',
      filename: '.cursor/settings.json',
      code: `{
  "cursor.openaiBaseUrl": "${baseUrl}",
  "cursor.openaiApiKey": "sk-eluvix-local-root",
  "cursor.models": [
    { "name": "qwen2.5-coder:7b", "default": true },
    { "name": "llama3.1:latest" },
    { "name": "deepseek-coder:6.7b" }
  ]
}`,
    },
    claudecode: {
      title: 'Claude Code CLI',
      filename: '~/.claude.json',
      code: `{
  "customEndpoint": "${baseUrl}",
  "apiKey": "sk-eluvix-local-root",
  "defaultModel": "llama3.1:latest",
  "maxTokens": 4096,
  "privacyShieldEnabled": true
}`,
    },
    continue: {
      title: 'Continue.dev (VS Code & JetBrains)',
      filename: '~/.continue/config.json',
      code: `{
  "models": [
    {
      "title": "Eluvix Sovereign Local",
      "provider": "openai",
      "model": "qwen2.5-coder:7b",
      "apiBase": "${baseUrl}",
      "apiKey": "sk-eluvix-local-root"
    }
  ],
  "tabAutocompleteModel": {
    "title": "vLLM-sr Autocomplete",
    "provider": "openai",
    "model": "llama3.2-1b-FLM",
    "apiBase": "${baseUrl}"
  }
}`,
    },
    aider: {
      title: 'Aider AI Pair Programmer',
      filename: '.aider.conf.yml',
      code: `openai-api-base: ${baseUrl}
openai-api-key: sk-eluvix-local-root
model: openai/qwen2.5-coder:7b
edit-format: diff
stream: true`,
    },
    python: {
      title: 'Python OpenAI SDK',
      filename: 'client.py',
      code: `from openai import OpenAI

# Connect to Eluvix Sovereign Gateway
client = OpenAI(
    base_url="${baseUrl}",
    api_key="sk-eluvix-local-root",
)

response = client.chat.completions.create(
    model="llama3.1:latest",
    messages=[{"role": "user", "content": "Hello sovereign world"}],
)

print(response.choices[0].message.content)`,
    },
    env: {
      title: 'Universal Environment Variables',
      filename: '.env',
      code: `OPENAI_API_BASE=${baseUrl}
OPENAI_BASE_URL=${baseUrl}
OPENAI_API_KEY=sk-eluvix-local-root
ELUVIX_AIRGAPPED_MODE=false
ELUVIX_FALLBACK_STRATEGY=priority`,
    },
  };

  const currentSnippet = CONFIG_SNIPPETS[activeTab];

  function handleCopy() {
    navigator.clipboard.writeText(currentSnippet.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-3 border-b border-slate-800/80 gap-3">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span>⚙️ Zero-Config Client Setup</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-bold border border-emerald-500/20">
                Drop-in OpenAI Compatibility
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Connect any AI editor or developer tool directly to your local Eluvix gateway.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 font-mono">Protocol:</span>
            <button
              type="button"
              onClick={() => setProtocol('http')}
              className={`px-2.5 py-1 rounded text-xs font-semibold font-mono transition ${
                protocol === 'http'
                  ? 'bg-sky-500 text-slate-950 font-bold'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              HTTP (3580)
            </button>
            <button
              type="button"
              onClick={() => setProtocol('https')}
              className={`px-2.5 py-1 rounded text-xs font-semibold font-mono transition ${
                protocol === 'https'
                  ? 'bg-sky-500 text-slate-950 font-bold'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              HTTPS (3588)
            </button>
          </div>
        </div>

        {/* Client Selection Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pt-3">
          {[
            { id: 'cursor', label: 'Cursor IDE' },
            { id: 'claudecode', label: 'Claude Code' },
            { id: 'continue', label: 'Continue.dev' },
            { id: 'aider', label: 'Aider AI' },
            { id: 'python', label: 'Python SDK' },
            { id: 'env', label: '.env File' },
          ].map((client) => (
            <button
              key={client.id}
              type="button"
              onClick={() => setActiveTab(client.id as ClientTab)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition ${
                activeTab === client.id
                  ? 'bg-sky-500 text-slate-950 font-bold shadow-sm'
                  : 'bg-slate-950/60 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700'
              }`}
            >
              {client.label}
            </button>
          ))}
        </div>
      </div>

      {/* Code Snippet Box */}
      <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-5 space-y-3">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
          <div>
            <div className="text-xs font-bold text-white flex items-center gap-2">
              <span>{currentSnippet.title}</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-sky-400">
                {currentSnippet.filename}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Copy and paste this snippet into your client configuration file.
            </p>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="px-3.5 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs shadow-md transition"
          >
            {copied ? '✓ Copied!' : 'Copy Config'}
          </button>
        </div>

        <pre className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed">
          <code>{currentSnippet.code}</code>
        </pre>

        <div className="flex items-center gap-2 pt-2 text-[11px] text-slate-400 font-mono">
          <span className="text-emerald-400">✓ In-flight PII masking enabled automatically</span>
          <span>•</span>
          <span>Local requests route at $0.00</span>
        </div>
      </div>
    </div>
  );
}
