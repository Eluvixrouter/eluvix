import Link from 'next/link';

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="container mx-auto flex flex-col md:flex-row px-4 md:px-6 py-8 gap-10">
      
      {/* Sidebar */}
      <aside className="w-full md:w-64 shrink-0">
        <div className="sticky top-24 space-y-6">
          
          <div>
            <h3 className="font-bold text-slate-100 mb-3 uppercase tracking-wider text-xs">Getting Started</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/docs/getting-started" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Installation & Setup
                </Link>
              </li>
              <li>
                <Link href="/docs/architecture" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Architecture & Core
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="font-bold text-slate-100 mb-3 uppercase tracking-wider text-xs">Core Concepts</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/docs/editor" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Visual Routing Editor
                </Link>
              </li>
              <li>
                <Link href="/docs/layouts" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Topology Presets &amp; Layouts
                </Link>
              </li>
              <li>
                <Link href="/docs/switchyard" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Switchyard Routing Engine
                </Link>
              </li>
              <li>
                <Link href="/docs/security" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Security &amp; Privacy Guards
                </Link>
              </li>
              <li>
                <Link href="/docs/multimodal" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Multimodal (Vision) Routing
                </Link>
              </li>
              <li>
                <Link href="/docs/tools" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Native Tools &amp; MCP
                </Link>
              </li>
              <li>
                <Link href="/docs/playground" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Trace Playground &amp; Datasets
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="font-bold text-slate-100 mb-3 uppercase tracking-wider text-xs">Integration & Deployment</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/docs/api" className="text-slate-400 hover:text-sky-400 transition-colors">
                  OpenAI Compatible API
                </Link>
              </li>
              <li>
                <Link href="/docs/local-engines" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Local Engines &amp; Docker
                </Link>
              </li>
              <li>
                <Link href="/docs/cloud-providers" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Cloud Providers &amp; Agents
                </Link>
              </li>
              <li>
                <Link href="/docs/configurator" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Client Configurator
                </Link>
              </li>
              <li>
                <Link href="/docs/provider" className="text-slate-400 hover:text-sky-400 transition-colors">
                  GPU Compute Provider
                </Link>
              </li>
              <li>
                <Link href="/docs/observability" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Observability &amp; Activity
                </Link>
              </li>
              <li>
                <Link href="/docs/desktop" className="text-slate-400 hover:text-sky-400 transition-colors">
                  Desktop Application
                </Link>
              </li>
            </ul>
          </div>

        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0">
        <article className="prose prose-invert prose-slate max-w-none">
          {children}
        </article>
      </div>

    </div>
  );
}
