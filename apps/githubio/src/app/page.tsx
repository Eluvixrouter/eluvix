import Link from 'next/link';
import Image from 'next/image';
import { DataFlowDiagram, CostComparisonWidget } from '@/components/SovereignVisuals';

export default function Home() {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
  return (
    <div className="flex flex-col items-center overflow-hidden">
      
      {/* 1. Hero Section with Glow & Visual Graphics */}
      <section className="w-full relative py-20 md:py-32 lg:py-36 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-slate-950 flex flex-col items-center border-b border-slate-800/80">
        {/* Ambient background light streaks */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[350px] bg-gradient-to-r from-sky-500/15 via-indigo-500/10 to-teal-500/10 blur-[130px] pointer-events-none rounded-full" />
        
        <div className="container px-4 md:px-6 text-center relative z-10">
          
          {/* Top Pill Badge */}
          <Link href="/docs/releases" className="inline-flex items-center gap-2 rounded-full bg-sky-500/10 px-4 py-1.5 text-xs font-bold text-sky-400 border border-sky-500/30 mb-8 shadow-[0_0_20px_rgba(56,189,248,0.2)] hover:bg-sky-500/20 transition-colors">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Sovereign AI Routing &amp; Privacy Shield • v1.0.14 Release Notes ➔</span>
          </Link>

          {/* Punchy Hero Headline */}
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-black tracking-tight text-white max-w-5xl mx-auto leading-[1.1] mb-6">
            Defend Your Privacy.<br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-teal-300 to-indigo-400">
              Crush Your Cloud Bills.
            </span>
          </h1>

          {/* Subtitle with exciting value props */}
          <p className="mx-auto max-w-3xl text-slate-300 text-base sm:text-lg md:text-xl leading-relaxed mb-10">
            Big Tech treats your private prompts, proprietary code, and trade secrets as free training data while charging premium token tolls. <strong className="text-white font-semibold">Eluvix</strong> is the sovereign routing gateway that sanitizes PII in-flight, routes 85%+ of workloads to your <strong className="text-emerald-400 font-semibold">$0 local GPU</strong>, and only escalates to cloud frontier models when deep reasoning truly demands it.
          </p>          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-16">
            <Link 
              href="/app" 
              className="inline-flex h-13 items-center justify-center rounded-xl bg-sky-500 px-8 text-sm font-bold text-slate-950 shadow-[0_0_30px_rgba(56,189,248,0.4)] transition-all hover:bg-sky-400 hover:scale-105 active:scale-95"
            >
              ⚡ Launch Live App Demo ➔
            </Link>
            <Link 
              href="/docs/getting-started" 
              className="inline-flex h-13 items-center justify-center rounded-xl border border-slate-700 bg-slate-900/80 px-7 text-sm font-bold text-slate-200 shadow-sm transition-all hover:bg-slate-800 hover:border-slate-600"
            >
              Quickstart &amp; Install
            </Link>
            <Link 
              href="/docs/provider" 
              className="inline-flex h-13 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-950/20 px-6 text-sm font-bold text-emerald-400 shadow-sm transition-all hover:bg-emerald-900/30"
            >
              ⛏️ Monetize GPU
            </Link>
          </div>

          {/* Hero Cyberpunk 3D Graphics Banner Card */}
          <div className="max-w-5xl mx-auto rounded-2xl p-2 bg-gradient-to-b from-sky-500/30 via-slate-800/50 to-slate-900/50 border border-sky-500/30 shadow-[0_0_50px_rgba(56,189,248,0.2)] relative group overflow-hidden">
            <div className="relative rounded-xl overflow-hidden bg-slate-950 aspect-[16/9] w-full">
              <Image 
                src={`${basePath}/hero-banner.jpg`} 
                alt="Eluvix Cybernetic AI Routing Core & Privacy Shield" 
                fill
                priority
                className="object-cover transition-transform duration-700 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/30 to-transparent" />
              
              {/* Floating Overlay HUD Badges */}
              <div className="absolute top-4 left-4 flex flex-wrap gap-2">
                <Link href="/app" className="flex items-center gap-2 px-3 py-1 rounded-md bg-slate-950/90 backdrop-blur border border-sky-500/40 text-xs font-mono text-sky-400 hover:border-sky-300 transition">
                  <span className="w-2 h-2 rounded-full bg-sky-400 animate-ping" />
                  GATEWAY: 127.0.0.1:3588 (Open Demo ➔)
                </Link>
                <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-md bg-slate-950/80 backdrop-blur border border-emerald-500/30 text-xs font-mono text-emerald-400">
                  <span>SILICON: RTX 4090 ($0/tok)</span>
                </div>
              </div>

              <div className="absolute bottom-4 left-4 right-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 p-3 rounded-lg bg-slate-950/90 backdrop-blur border border-slate-800 text-xs">
                <div className="flex items-center gap-3">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    🛡️ Privacy Shield Active
                  </span>
                  <span className="text-slate-400 font-mono hidden md:inline">
                    Masking: Token + SHA-256 Hash
                  </span>
                </div>
                <div className="flex items-center gap-4 text-slate-300 font-mono">
                  <span>Latency: <strong className="text-emerald-400">0.2ms</strong></span>
                  <span>Cloud Fallback: <strong className="text-sky-400">Standby</strong></span>
                  <span>Spend Saved: <strong className="text-emerald-400">88.4%</strong></span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* 2. Interactive Live Architectural Data Flow */}
      <section className="w-full py-20 bg-slate-950 flex justify-center">
        <div className="container px-4 md:px-6 max-w-6xl">
          <DataFlowDiagram />
        </div>
      </section>

      {/* 3. Deep Dive: Guarding the Individual User (Sovereignty & Privacy) */}
      <section className="w-full py-24 bg-gradient-to-b from-slate-950 via-slate-900/60 to-slate-950 border-t border-b border-slate-800/80 flex justify-center relative">
        <div className="container px-4 md:px-6 max-w-6xl">
          
          <div className="flex flex-col lg:flex-row items-center gap-12">
            
            {/* Visual Graphic on Left */}
            <div className="w-full lg:w-1/2 relative">
              <div className="relative rounded-2xl overflow-hidden border border-sky-500/30 shadow-[0_0_40px_rgba(56,189,248,0.2)] bg-slate-950 aspect-[16/9]">
                <Image 
                  src={`${basePath}/privacy-shield.jpg`} 
                  alt="Eluvix Hardware Privacy Vault Shielding GPU from External Surveillance" 
                  fill
                  className="object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent" />
                <div className="absolute bottom-4 left-4 right-4">
                  <div className="text-xs font-mono font-bold text-sky-400 uppercase tracking-widest mb-1">
                    SOVEREIGN ENCLAVE DEFENSE
                  </div>
                  <div className="text-sm font-semibold text-white">
                    External Surveillance Intrusion Intercepted &amp; Neutralized
                  </div>
                </div>
              </div>
            </div>

            {/* Exciting Copy on Right */}
            <div className="w-full lg:w-1/2 space-y-6">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-bold border border-emerald-500/20">
                🛡️ Sovereign User Protection
              </div>
              <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight leading-tight">
                Your Silicon. Your Privacy.<br />
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-sky-400">
                  Zero Data Leaks to Cloud Monopolies.
                </span>
              </h2>
              <p className="text-slate-300 text-base leading-relaxed">
                When you query cloud AI APIs directly, your trade secrets, source code, and private records are shipped across the public internet to third-party data centers where terms of service can shift overnight.
              </p>
              
              <div className="space-y-4 pt-2">
                <div className="flex gap-4 items-start">
                  <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 shrink-0 font-bold">
                    ✓
                  </div>
                  <div>
                    <h4 className="text-white font-bold text-sm">Automated In-Flight PII Redaction</h4>
                    <p className="text-xs text-slate-400 mt-1">
                      API keys, credit cards, SSNs, and emails are instantaneously tokenized (`[REDACTED_API_KEY]`) or hashed with cryptographic SHA-256 before leaving your machine.
                    </p>
                  </div>
                </div>

                <div className="flex gap-4 items-start">
                  <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 shrink-0 font-bold">
                    ✓
                  </div>
                  <div>
                    <h4 className="text-white font-bold text-sm">Transformer-Grade Prompt Injection Firewall</h4>
                    <p className="text-xs text-slate-400 mt-1">
                      DeBERTa-v3 and embedding classifiers actively block adversarial instruction overrides, jailbreak personas, and system prompt leakage attempts.
                    </p>
                  </div>
                </div>

                <div className="flex gap-4 items-start">
                  <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 shrink-0 font-bold">
                    ✓
                  </div>
                  <div>
                    <h4 className="text-white font-bold text-sm">100% Local Airgapped Operation</h4>
                    <p className="text-xs text-slate-400 mt-1">
                      Keep 100% of your data on-prem. Run completely offline without internet connectivity using local Ollama, vLLM, or Lemonade enclaves.
                    </p>
                  </div>
                </div>
              </div>
            </div>

          </div>

        </div>
      </section>

      {/* 4. Deep Dive: Crushing Cloud Costs (Saving Money) */}
      <section className="w-full py-24 bg-slate-950 flex justify-center">
        <div className="container px-4 md:px-6 max-w-6xl space-y-12">
          
          <div className="text-center max-w-3xl mx-auto">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-bold border border-emerald-500/20 mb-4">
              💰 Financial Autonomy
            </div>
            <h2 className="text-3xl sm:text-5xl font-black text-white tracking-tight mb-4">
              Slash Your AI Spend by up to <span className="text-emerald-400">88%</span>.
            </h2>
            <p className="text-slate-400 text-base sm:text-lg">
              Stop burning expensive cloud tokens on simple code refactors, formatting queries, and chat banter. Eluvix pays for itself on day one.
            </p>
          </div>

          <CostComparisonWidget />

          {/* Three Cost Pillars */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-6">
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
              <div className="text-2xl mb-3">⚖️</div>
              <h4 className="text-lg font-bold text-white mb-2">Cost-Complexity Matrix</h4>
              <p className="text-xs text-slate-400 leading-relaxed">
                Dynamically grades incoming prompts. Routes 80-90% of simple tasks to local hardware ($0.00/token) and only spends cloud credits when high reasoning depth is required.
              </p>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
              <div className="text-2xl mb-3">🛑</div>
              <h4 className="text-lg font-bold text-white mb-2">Hard Financial Budget Caps</h4>
              <p className="text-xs text-slate-400 leading-relaxed">
                Set a strict `maxCostPerRequest` ceiling (e.g. $0.05). If an autonomous agent loop spins out of control, Eluvix automatically cuts off runaway API billing.
              </p>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
              <div className="text-2xl mb-3">⛏️</div>
              <h4 className="text-lg font-bold text-white mb-2">GPU Worker Monetization</h4>
              <p className="text-xs text-slate-400 leading-relaxed">
                Turn your workstation into a revenue generator. When you step away, Provider Mode rents your idle GPU to the decentralized Billama Network with thermal protection.
              </p>
            </div>
          </div>

        </div>
      </section>

      {/* 5. Comprehensive 8-Card Feature Grid */}
      <section className="w-full py-24 bg-gradient-to-b from-slate-950 via-slate-900/30 to-slate-950 border-t border-slate-800/80 flex justify-center">
        <div className="container px-4 md:px-6 max-w-6xl">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <h2 className="text-3xl font-extrabold text-white tracking-tight mb-4">
              Engineered for Sovereignty &amp; Speed
            </h2>
            <p className="text-slate-400 text-sm">
              Everything you need to orchestrate local GPUs, terminal agents, and enterprise cloud fallbacks in one unified stack.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            
            <div className="flex flex-col gap-2 rounded-xl border border-slate-800/80 bg-slate-900/50 p-6 shadow-xl hover:border-sky-500/40 transition-colors">
              <div className="text-3xl mb-2">⚖️</div>
              <h3 className="text-base font-bold text-white">Cost-Complexity</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Grades prompts by token count, code blocks, and reasoning difficulty to choose the most cost-effective tier.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800/80 bg-slate-900/50 p-6 shadow-xl hover:border-sky-500/40 transition-colors">
              <div className="text-3xl mb-2">👁️</div>
              <h3 className="text-base font-bold text-white">Multimodal Vision</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Detects base64 or URL image payloads and dynamically filters the upstream mesh strictly for vision-capable models.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800/80 bg-slate-900/50 p-6 shadow-xl hover:border-sky-500/40 transition-colors">
              <div className="text-3xl mb-2">⚡</div>
              <h3 className="text-base font-bold text-white">Latency Spillover</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Monitors SQLite logs for latency spikes (&gt;3,000ms) and gracefully spills traffic over to secondary tiers without dropping requests.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800/80 bg-slate-900/50 p-6 shadow-xl hover:border-sky-500/40 transition-colors">
              <div className="text-3xl mb-2">🛡️</div>
              <h3 className="text-base font-bold text-white">Privacy Guard</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Masks API keys, SSNs, credit cards, emails, and IPs using tokens, bullets, or deterministic SHA-256 hashes.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800/80 bg-slate-900/50 p-6 shadow-xl hover:border-sky-500/40 transition-colors">
              <div className="text-3xl mb-2">🧰</div>
              <h3 className="text-base font-bold text-white">Native Tools &amp; MCP</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Drag-and-drop tool wiring via React Flow. Connects external MCP servers and provides native Calculator &amp; WebScraper.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800/80 bg-slate-900/50 p-6 shadow-xl hover:border-sky-500/40 transition-colors">
              <div className="text-3xl mb-2">📊</div>
              <h3 className="text-base font-bold text-white">JSONL Export</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Chat histories from the Trace Playground are persisted in SQLite and can be exported as ready-to-train fine-tuning datasets.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800/80 bg-slate-900/50 p-6 shadow-xl hover:border-sky-500/40 transition-colors">
              <div className="text-3xl mb-2">📐</div>
              <h3 className="text-base font-bold text-white">18 Topology Presets</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Pre-configured architectures for airgapped clusters, Rail-Optimized SRv6/DLB fabrics, NVFP4 Hadamard W4A4, SEV-SNP/TDX enclaves, and RDMA disaggregation.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-slate-800/80 bg-slate-900/50 p-6 shadow-xl hover:border-sky-500/40 transition-colors">
              <div className="text-3xl mb-2">⛏️</div>
              <h3 className="text-base font-bold text-white">GPU Worker Mode</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Monetize idle GPU workstations by serving distributed Billama workloads with automated benchmarking and thermal safety.
              </p>
            </div>

          </div>
        </div>
      </section>

      {/* 6. Ready to Route CTA */}
      <section className="w-full py-24 bg-slate-900 border-t border-slate-800 flex justify-center text-center relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-sky-500/10 via-transparent to-transparent pointer-events-none" />
        
        <div className="container px-4 relative z-10 max-w-3xl">
          <h2 className="text-3xl sm:text-4xl font-extrabold text-white mb-4">
            Take Control of Your AI Infrastructure
          </h2>
          <p className="text-slate-300 text-sm sm:text-base mb-8">
            Deploy Eluvix in under 60 seconds with Docker or run directly with pnpm. Zero external database required.
          </p>
          
          <pre className="inline-block bg-slate-950 border border-slate-800 rounded-xl p-4 text-left text-xs sm:text-sm font-mono text-sky-400 mb-8 max-w-xl overflow-x-auto w-full shadow-2xl">
            <code>
              docker compose -f docker-compose.prod.yml up -d --build
            </code>
          </pre>

          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <Link 
              href="/docs/getting-started" 
              className="inline-flex h-12 items-center justify-center rounded-xl bg-sky-500 px-8 text-sm font-bold text-slate-950 shadow-[0_0_25px_rgba(56,189,248,0.3)] transition-all hover:bg-sky-400"
            >
              Read Quickstart Guide ➔
            </Link>
            <Link 
              href="/docs/api" 
              className="inline-flex h-12 items-center justify-center rounded-xl border border-slate-700 bg-slate-950 px-8 text-sm font-bold text-slate-300 transition-colors hover:bg-slate-800"
            >
              View API Documentation
            </Link>
          </div>
        </div>
      </section>

    </div>
  );
}
