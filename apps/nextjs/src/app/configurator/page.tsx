'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';

interface ModelMetadata {
  id: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
  provider: string;
  isFrontier?: boolean;
  isCode?: boolean;
}

interface ServerData {
  server: {
    hostname: string;
    httpsPort: number;
    httpPort: number;
    httpsBaseUrl: string;
    httpBaseUrl: string;
    rootCaPath: string | null;
  };
  auth: {
    adminPassword: string;
    authFile: string;
  };
  clients: {
    opencode: {
      installed: boolean;
      configPath: string;
    };
    continue: {
      installed: boolean;
      configPath: string;
    };
  };
  models: ModelMetadata[];
  upstreamsCount: number;
}

export default function ConfiguratorPage() {
  const [data, setData] = useState<ServerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<'https' | 'http'>('https');
  const [showApiKey, setShowApiKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'opencode' | 'continue' | 'cursor' | 'aider' | 'cline' | 'python' | 'env'>('opencode');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [customLimits, setCustomLimits] = useState<Record<string, { context: number; output: number }>>({});
  const [searchFilter, setSearchFilter] = useState('');
  const [applyState, setApplyState] = useState<{ [client: string]: { loading: boolean; message: string | null; error?: boolean } }>({});

  const fetchData = async () => {
    try {
      const res = await fetch('/api/v1/configurator/data');
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
        // Default selection: select all models initially
        const ids = new Set<string>();
        const limits: Record<string, { context: number; output: number }> = {};
        json.data.models.forEach((m: ModelMetadata) => {
          ids.add(m.id);
          limits[m.id] = { context: m.contextLimit, output: m.outputLimit };
        });
        setSelectedIds(ids);
        setCustomLimits(limits);
      }
    } catch (err) {
      console.error('Failed to load configurator data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleRefreshUpstreams = async () => {
    setRefreshing(true);
    setRefreshMessage('Scanning upstreams for live models...');
    try {
      const res = await fetch('/api/v1/detect-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true })
      });
      const json = await res.json();
      if (json.success) {
        await fetchData();
        setRefreshMessage('✓ Upstream models re-scanned and synchronized!');
      } else {
        setRefreshMessage(`Scan notice: ${json.error || 'Check active nodes'}`);
      }
    } catch (err: any) {
      setRefreshMessage(`Scan error: ${err.message}`);
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMessage(null), 4000);
    }
  };

  const currentBaseUrl = useMemo(() => {
    if (!data) return 'https://127.0.0.1:3000/api/v1';
    return protocol === 'https' ? data.server.httpsBaseUrl : data.server.httpBaseUrl;
  }, [data, protocol]);

  const apiKey = data?.auth.adminPassword || 'YOUR_ADMIN_PASSWORD';

  const selectedModelsList = useMemo(() => {
    if (!data) return [];
    return data.models
      .filter((m) => selectedIds.has(m.id))
      .map((m) => {
        const lim = customLimits[m.id] || { context: m.contextLimit, output: m.outputLimit };
        return {
          ...m,
          contextLimit: lim.context,
          outputLimit: lim.output,
        };
      });
  }, [data, selectedIds, customLimits]);

  const filteredModels = useMemo(() => {
    if (!data) return [];
    if (!searchFilter.trim()) return data.models;
    const q = searchFilter.toLowerCase();
    return data.models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
    );
  }, [data, searchFilter]);

  const toggleModel = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const selectPreset = (type: 'all' | 'recommended' | 'code' | 'none') => {
    if (!data) return;
    if (type === 'all') {
      setSelectedIds(new Set(data.models.map((m) => m.id)));
    } else if (type === 'none') {
      setSelectedIds(new Set());
    } else if (type === 'recommended') {
      const rec = data.models
        .filter((m) => m.id === 'auto' || m.isFrontier || m.isCode || m.id.includes('llama3.1'))
        .map((m) => m.id);
      setSelectedIds(new Set(rec));
    } else if (type === 'code') {
      const code = data.models.filter((m) => m.isCode || m.id === 'auto').map((m) => m.id);
      setSelectedIds(new Set(code));
    }
  };

  const copyToClipboard = (text: string, keyName: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(keyName);
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const downloadFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleApplyToClient = async (client: 'opencode' | 'continue') => {
    setApplyState((prev) => ({
      ...prev,
      [client]: { loading: true, message: 'Applying configuration...' },
    }));

    try {
      const res = await fetch('/api/v1/configurator/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client,
          protocol,
          models: selectedModelsList,
        }),
      });

      const json = await res.json();
      if (json.success) {
        setApplyState((prev) => ({
          ...prev,
          [client]: { loading: false, message: `✓ ${json.message}`, error: false },
        }));
        await fetchData();
      } else {
        setApplyState((prev) => ({
          ...prev,
          [client]: { loading: false, message: `Failed: ${json.error}`, error: true },
        }));
      }
    } catch (err: any) {
      setApplyState((prev) => ({
        ...prev,
        [client]: { loading: false, message: `Error: ${err.message}`, error: true },
      }));
    } finally {
      setTimeout(() => {
        setApplyState((prev) => ({
          ...prev,
          [client]: { loading: false, message: null },
        }));
      }, 5000);
    }
  };

  // Generate Snippets
  const openCodeSnippet = useMemo(() => {
    const modelsMap: Record<string, { limit: { context: number; output: number }; name: string }> = {};
    selectedModelsList.forEach((m) => {
      modelsMap[m.id] = {
        name: m.name,
        limit: {
          context: m.contextLimit,
          output: m.outputLimit,
        },
      };
    });

    return JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'Eluvix/auto',
        small_model: 'Eluvix/auto',
        provider: {
          Eluvix: {
            name: 'Eluvix Router (local)',
            npm: '@ai-sdk/openai-compatible',
            options: {
              apiKey,
              baseURL: currentBaseUrl,
            },
            models: modelsMap,
          },
        },
      },
      null,
      2
    );
  }, [selectedModelsList, apiKey, currentBaseUrl]);

  const continueSnippet = useMemo(() => {
    const models = selectedModelsList.map((m) => ({
      title: `Eluvix - ${m.name.replace(' (via Eluvix Router)', '').replace(' (via Eluvix)', '')}`,
      provider: 'openai',
      model: m.id,
      apiBase: currentBaseUrl,
      apiKey: apiKey,
      contextLength: m.contextLimit,
    }));

    return JSON.stringify({ models }, null, 2);
  }, [selectedModelsList, apiKey, currentBaseUrl]);

  const aiderSnippet = useMemo(() => {
    const primaryModel = selectedModelsList.find((m) => m.id === 'auto') ? 'auto' : selectedModelsList[0]?.id || 'auto';
    return `# Run Aider CLI directly:
aider --openai-api-base "${currentBaseUrl}" \\
      --openai-api-key "${apiKey}" \\
      --model "openai/${primaryModel}"

# Or add to ~/.aider.conf.yml:
openai-api-base: "${currentBaseUrl}"
openai-api-key: "${apiKey}"
model: "openai/${primaryModel}"
`;
  }, [selectedModelsList, apiKey, currentBaseUrl]);

  const clineSnippet = useMemo(() => {
    const primaryModel = selectedModelsList.find((m) => m.id === 'auto') ? 'auto' : selectedModelsList[0]?.id || 'auto';
    return JSON.stringify(
      {
        apiProvider: 'openai-compatible',
        openAiBaseUrl: currentBaseUrl,
        openAiApiKey: apiKey,
        openAiModelId: primaryModel,
      },
      null,
      2
    );
  }, [selectedModelsList, apiKey, currentBaseUrl]);

  const pythonSnippet = useMemo(() => {
    return `from openai import OpenAI

# Initialize OpenAI client with Eluvix Gateway
client = OpenAI(
    base_url="${currentBaseUrl}",
    api_key="${apiKey}",
)

# Route via universal 'auto' or pass-through model ID
response = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "system", "content": "You are a helpful coding assistant."},
        {"role": "user", "content": "Write a quicksort in Python."}
    ],
    temperature=0.7,
)

print(response.choices[0].message.content)
`;
  }, [apiKey, currentBaseUrl]);

  const envSnippet = useMemo(() => {
    const lines = [
      `# Eluvix Local AI Gateway Environment`,
      `export OPENAI_BASE_URL="${currentBaseUrl}"`,
      `export OPENAI_API_KEY="${apiKey}"`,
      `export OPENAI_API_MODEL="auto"`,
    ];
    if (protocol === 'https' && data?.server.rootCaPath) {
      lines.push(
        `\n# For Node.js tools (OpenCode, Copilot, etc.) trusting local mkcert CA:`,
        `export NODE_EXTRA_CA_CERTS="${data.server.rootCaPath}"`
      );
    }
    return lines.join('\n');
  }, [currentBaseUrl, apiKey, protocol, data]);

  if (loading) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 text-slate-100 font-sans p-6">
        <div className="flex items-center gap-3 text-sky-400">
          <span className="animate-spin text-2xl">⏳</span>
          <span className="text-lg font-medium">Loading Eluvix Configurator...</span>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center p-6 md:p-12 bg-slate-950 text-slate-100 font-sans">
      <div className="max-w-6xl w-full">
        {/* Top Breadcrumb & Navigation */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center pb-6 border-b border-slate-800 gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              <Link href="/" className="hover:text-sky-400 transition">
                Eluvix
              </Link>
              <span>/</span>
              <span className="text-sky-400">Configurator</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-3xl">⚙️</span>
              <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-white">
                Client Configurator &amp; Auto-Generator
              </h1>
            </div>
            <p className="text-slate-400 text-sm mt-1">
              Auto-generate client configurations for OpenCode, Continue, Cursor, Aider, and OpenAI SDKs based on active models.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <Link
              href="/observability"
              className="bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs px-3.5 py-2 rounded-lg shadow-lg shadow-purple-600/20 transition flex items-center gap-1.5"
            >
              <span>📊</span> Observability
            </Link>
            <Link
              href="/"
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-2 rounded-lg border border-slate-700 transition"
            >
              Dashboard
            </Link>
            <Link
              href="/editor"
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs px-3.5 py-2 rounded-lg shadow-lg shadow-indigo-600/20 transition flex items-center gap-1.5"
            >
              <span>🔀</span> Node Editor
            </Link>
            <Link
              href="/playground"
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs px-3.5 py-2 rounded-lg shadow-lg shadow-emerald-600/20 transition flex items-center gap-1.5"
            >
              <span>🧪</span> Trace Playground
            </Link>
          </div>
        </header>

        {/* Gateway Connection & Protocol Status */}
        <section className="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
          <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 pb-6 border-b border-slate-800">
            <div>
              <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">Gateway Connection</span>
              <h2 className="text-lg font-bold text-white mt-0.5">Active Endpoints &amp; Authentication</h2>
            </div>

            {/* Protocol Switcher */}
            <div className="flex items-center gap-2 bg-slate-950 p-1.5 rounded-lg border border-slate-800">
              <span className="text-xs text-slate-400 px-2 font-medium">Protocol:</span>
              <button
                onClick={() => setProtocol('https')}
                className={`text-xs px-3 py-1.5 rounded-md font-medium transition flex items-center gap-1.5 ${
                  protocol === 'https'
                    ? 'bg-sky-500 text-slate-950 font-bold shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>🔒</span> HTTPS (:3000)
              </button>
              <button
                onClick={() => setProtocol('http')}
                className={`text-xs px-3 py-1.5 rounded-md font-medium transition flex items-center gap-1.5 ${
                  protocol === 'http'
                    ? 'bg-emerald-500 text-slate-950 font-bold shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>⚡</span> HTTP (:3080 Loopback)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
            {/* Base URL */}
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 flex flex-col justify-between">
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">OpenAI Base URL</span>
                <div className="font-mono text-xs text-sky-300 mt-1 break-all select-all font-semibold">
                  {currentBaseUrl}
                </div>
              </div>
              <button
                onClick={() => copyToClipboard(currentBaseUrl, 'baseUrl')}
                className="mt-3 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 py-1 px-2.5 rounded transition self-start"
              >
                {copiedKey === 'baseUrl' ? '✓ Copied!' : '📋 Copy URL'}
              </button>
            </div>

            {/* API Key */}
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-center">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">API Key (Admin)</span>
                  <button
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="text-[11px] text-sky-400 hover:underline"
                  >
                    {showApiKey ? 'Hide' : 'Reveal'}
                  </button>
                </div>
                <div className="font-mono text-xs text-emerald-400 mt-1 break-all select-all font-semibold">
                  {showApiKey ? apiKey : '••••••••••••••••'}
                </div>
              </div>
              <button
                onClick={() => copyToClipboard(apiKey, 'apiKey')}
                className="mt-3 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 py-1 px-2.5 rounded transition self-start"
              >
                {copiedKey === 'apiKey' ? '✓ Copied!' : '📋 Copy Key'}
              </button>
            </div>

            {/* Model Detection & Sync */}
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 flex flex-col justify-between">
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Detected Models</span>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xl font-extrabold text-white">{data?.models.length || 0}</span>
                  <span className="text-xs text-slate-400">models across {data?.upstreamsCount || 0} upstreams</span>
                </div>
              </div>
              <button
                onClick={handleRefreshUpstreams}
                disabled={refreshing}
                className="mt-3 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-1 px-3 rounded transition self-start flex items-center gap-1.5"
              >
                <span className={refreshing ? 'animate-spin' : ''}>🔄</span>
                {refreshing ? 'Scanning Upstreams...' : 'Scan Upstreams'}
              </button>
            </div>
          </div>

          {refreshMessage && (
            <div className="mt-4 p-3 rounded-lg text-xs bg-slate-950 border border-indigo-500/40 text-indigo-300 font-mono flex items-center gap-2">
              <span>ℹ️</span> {refreshMessage}
            </div>
          )}
        </section>

        {/* Model Selection & Customization */}
        <section className="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pb-4 border-b border-slate-800">
            <div>
              <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">Model Selection</span>
              <h2 className="text-lg font-bold text-white mt-0.5">
                Active Models ({selectedIds.size} of {data?.models.length || 0} selected)
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-400">Presets:</span>
              <button
                onClick={() => selectPreset('all')}
                className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded transition"
              >
                All
              </button>
              <button
                onClick={() => selectPreset('recommended')}
                className="text-xs bg-indigo-950 hover:bg-indigo-900 text-indigo-300 border border-indigo-700/50 px-2.5 py-1 rounded transition font-medium"
              >
                Recommended
              </button>
              <button
                onClick={() => selectPreset('code')}
                className="text-xs bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/50 px-2.5 py-1 rounded transition font-medium"
              >
                Coding
              </button>
              <button
                onClick={() => selectPreset('none')}
                className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-400 px-2.5 py-1 rounded transition"
              >
                Deselect
              </button>
            </div>
          </div>

          <div className="mt-4 mb-4">
            <input
              type="text"
              placeholder="Search detected models..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 font-sans"
            />
          </div>

          {/* Model Matrix Table */}
          <div className="max-h-64 overflow-y-auto border border-slate-800 rounded-lg bg-slate-950">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-900 text-slate-400 font-semibold border-b border-slate-800">
                <tr>
                  <th className="p-2.5 w-10">Select</th>
                  <th className="p-2.5">Model ID</th>
                  <th className="p-2.5">Provider / Upstream</th>
                  <th className="p-2.5 w-32">Context Window</th>
                  <th className="p-2.5 w-28">Max Output</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850">
                {filteredModels.map((m) => {
                  const isChecked = selectedIds.has(m.id);
                  const lim = customLimits[m.id] || { context: m.contextLimit, output: m.outputLimit };

                  return (
                    <tr
                      key={m.id}
                      className={`hover:bg-slate-900/60 transition ${isChecked ? 'bg-slate-900/30' : 'opacity-60'}`}
                    >
                      <td className="p-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleModel(m.id)}
                          className="rounded border-slate-700 text-sky-500 focus:ring-sky-500 h-4 w-4 bg-slate-900 cursor-pointer"
                        />
                      </td>
                      <td className="p-2.5 font-mono text-slate-200 font-medium">
                        <div className="flex items-center gap-2">
                          <span>{m.id}</span>
                          {m.id === 'auto' && (
                            <span className="bg-sky-950 text-sky-400 border border-sky-800 text-[10px] px-1.5 py-0.5 rounded font-bold">
                              Dynamic Router
                            </span>
                          )}
                          {m.isFrontier && m.id !== 'auto' && (
                            <span className="bg-purple-950 text-purple-400 border border-purple-800 text-[10px] px-1.5 py-0.5 rounded">
                              Frontier
                            </span>
                          )}
                          {m.isCode && m.id !== 'auto' && (
                            <span className="bg-emerald-950 text-emerald-400 border border-emerald-800 text-[10px] px-1.5 py-0.5 rounded">
                              Coding
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-2.5 text-slate-400">{m.provider}</td>
                      <td className="p-2.5">
                        <input
                          type="number"
                          value={lim.context}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10) || 0;
                            setCustomLimits((prev) => ({
                              ...prev,
                              [m.id]: { ...lim, context: val },
                            }));
                          }}
                          className="w-24 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-mono text-xs focus:outline-none focus:border-sky-500"
                        />
                      </td>
                      <td className="p-2.5">
                        <input
                          type="number"
                          value={lim.output}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10) || 0;
                            setCustomLimits((prev) => ({
                              ...prev,
                              [m.id]: { ...lim, output: val },
                            }));
                          }}
                          className="w-20 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-mono text-xs focus:outline-none focus:border-sky-500"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Client Configuration Tabs */}
        <section className="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
          <div className="pb-4 border-b border-slate-800">
            <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">Client Integrations</span>
            <h2 className="text-lg font-bold text-white mt-0.5">Generate or Apply Configuration Snippets</h2>
          </div>

          {/* Navigation Tabs */}
          <div className="flex flex-wrap gap-2 mt-4 pb-2 border-b border-slate-800">
            {[
              { id: 'opencode', label: 'OpenCode', badge: data?.clients.opencode.installed ? 'Installed' : null },
              { id: 'continue', label: 'Continue.dev', badge: data?.clients.continue.installed ? 'Installed' : null },
              { id: 'cursor', label: 'Cursor & Windsurf' },
              { id: 'aider', label: 'Aider' },
              { id: 'cline', label: 'Cline / Claude Dev' },
              { id: 'python', label: 'Python / OpenAI SDK' },
              { id: 'env', label: 'Shell / .env' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`text-xs px-3.5 py-2 rounded-lg font-medium transition flex items-center gap-1.5 ${
                  activeTab === tab.id
                    ? 'bg-sky-500 text-slate-950 font-bold shadow-md shadow-sky-500/20'
                    : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                <span>{tab.label}</span>
                {tab.badge && (
                  <span className="bg-emerald-950 text-emerald-400 border border-emerald-800 text-[10px] px-1 rounded font-bold">
                    ✓ {tab.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="mt-6">
            {/* OpenCode */}
            {activeTab === 'opencode' && (
              <div>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      OpenCode Configuration
                      <span className="font-mono text-xs text-slate-400 font-normal">
                        ({data?.clients.opencode.configPath})
                      </span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Adds Eluvix as an OpenAI-compatible provider with {selectedModelsList.length} configured models.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => handleApplyToClient('opencode')}
                      disabled={applyState.opencode?.loading}
                      className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs px-3.5 py-1.5 rounded-lg shadow transition flex items-center gap-1.5"
                    >
                      <span>🚀</span>
                      {applyState.opencode?.loading ? 'Applying...' : 'Apply to Local Config'}
                    </button>
                    <button
                      onClick={() => copyToClipboard(openCodeSnippet, 'opencode')}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition"
                    >
                      {copiedKey === 'opencode' ? '✓ Copied!' : '📋 Copy JSON'}
                    </button>
                    <button
                      onClick={() => downloadFile(openCodeSnippet, 'opencode.json')}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition"
                    >
                      💾 Download
                    </button>
                  </div>
                </div>

                {applyState.opencode?.message && (
                  <div
                    className={`mb-4 p-3 rounded-lg text-xs font-mono ${
                      applyState.opencode.error
                        ? 'bg-rose-950/80 border border-rose-800 text-rose-300'
                        : 'bg-emerald-950/80 border border-emerald-800 text-emerald-300'
                    }`}
                  >
                    {applyState.opencode.message}
                  </div>
                )}

                <div className="relative">
                  <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 font-mono text-xs text-slate-300 overflow-x-auto max-h-96">
                    {openCodeSnippet}
                  </pre>
                </div>
              </div>
            )}

            {/* Continue.dev */}
            {activeTab === 'continue' && (
              <div>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      Continue.dev Configuration
                      <span className="font-mono text-xs text-slate-400 font-normal">
                        ({data?.clients.continue.configPath})
                      </span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Adds Eluvix models into the Continue.dev <code className="text-sky-400">models</code> array in <code className="text-sky-400">~/.continue/config.json</code>.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => handleApplyToClient('continue')}
                      disabled={applyState.continue?.loading}
                      className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs px-3.5 py-1.5 rounded-lg shadow transition flex items-center gap-1.5"
                    >
                      <span>🚀</span>
                      {applyState.continue?.loading ? 'Applying...' : 'Apply to Local Config'}
                    </button>
                    <button
                      onClick={() => copyToClipboard(continueSnippet, 'continue')}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition"
                    >
                      {copiedKey === 'continue' ? '✓ Copied!' : '📋 Copy JSON'}
                    </button>
                    <button
                      onClick={() => downloadFile(continueSnippet, 'continue-models.json')}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition"
                    >
                      💾 Download
                    </button>
                  </div>
                </div>

                {applyState.continue?.message && (
                  <div
                    className={`mb-4 p-3 rounded-lg text-xs font-mono ${
                      applyState.continue.error
                        ? 'bg-rose-950/80 border border-rose-800 text-rose-300'
                        : 'bg-emerald-950/80 border border-emerald-800 text-emerald-300'
                    }`}
                  >
                    {applyState.continue.message}
                  </div>
                )}

                <div className="relative">
                  <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 font-mono text-xs text-slate-300 overflow-x-auto max-h-96">
                    {continueSnippet}
                  </pre>
                </div>
              </div>
            )}

            {/* Cursor & Windsurf */}
            {activeTab === 'cursor' && (
              <div>
                <div className="mb-4">
                  <h3 className="text-sm font-bold text-white">Cursor &amp; Windsurf Settings</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    In Cursor Settings ➔ <strong>Models</strong> ➔ <strong>OpenAI API Key</strong>, toggle &ldquo;Override OpenAI Base URL&rdquo; and enter the values below:
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-slate-950 border border-slate-800 rounded-lg p-4">
                    <span className="text-xs text-slate-400 font-semibold uppercase">Base URL</span>
                    <div className="font-mono text-xs text-sky-400 mt-1 select-all">{currentBaseUrl}</div>
                    <button
                      onClick={() => copyToClipboard(currentBaseUrl, 'cursorBase')}
                      className="mt-3 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1 rounded transition"
                    >
                      {copiedKey === 'cursorBase' ? '✓ Copied!' : '📋 Copy Base URL'}
                    </button>
                  </div>

                  <div className="bg-slate-950 border border-slate-800 rounded-lg p-4">
                    <span className="text-xs text-slate-400 font-semibold uppercase">API Key</span>
                    <div className="font-mono text-xs text-emerald-400 mt-1 select-all">{apiKey}</div>
                    <button
                      onClick={() => copyToClipboard(apiKey, 'cursorKey')}
                      className="mt-3 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1 rounded transition"
                    >
                      {copiedKey === 'cursorKey' ? '✓ Copied!' : '📋 Copy API Key'}
                    </button>
                  </div>
                </div>

                <div className="mt-4 bg-slate-950 border border-slate-800 rounded-lg p-4">
                  <span className="text-xs text-slate-400 font-semibold uppercase">Recommended Model Names</span>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {selectedModelsList.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => copyToClipboard(m.id, `cursorModel-${m.id}`)}
                        className="bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700 text-xs px-2.5 py-1 rounded font-mono transition"
                      >
                        {copiedKey === `cursorModel-${m.id}` ? '✓ Copied' : m.id}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-500 mt-2">
                    Tip: Add <code className="text-sky-400 font-mono">auto</code> in Cursor to utilize Eluvix&apos;s intelligent multi-tier routing.
                  </p>
                </div>
              </div>
            )}

            {/* Aider */}
            {activeTab === 'aider' && (
              <div>
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Aider CLI Configuration</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Run Aider in your terminal or persist parameters to <code className="text-sky-400">~/.aider.conf.yml</code>.
                    </p>
                  </div>
                  <button
                    onClick={() => copyToClipboard(aiderSnippet, 'aider')}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition"
                  >
                    {copiedKey === 'aider' ? '✓ Copied!' : '📋 Copy Snippet'}
                  </button>
                </div>

                <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 font-mono text-xs text-slate-300 overflow-x-auto">
                  {aiderSnippet}
                </pre>
              </div>
            )}

            {/* Cline */}
            {activeTab === 'cline' && (
              <div>
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Cline / Claude Dev / Roo Code</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Configure Cline via the &ldquo;OpenAI Compatible&rdquo; API provider.
                    </p>
                  </div>
                  <button
                    onClick={() => copyToClipboard(clineSnippet, 'cline')}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition"
                  >
                    {copiedKey === 'cline' ? '✓ Copied!' : '📋 Copy JSON'}
                  </button>
                </div>

                <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 font-mono text-xs text-slate-300 overflow-x-auto">
                  {clineSnippet}
                </pre>
              </div>
            )}

            {/* Python / OpenAI SDK */}
            {activeTab === 'python' && (
              <div>
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Python / OpenAI SDK &amp; LiteLLM</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Connect using standard official <code className="text-sky-400">openai</code> library.
                    </p>
                  </div>
                  <button
                    onClick={() => copyToClipboard(pythonSnippet, 'python')}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition"
                  >
                    {copiedKey === 'python' ? '✓ Copied!' : '📋 Copy Code'}
                  </button>
                </div>

                <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 font-mono text-xs text-slate-300 overflow-x-auto">
                  {pythonSnippet}
                </pre>
              </div>
            )}

            {/* Shell / .env */}
            {activeTab === 'env' && (
              <div>
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Shell Environment &amp; .env File</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Export variables in your bash/zsh session or copy into your project&apos;s <code className="text-sky-400">.env</code>.
                    </p>
                  </div>
                  <button
                    onClick={() => copyToClipboard(envSnippet, 'env')}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition"
                  >
                    {copiedKey === 'env' ? '✓ Copied!' : '📋 Copy Environment'}
                  </button>
                </div>

                <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 font-mono text-xs text-slate-300 overflow-x-auto">
                  {envSnippet}
                </pre>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
