import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';
import { THEME_INIT_SCRIPT } from '@/lib/themes';

export const metadata: Metadata = {
  title: 'Eluvix | Sovereign AI Routing & Privacy Shield',
  description: 'Guarding individual privacy and crushing cloud AI bills. The intelligent multimodal LLM routing gateway for local hardware and cloud fallbacks.',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/icon.svg',
  }
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark scroll-smooth" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body className="antialiased min-h-screen flex flex-col font-sans selection:bg-sky-500/30">
        
        {/* Navigation Bar */}
        <header className="sticky top-0 z-50 w-full border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md">
          <div className="container mx-auto flex h-16 items-center justify-between px-4 md:px-6">
            <Link href="/" className="transition-opacity hover:opacity-90">
              <Logo size="md" />
            </Link>

            <nav className="hidden md:flex items-center gap-5 text-sm font-medium text-slate-300">
              <Link href="/app" className="text-sky-400 font-bold hover:text-sky-300 transition-colors flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-500/10 border border-sky-500/20 shadow-sm">
                <span>⚡</span> Live App Demo
              </Link>
              <Link href="/docs/getting-started" className="hover:text-sky-400 transition-colors">Documentation</Link>
              <Link href="/docs/architecture" className="hover:text-sky-400 transition-colors">Architecture</Link>
              <Link href="/docs/clos-fabric" className="hover:text-sky-400 transition-colors">Clos Fabrics</Link>
              <Link href="/docs/quantization" className="hover:text-sky-400 transition-colors">NVFP4</Link>
              <Link href="/docs/releases" className="text-emerald-400 hover:text-emerald-300 transition-colors font-semibold">Release Notes</Link>
            </nav>

            <div className="flex items-center gap-2 sm:gap-3">
              {/* Visual Theme Palette Switcher */}
              <ThemeSwitcher />

              <a
                href="https://github.com/Eluvixrouter/eluvix"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                  <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                </svg>
                <span className="hidden sm:inline">GitHub</span>
              </a>

              <Link
                href="/docs/getting-started"
                className="hidden sm:inline-flex items-center justify-center rounded-lg bg-sky-500 hover:bg-sky-400 px-3.5 py-1.5 text-xs font-bold text-slate-950 shadow-[0_0_15px_rgba(56,189,248,0.3)] transition-all"
              >
                Get Started
              </Link>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1">
          {children}
        </main>

        {/* Comprehensive Multi-Column Footer */}
        <footer className="border-t border-slate-800/80 bg-slate-950 pt-16 pb-12">
          <div className="container mx-auto px-4 md:px-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-10 mb-12">
              
              {/* Brand Statement */}
              <div className="md:col-span-1 space-y-4">
                <Logo size="md" />
                <p className="text-xs text-slate-400 leading-relaxed">
                  The intelligent, privacy-first AI routing gateway. Defends the individual user against predatory cloud token costs and intrusive data harvesting.
                </p>
                <div className="flex items-center gap-2 pt-2">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    Sovereign Local-First
                  </span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-sky-500/10 text-sky-400 border border-sky-500/20">
                    MIT Licensed
                  </span>
                </div>
              </div>

              {/* Column 2: Documentation */}
              <div>
                <h4 className="text-xs font-bold text-slate-100 uppercase tracking-wider mb-4">Documentation</h4>
                <ul className="space-y-2 text-xs text-slate-400">
                  <li><Link href="/docs/releases" className="text-emerald-400 hover:text-emerald-300 transition-colors font-semibold">Release Notes (v1.0.14)</Link></li>
                  <li><Link href="/docs/getting-started" className="hover:text-sky-400 transition-colors">Quickstart &amp; Setup</Link></li>
                  <li><Link href="/docs/architecture" className="hover:text-sky-400 transition-colors">Architecture Deep Dive</Link></li>
                  <li><Link href="/docs/switchyard" className="hover:text-sky-400 transition-colors">Switchyard Engine</Link></li>
                  <li><Link href="/docs/harnesses" className="hover:text-sky-400 transition-colors">Agent Harnesses &amp; Runtimes</Link></li>
                  <li><Link href="/docs/memory" className="hover:text-sky-400 transition-colors">Memory &amp; Context Engine</Link></li>
                </ul>
              </div>

              {/* Column 3: Sovereign Security */}
              <div>
                <h4 className="text-xs font-bold text-slate-100 uppercase tracking-wider mb-4">Sovereign Protection</h4>
                <ul className="space-y-2 text-xs text-slate-400">
                  <li><Link href="/docs/confidential-computing" className="hover:text-sky-400 transition-colors">Confidential Silicon (SEV-SNP / TDX)</Link></li>
                  <li><Link href="/docs/security" className="hover:text-sky-400 transition-colors">Privacy Guard (PII Masking)</Link></li>
                  <li><Link href="/docs/security" className="hover:text-sky-400 transition-colors">Semantic Threat Firewall</Link></li>
                  <li><Link href="/docs/layouts" className="hover:text-sky-400 transition-colors">18 Topology Presets</Link></li>
                  <li><Link href="/docs/observability" className="hover:text-sky-400 transition-colors">Local SQLite Telemetry</Link></li>
                </ul>
              </div>

              {/* Column 4: Silicon & Cluster Scale */}
              <div>
                <h4 className="text-xs font-bold text-slate-100 uppercase tracking-wider mb-4">Silicon &amp; Cluster Scale</h4>
                <ul className="space-y-2 text-xs text-slate-400">
                  <li><Link href="/docs/clos-fabric" className="hover:text-sky-400 transition-colors">Rail-Optimized Clos &amp; SRv6 uSID</Link></li>
                  <li><Link href="/docs/quantization" className="hover:text-sky-400 transition-colors">Blackwell NVFP4 &amp; Hadamard W4A4</Link></li>
                  <li><Link href="/docs/disaggregated-serving" className="hover:text-sky-400 transition-colors">Disaggregated RDMA P/D Serving</Link></li>
                  <li><Link href="/docs/provider" className="hover:text-sky-400 transition-colors">GPU Compute Provider &amp; Labs</Link></li>
                  <li><Link href="/docs/desktop" className="hover:text-sky-400 transition-colors">Desktop App (Electron)</Link></li>
                </ul>
              </div>

            </div>

            {/* Bottom bar */}
            <div className="border-t border-slate-900 pt-8 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-4">
              <p>© {new Date().getFullYear()} Eluvix Project. Built for user sovereignty, privacy, and local-first AI.</p>
              <div className="flex items-center gap-4">
                <a href="https://eluvix.com" className="hover:text-slate-400 transition-colors">eluvix.com</a>
                <span>•</span>
                <a href="https://github.com/Eluvixrouter/eluvix" target="_blank" rel="noreferrer" className="hover:text-slate-400 transition-colors">GitHub Repository</a>
              </div>
            </div>
          </div>
        </footer>

      </body>
    </html>
  );
}
