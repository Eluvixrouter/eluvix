import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex flex-col items-center">
      
      {/* Hero Section */}
      <section className="w-full py-24 md:py-32 lg:py-40 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-slate-950 flex justify-center">
        <div className="container px-4 md:px-6 text-center">
          <div className="inline-block rounded-lg bg-sky-500/10 px-3 py-1 text-sm font-semibold text-sky-400 border border-sky-500/20 mb-6">
            v1.0.0 Now Available
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tighter text-white max-w-4xl mx-auto leading-tight mb-6">
            Intelligent AI Routing for the <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 to-indigo-500">Local-First</span> Era.
          </h1>
          <p className="mx-auto max-w-[700px] text-slate-400 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed mb-10">
            Eluvix unifies local hardware (vLLM, Ollama) and cloud fallbacks into a single resilient endpoint. Features cost-complexity routing, multimodal vision filtering, and integrated privacy guardrails.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link 
              href="/docs/getting-started" 
              className="inline-flex h-12 items-center justify-center rounded-md bg-sky-500 px-8 text-sm font-medium text-slate-950 shadow transition-colors hover:bg-sky-400 focus-visible:outline-none"
            >
              Get Started
            </Link>
            <Link 
              href="/docs/architecture" 
              className="inline-flex h-12 items-center justify-center rounded-md border border-slate-700 bg-slate-900 px-8 text-sm font-medium text-slate-300 shadow-sm transition-colors hover:bg-slate-800 focus-visible:outline-none"
            >
              Read the Docs
            </Link>
          </div>
        </div>
      </section>

      {/* Feature Grid */}
      <section className="w-full py-20 bg-slate-950 flex justify-center">
        <div className="container px-4 md:px-6">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
            
            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl">
              <div className="text-3xl mb-2">⚖️</div>
              <h3 className="text-xl font-bold text-white">Cost-Complexity Routing</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Dynamically grades incoming prompts. Routes simple queries to cheap local GPUs, and escalates deep-reasoning tasks to frontier cloud models.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl">
              <div className="text-3xl mb-2">👁️</div>
              <h3 className="text-xl font-bold text-white">Multimodal Vision</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Automatically detects OpenAI-style image payloads in requests and filters your upstream mesh to strictly target Vision-capable nodes.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl">
              <div className="text-3xl mb-2">⚡</div>
              <h3 className="text-xl font-bold text-white">Latency Spillover</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Monitors SQLite logs for latency spikes. If a local node lags (&gt;3000ms), Eluvix gracefully falls back to the next tier without dropping the request.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl">
              <div className="text-3xl mb-2">🛡️</div>
              <h3 className="text-xl font-bold text-white">Privacy & Semantic Guards</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Intercepts requests to strip PII (SSNs, API keys, IPs) and heuristically blocks prompt injections before they ever hit the LLM.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl">
              <div className="text-3xl mb-2">🧰</div>
              <h3 className="text-xl font-bold text-white">Native Tools & MCP</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Drag-and-drop tool wiring via the UI. Supports the open Model Context Protocol (MCP) and bundles native tools (WebScraper, Calculator) out of the box.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl">
              <div className="text-3xl mb-2">📊</div>
              <h3 className="text-xl font-bold text-white">JSONL Export</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Chat histories from the integrated Trace Playground are persisted in SQLite and can be exported as ready-to-train OpenAI JSONL datasets.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl">
              <div className="text-3xl mb-2">📐</div>
              <h3 className="text-xl font-bold text-white">12 Topology Presets</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Pre-configured architectures for airgapped enclaves, agentic coding with Google Antigravity AGY, edge low-latency chat, and tiered cost cascade.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl">
              <div className="text-3xl mb-2">⛏️</div>
              <h3 className="text-xl font-bold text-white">GPU Worker Mode</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Monetize idle GPU workstations by serving distributed Billama workloads with automated benchmarking, thermal guards, and user-activity pausing.
              </p>
            </div>

          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="w-full py-20 bg-slate-900 border-t border-slate-800 flex justify-center text-center">
        <div className="container px-4">
          <h2 className="text-3xl font-bold text-white mb-6">Ready to route?</h2>
          <pre className="inline-block bg-slate-950 border border-slate-800 rounded-lg p-4 text-left text-sm font-mono text-sky-400 mb-8 max-w-xl overflow-x-auto w-full shadow-2xl">
            <code>
              docker compose -f docker-compose.prod.yml up -d --build
            </code>
          </pre>
          <div>
            <Link 
              href="/docs/getting-started" 
              className="text-sky-400 hover:text-sky-300 font-semibold text-lg"
            >
              Read the installation guide ➔
            </Link>
          </div>
        </div>
      </section>

    </div>
  );
}
