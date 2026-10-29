export interface DocSection {
  id: string;
  title: string;
  category: string;
  icon: string;
  badge?: string;
  summary: string;
  content: {
    overview: string;
    subsections: {
      title: string;
      body: string;
      code?: {
        language: string;
        content: string;
      };
      table?: {
        headers: string[];
        rows: string[][];
      };
      note?: string;
    }[];
  };
}

export const DOC_CATEGORIES = [
  'Getting Started',
  'Core Architecture',
  'Agent Ecosystem',
  'Security & Privacy',
  'Integration & API',
  'Hardware & Platform',
] as const;

export const DOC_SECTIONS: DocSection[] = [
  {
    id: 'getting-started',
    title: 'Installation & Setup',
    category: 'Getting Started',
    icon: '🚀',
    summary: 'Install dependencies, configure zero-config auth, manage local TLS certificates, and boot the server with same-port HTTP to HTTPS auto-upgrade on port 3588.',
    content: {
      overview: 'Eluvix is a sovereign, multimodal LLM routing gateway and node studio. It runs on bare metal or inside Docker, bridging local hardware (NVIDIA CUDA or AMD ROCm) and frontier cloud models into a single OpenAI-compatible endpoint.',
      subsections: [
        {
          title: 'Prerequisites',
          body: 'Ensure your environment meets the minimum runtime specifications:',
          table: {
            headers: ['Component', 'Requirement', 'Purpose'],
            rows: [
              ['Node.js', 'v22.13.0+ LTS', 'Required for built-in node:sqlite and ESM modules'],
              ['pnpm', 'v11.0.0+', 'Package manager for workspace monorepo'],
              ['mkcert', 'Recommended', 'Automated issuance of trusted local TLS certificates'],
              ['Docker & Compose', 'v2.20+ (Optional)', 'Containerized local engines (vLLM, Ollama, OpenViking, TrueForge)'],
              ['GPU Drivers', 'NVIDIA CUDA or AMD ROCm', 'Hardware acceleration (optional, CPU fallback supported)'],
            ],
          },
        },
        {
          title: 'Quickstart Commands',
          body: 'Clone the repository and launch the local development gateway:',
          code: {
            language: 'bash',
            content: `# 1. Clone repository
git clone https://github.com/Eluvixrouter/eluvix.git
cd eluvix

# 2. Install monorepo dependencies
pnpm install

# 3. Launch Eluvix gateway (compiles @eluvix/router-core & starts server)
pnpm dev`,
          },
        },
        {
          title: 'Dual-Protocol Same-Port TLS Auto-Upgrade (Port 3588)',
          body: 'Eluvix features an in-kernel TCP byte-sniffing demuxer on port 3588. When clients connect over HTTPS, standard encrypted TLS terminates. When a plaintext HTTP client connects to http://127.0.0.1:3588, the server immediately sniffs the first byte and returns an HTTP/1.1 308 Permanent Redirect to https://127.0.0.1:3588 on the exact same port, eliminating protocol mismatch errors.',
          note: 'An optional secondary redirect listener is also bound to port 3580 for legacy curl scripts and automated health-checkers.',
        },
        {
          title: 'Automatic Credential Generation',
          body: 'Eluvix is zero-config by default. On initial boot, it creates ~/.config/eluvix/auth.json with permissions 0o600 containing an auto-generated admin password and NextAuth session secret. The password is printed directly in the terminal console on startup.',
        },
      ],
    },
  },
  {
    id: 'architecture',
    title: 'Architecture & Pipeline',
    category: 'Core Architecture',
    icon: '🏗️',
    summary: 'Explore the 9-stage execution pipeline from Named Key authentication to memory recall, loop guards, switchyard routing, and egress sanitization.',
    content: {
      overview: 'Eluvix operates as an in-flight proxy and execution pipeline. Every incoming prompt passes through a series of deterministic security, context, routing, and egress stages.',
      subsections: [
        {
          title: 'The 9 Pipeline Stages',
          body: 'The @eluvix/router-core pipeline executes incoming chat completion requests in strict sequence:',
          table: {
            headers: ['Stage', 'Component', 'Function'],
            rows: [
              ['1. Named Key Auth', 'Key Authenticator', 'Validates Bearer token, maps to userId, assigns origin (client vs harness)'],
              ['2. Memory Recall', 'Context Engine', 'Queries OpenViking/Mem0/SQLite and injects <recalled_context> block'],
              ['3. Loop Guard', 'Recursion Firewall', 'Inspects x-eluvix-hops; rejects with 429 if hops >= threshold (default 2)'],
              ['4. Response Cache', 'Semantic Cache', 'Checks in-memory cache for exact or high-similarity query hits (user-scoped)'],
              ['5. Privacy Guard', 'PII Sanitizer', 'Redacts credentials, SSNs, credit cards, emails using token/asterisk/hash'],
              ['6. Semantic Guard', 'Prompt Firewall', 'Classifies jailbreaks, instruction overrides, and system prompt leaks'],
              ['7. Switchyard Router', 'Adaptive Balancer', 'Evaluates token complexity, cost ceilings, and latency SLAs to pick target'],
              ['8. Upstream Dispatch', 'Bifrost Gateway', 'Dispatches request to local engine, cloud provider, or agent harness'],
              ['9. Memory Egress & Commit', 'Egress Guard', 'Applies cloudMode filter/strip; auto-commits session facts to memory DB'],
            ],
          },
        },
        {
          title: 'Workspace Packages',
          body: 'The Eluvix monorepo is structured into 4 cohesive packages:',
          table: {
            headers: ['Package', 'Path', 'Role'],
            rows: [
              ['@eluvix/router-core', 'packages/router-core', 'Headless TypeScript router library, memory engine, harness manager, and guards'],
              ['nextjs', 'apps/nextjs', 'Next.js 14 web console, Visual Editor, Playground, Observability, and /docs'],
              ['githubio', 'apps/githubio', 'Static MDX documentation website export for GitHub Pages'],
              ['desktop', 'apps/desktop', 'Electron desktop shell with native system tray daemon'],
            ],
          },
        },
      ],
    },
  },
  {
    id: 'editor',
    title: 'Visual Node Routing Editor',
    category: 'Core Architecture',
    icon: '🔀',
    summary: 'Design, wire, and compile graph execution topologies with 8 node categories using an ergonomic React Flow canvas.',
    content: {
      overview: 'The Visual Routing Editor (at /editor) provides an interactive canvas where operators visually wire models, security filters, tool servers, agent harnesses, and memory engines into a compiled RouterConfig.',
      subsections: [
        {
          title: 'Canvas Capabilities',
          body: 'The canvas features enlarged snap handles, color-coded SVG wires, dynamic multi-port intent handles (#intent-code, #intent-reasoning, #intent-fast), and in-card controls for immediate property adjustment.',
        },
        {
          title: 'Supported Node Types',
          body: 'The editor includes 13 specialized node categories across pre-routing, routing, execution, and observability:',
          table: {
            headers: ['Node Type', 'Identifier', 'Key Parameters'],
            rows: [
              ['Router', 'switchyardNode', 'Strategy (cost-complexity, lowest-latency, round-robin), spillover ms, max cost cap'],
              ['Task Router', 'taskRouterNode', 'Dynamic intent handles (#intent-code, #intent-reasoning, #intent-fast)'],
              ['Knowledge Base (RAG)', 'knowledgeBaseNode', 'Backend (lightrag, openviking-resources, qdrant, sqlite-fts), collectionUri, topK, retrievalMode'],
              ['Semantic Cache', 'semanticCacheNode', 'Backend (sqlite-fts, qdrant), similarityThreshold, ttlSeconds, hit/miss handles'],
              ['Upstream', 'modelGatewayNode / local / cloud', 'Endpoint URL, API key, model family, context window, priority'],
              ['Privacy Guard', 'privacyGuardNode', 'Redaction style (token, asterisk, hash), entity filters, whitelist'],
              ['Semantic Guard', 'semanticGuardNode', 'Classifier model, sensitivity slider (0.50-0.99), action (block, strip, divert)'],
              ['Agent Harness', 'harnessNode', 'Runtime (trueforge, openhands, mastra, letta, a2a, opencode, acp, hermes), approval policy'],
              ['Execution Sandbox', 'sandboxNode', 'Runtime (docker-exec, opensandbox, e2b), memoryLimitMb, networkPolicy, autoCleanup'],
              ['Consensus / Judge', 'consensusNode', 'Mode (judge, majority-vote, fastest-first), candidateCount, judgeModel, rubric'],
              ['Fallback Chain', 'fallbackChainNode', 'Circuit breaker failureThreshold, cooldownSeconds, hedgeDelayMs, primary/secondary/emergency handles'],
              ['Memory Engine', 'memoryNode', 'Provider (openviking, graphiti, lightrag, cognee, supermemory, mem0, builtin), cloudMode'],
              ['Tools & MCP', 'mcpToolNode / agentGatewayNode', 'Transport (stdio, SSE), access policy, secret discovery mappings'],
            ],
          },
        },
      ],
    },
  },
  {
    id: 'layouts',
    title: 'Topology Presets & Layouts',
    category: 'Core Architecture',
    icon: '🧩',
    summary: 'Load, export, and hot-swap visual routing topologies with file-backed JSON configurations in ~/.config/eluvix/layouts/.',
    content: {
      overview: 'Layouts encapsulate full node graphs, edge wirings, and viewport coordinates. They are stored as clean JSON documents and can be version-controlled, shared, or switched dynamically via the API.',
      subsections: [
        {
          title: 'Official Starter Presets',
          body: 'Eluvix includes pre-compiled starter layouts for common operational topologies:',
          table: {
            headers: ['Preset Name', 'Slug', 'Architecture Focus'],
            rows: [
              ['Single Local Engine', 'single-engine', 'Direct pipeline to local Ollama or vLLM instance with Privacy Guard'],
              ['Local/Cloud Gateway', 'gateway-cascade', 'Adaptive spillover from local GPU to cloud frontier when latency spikes'],
              ['Enterprise Multimodal', 'enterprise-multimodal', 'DeBERTa injection filter, PII hashing, vision routing, and Langfuse tracing'],
              ['OpenViking + TrueForge Mesh', 'openviking-trueforge-agentic', 'OpenViking L0/L1/L2 memory recall feeding Switchyard and TrueForge agent loop'],
              ['Resilient Consensus + RAG Mesh', 'resilient-consensus-rag-mesh', 'Semantic Cache, LightRAG Knowledge Base, Graphiti KG, Fallback Chain, Consensus Judge, and Sandbox'],
            ],
          },
        },
        {
          title: 'File-Backed Storage (~/.config/eluvix/layouts/)',
          body: 'Custom layouts saved in the Visual Editor are persisted as standalone JSON files. A background directory watcher detects manual file edits, enabling Git-based layout synchronization across server clusters.',
        },
      ],
    },
  },
  {
    id: 'switchyard',
    title: 'Switchyard Routing Engine',
    category: 'Core Architecture',
    icon: '⚡',
    summary: 'Cost and complexity router that evaluates prompt difficulty, manages fallback cascades, and enforces budget caps.',
    content: {
      overview: 'Switchyard is the intelligent core of Eluvix. It analyzes incoming queries, grades their technical difficulty, and routes each prompt to the most cost-effective model capable of answering it correctly.',
      subsections: [
        {
          title: 'Complexity Tiers',
          body: 'Switchyard assigns one of four complexity grades based on token length, code syntax detection, and reasoning depth:',
          table: {
            headers: ['Tier', 'Heuristic Signature', 'Selected Engine Target'],
            rows: [
              ['simple', '< 150 tokens, conversational greeting, basic FAQ', 'Local fast model (e.g. llama3.2:1b, qwen2.5:0.5b)'],
              ['moderate', '150-800 tokens, summarization, general text', 'Local workhorse (e.g. llama3.1:8b, mistral:7b)'],
              ['heavy', 'Complex code refactoring, AST transforms, logic', 'Specialized coding engine (e.g. qwen2.5-coder:14b/32b)'],
              ['frontier', 'Multi-step proofs, ambiguous constraints', 'Frontier cloud model (e.g. Claude 3.5 Sonnet, GPT-4o)'],
            ],
          },
        },
        {
          title: 'Circuit Breaker & Fallback Cascades',
          body: 'If an upstream engine experiences a timeout (timeoutMs), connection drop, or latency spike exceeding spilloverThresholdMs, Switchyard instantly reroutes the request down a pre-configured fallback cascade without returning an error to the client.',
        },
      ],
    },
  },
  {
    id: 'harnesses',
    title: 'Agent Harnesses & Runtimes',
    category: 'Agent Ecosystem',
    icon: '🤖',
    badge: 'NEW',
    summary: 'Orchestrate stateful multi-turn agent loops with TrueForge, OpenHands, Mastra, Letta, A2A, opencode, ACP, and Hermes, protected by the Loop Guard firewall.',
    content: {
      overview: 'Traditional LLM routers are purely reactive. Eluvix integrates 8 Agent Harnesses—runtimes that manage autonomous execution loops, tool calling, human-in-the-loop approvals, and sub-agent spawning.',
      subsections: [
        {
          title: 'Supported Agent Harnesses',
          body: 'Eluvix provides native protocol adapters for 8 self-hosted and federated agent runtimes:',
          table: {
            headers: ['Harness Kind', 'Default Port', 'Protocol & Primary Use Case'],
            rows: [
              ['trueforge', ':8790', 'Turn-based SSE runtime with human-in-the-loop tool approval policies'],
              ['openhands', ':3000', 'Autonomous SWE / CodeAct engineering agent with isolated workspace conversations'],
              ['mastra', ':4111', 'TypeScript-native workflow & agent server (/api/agents/{id}/generate)'],
              ['letta', ':8283', 'MemGPT stateful agent server with persistent self-editing core & archival memory'],
              ['a2a', ':8900', 'Linux Foundation / Google Agent2Agent JSON-RPC 2.0 federated peer delegation'],
              ['opencode', ':4096', 'Terminal-first autonomous coding server with session message streaming'],
              ['acp', 'stdio', 'Agent Client Protocol JSON-RPC 2.0 over stdio (e.g. Goose, Zed agents)'],
              ['hermes', ':8642', 'Lightweight OpenAI-compatible multi-step tool loop'],
            ],
          },
        },
        {
          title: 'TrueForge Integration',
          body: 'TrueForge is an open-source tool-calling agent runtime. Eluvix communicates with TrueForge via REST sessions (POST /api/v1/sessions) and streams multi-step turn executions (POST /api/v1/sessions/{id}/turns) over Server-Sent Events (SSE).',
          code: {
            language: 'bash',
            content: `# Launch TrueForge or OpenHands container selectively via modular compose
docker compose up -d trueforge openhands

# TrueForge runs on port 8790:
# POST http://127.0.0.1:8790/api/v1/sessions
# POST http://127.0.0.1:8790/api/v1/sessions/{id}/turns`,
          },
        },
        {
          title: 'Headless Tool Approval Policies',
          body: 'When agents propose side-effecting operations (file modifications, bash execution, network requests), TrueForge suspends the turn until an approval event is dispatched (POST /turns/{id}/events). Eluvix supports 3 automated policies:',
          table: {
            headers: ['Policy', 'Behavior', 'Ideal Use Case'],
            rows: [
              ['auto-approve-readonly (Default)', 'Permits read-only tools (grep, cat, git status); pauses on write/exec', 'Standard developer desktop and semi-automated coding workflows'],
              ['auto-deny', 'Immediately denies any tool requiring elevated approval', 'Zero-trust unattended CI/CD pipelines'],
              ['surface', 'Forwards approval request over SSE to web console for human operator click', 'Interactive visual debugging in the Eluvix dashboard'],
            ],
          },
        },
        {
          title: 'Agent Client Protocol (ACP) & opencode',
          body: 'Eluvix supports opencode (autonomous coding agent server on port 4096) and the Agent Client Protocol (ACP), a standardized JSON-RPC 2.0 stdio protocol created by Zed and Anthropic for bidirectional editor-to-agent communication.',
        },
        {
          title: 'Infinite Loop Guard & Hop Limiter (x-eluvix-hops)',
          body: 'When autonomous agents call tools that query gateways, recursive routing loops can burn millions of tokens in minutes. Eluvix tags harness requests with origin: "harness" and increments x-eluvix-hops. If hops >= threshold (default 2), Eluvix rejects the request with HTTP 429 Loop Detected and code agent_recursion_limit_exceeded.',
          code: {
            language: 'json',
            content: `// Rejection payload when agent recursion threshold is reached:
{
  "error": {
    "message": "Potential agent routing loop detected: hop count (2) exceeds maximum allowed threshold (2).",
    "type": "loop_detected_error",
    "code": "agent_recursion_limit_exceeded"
  }
}`,
          },
        },
      ],
    },
  },
  {
    id: 'memory',
    title: 'Memory & Context Engine',
    category: 'Agent Ecosystem',
    icon: '🧠',
    badge: 'NEW',
    summary: 'Long-term episodic context recall, temporal knowledge graphs, and hybrid RAG with OpenViking, Graphiti, LightRAG, Cognee, Supermemory, Mem0, and SQLite.',
    content: {
      overview: 'Eluvix features an automated two-phase memory lifecycle: pre-routing recall (injecting relevant user context and static corpus RAG before the prompt hits the model) and post-routing session commits (persisting facts and temporal episodes).',
      subsections: [
        {
          title: 'Supported Memory & Graph Providers',
          body: 'Switch seamlessly between 7 pluggable memory backends in the Memory Node or RouterConfig:',
          table: {
            headers: ['Provider', 'Default Endpoint', 'Architecture & Strengths'],
            rows: [
              ['openviking', 'http://localhost:1933', 'Hierarchical L0/L1/L2 context database with viking:// semantic URIs'],
              ['graphiti', 'http://localhost:8003', 'Bi-temporal knowledge graph tracking time-stamped episodes and evolving facts'],
              ['lightrag', 'http://localhost:9621', 'Dual-level entity/relation graph + vector RAG for technical documentation'],
              ['cognee', 'http://localhost:8004', 'Extract-Cognify-Load (ECL) graph pipeline turning unstructured docs into graphs'],
              ['supermemory', 'https://api.supermemory.ai', 'Low-latency hosted or self-hosted universal memory API'],
              ['mem0', 'http://localhost:8888', 'Fact-extraction and user personalization vector memory'],
              ['builtin', 'Embedded SQLite FTS5', 'Zero-dependency local BM25 full-text memory store (~/.config/eluvix)'],
            ],
          },
        },
        {
          title: 'OpenViking Hierarchical Memory (Volcengine / ByteDance)',
          body: 'OpenViking represents context hierarchically across three tiers: L0 (ultra-compact semantic pointers, 10-30 tokens), L1 (structural outlines and categorized summaries, 50-150 tokens), and L2 (raw textual content, code references, and quotes). Memories are addressed via semantic URIs: viking://user/{userId}/memories.',
          code: {
            language: 'bash',
            content: `# Spin up OpenViking context database
docker compose --profile memory up -d

# OpenViking listens on port 1933:
# POST http://127.0.0.1:1933/api/v1/search/find
# POST http://127.0.0.1:1933/api/v1/sessions/{id}/commit`,
          },
        },
        {
          title: 'Built-in Embedded SQLite Memory',
          body: 'For zero-dependency local deployments without extra Docker containers, Eluvix includes an embedded SQLite memory engine stored in ~/.config/eluvix/memory.db with token-overlap, phrase matching, and user isolation.',
        },
        {
          title: 'Memory Egress Guard (Privacy Firewall)',
          body: 'Stored user memories often contain proprietary code snippets or private user preferences. Eluvix protects against sovereign memory leakage when routing to 3rd-party cloud providers:',
          table: {
            headers: ['Cloud Mode', 'Action on Cloud Dispatch', 'Guarantee'],
            rows: [
              ['filter (Default)', 'Deep-inspects recalled blocks and scrubs credentials/PII before cloud forwarding', 'Preserves relevant non-sensitive context while stripping secrets'],
              ['strip', 'Completely removes the <recalled_context> block before dispatching to cloud providers', 'Strict zero-leakage guarantee; memory is strictly reserved for local sovereign models'],
            ],
          },
        },
        {
          title: 'Memory REST API (/api/v1/memory)',
          body: 'Manage memories programmatically with search, add, commit, and clear operations:',
          code: {
            language: 'bash',
            content: `# Search user memory
curl -k "https://127.0.0.1:3588/api/v1/memory?userId=alice&query=react%20state&limit=5" \\
  -H "Authorization: Bearer <ADMIN_PASSWORD>"

# Add a preference
curl -k -X POST https://127.0.0.1:3588/api/v1/memory \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <ADMIN_PASSWORD>" \\
  -d '{"action": "add", "userId": "alice", "text": "Always use Tailwind CSS for styling"}'`,
          },
        },
      ],
    },
  },
  {
    id: 'security',
    title: 'Security & Privacy Guards',
    category: 'Security & Privacy',
    icon: '🛡️',
    summary: 'Real-time in-flight PII redaction, prompt injection firewall (DeBERTa/BGE), secret redaction, and named key scoping.',
    content: {
      overview: 'Eluvix operates as a sovereign security perimeter between client applications and AI models, intercepting data leaks, adversarial attacks, and credential exposure.',
      subsections: [
        {
          title: 'Privacy Guard Formatting Styles',
          body: 'The Privacy Guard scrubs sensitive entities using three customizable formatting styles:',
          table: {
            headers: ['Style', 'Transformation Example', 'Preserved Properties'],
            rows: [
              ['token (Default)', '[REDACTED_API_KEY], [REDACTED_SSN]', 'Preserves semantic entity references for model reasoning'],
              ['asterisk', 'sk-••••••••, •••-••-1234', 'Preserves prefixes/suffixes for human readability'],
              ['hash', '[HASH:e3b0c44298fc...]', 'Deterministic SHA-256 digest allows cross-turn entity resolution without exposing PII'],
            ],
          },
        },
        {
          title: 'Semantic Guard (Adversarial Firewall)',
          body: 'Using transformer classifiers (DeBERTa-v3, BGE-Small), Semantic Guard inspects incoming prompts for instruction overrides, DAN jailbreak personas, system prompt exfiltration probes, and obfuscated Base64 attacks. Actions include block (400 Bad Request), strip, divert (honeypot), or warn.',
        },
        {
          title: 'Named API Keys (keys.json)',
          body: 'Configure fine-grained named keys in ~/.config/eluvix/keys.json with dedicated userId scoping, origin tagging (client vs harness), rate limits, and model whitelisting.',
        },
      ],
    },
  },
  {
    id: 'multimodal',
    title: 'Multimodal Vision Routing',
    category: 'Core Architecture',
    icon: '👁️',
    summary: 'Inspect prompt image attachments, calculate visual token overhead, and route seamlessly to vision-capable local and cloud models.',
    content: {
      overview: 'Eluvix natively detects multimodal message structures (OpenAI image_url blocks and raw Base64 data). It bypasses text-only models and routes visual queries to vision-specialized local or cloud backends.',
      subsections: [
        {
          title: 'Image Extraction & Token Overhead',
          body: 'When a request contains image inputs, Eluvix automatically parses high-detail vs low-detail dimensions, calculates the estimated vision token budget, and directs the query through the #intent-vision port.',
        },
        {
          title: 'Supported Vision Engines',
          body: 'Supported local vision engines include Ollama (llava, llama3.2-vision), vLLM (Qwen2-VL, Pixtral), and cloud providers (GPT-4o, Claude 3.5 Sonnet).',
        },
      ],
    },
  },
  {
    id: 'tools',
    title: 'Native Tools & MCP Gateway',
    category: 'Integration & API',
    icon: '🔧',
    summary: 'Integrate Model Context Protocol (MCP) servers, execute sandboxed native tools, and securely discover credentials via OpenBao.',
    content: {
      overview: 'Eluvix bridges LLMs to real-world software through the Model Context Protocol (MCP) and built-in server-side native tools.',
      subsections: [
        {
          title: 'Built-in Native Tools',
          body: 'Eluvix includes built-in native tools exposed via /api/v1/tools: a safe AST math calculator (no eval()) and a web scraper with SSRF protection preventing access to private RFC 1918 subnets and localhost.',
        },
        {
          title: 'Agent Gateway & MCP Security',
          body: 'The Agent Gateway acts as an MCP firewall: it enforces access policies (restrictive, permissive, open), filters tools by whitelist or blacklist, and sanitizes tool return outputs before feeding data back to the LLM.',
        },
        {
          title: 'Secrets Discovery (OpenBao / HashiCorp Vault)',
          body: 'The /api/secrets/discover endpoint queries OpenBao or Vault to dynamically resolve credentials and inject them into MCP subprocess environments without storing secrets in plain text.',
        },
      ],
    },
  },
  {
    id: 'playground',
    title: 'Trace Playground & Datasets',
    category: 'Hardware & Platform',
    icon: '🧪',
    summary: 'Interactive prompt testing workbench with live latency traces, token counters, memory simulation, and dataset benchmarks.',
    content: {
      overview: 'The Trace Playground (at /playground) lets developers test model responses, inspect routing decisions, and evaluate memory recall live without external API clients.',
      subsections: [
        {
          title: 'Workbench Features',
          body: 'The Playground provides real-time streaming token counters, latency percentiles, system prompt injections, memory recall simulation (inspecting what <recalled_context> would be fetched), and exportable session logs.',
        },
      ],
    },
  },
  {
    id: 'api',
    title: 'OpenAI-Compatible API Reference',
    category: 'Integration & API',
    icon: '🔌',
    summary: 'Complete REST endpoint specifications for chat completions, models, memory, layouts, docker, and custom response headers.',
    content: {
      overview: 'Eluvix provides a drop-in replacement for OpenAI client libraries, plus sovereign endpoints for memory, topologies, and hardware orchestration.',
      subsections: [
        {
          title: 'Endpoint Overview',
          body: 'Core REST endpoints exposed under /api/v1:',
          table: {
            headers: ['Path', 'Method', 'Description'],
            rows: [
              ['/api/v1/chat/completions', 'POST', 'OpenAI-compatible streaming SSE and non-streaming chat completions'],
              ['/api/v1/models', 'GET', 'Lists all active local and cloud models with capability tags'],
              ['/api/v1/memory', 'GET / POST', 'Search, add, commit, or clear user memory records'],
              ['/api/v1/layouts', 'GET / POST', 'Read and save visual routing canvas topologies'],
              ['/api/v1/docker/status', 'GET', 'Health check, CPU/VRAM usage for backend containers'],
              ['/api/v1/docker/up', 'POST', 'Launch local container services via Docker Compose'],
              ['/api/v1/provider/status', 'GET', 'GPU worker daemon serving status and earnings'],
            ],
          },
        },
        {
          title: 'Custom Response Headers',
          body: 'Every chat completion includes diagnostic headers detailing execution metadata:',
          table: {
            headers: ['Header', 'Value Description'],
            rows: [
              ['X-Eluvix-Selected-Upstream', 'ID of the upstream engine that executed the request (e.g. ollama-local, openai-cloud)'],
              ['X-Eluvix-Complexity-Tier', 'Complexity grade assigned by Switchyard (simple, moderate, heavy, frontier)'],
              ['X-Eluvix-Cache', 'HIT if returned from semantic cache; MISS if routed upstream'],
              ['X-Eluvix-Memory', 'Active context memory provider (openviking, mem0, sqlite, none)'],
              ['X-Eluvix-Memory-Tokens', 'Count of recalled context tokens prepended to system instructions'],
              ['X-Eluvix-Harness', 'Agent harness identifier if routed to agent loop (trueforge, opencode, acp)'],
              ['X-Eluvix-Hops', 'Current hop count returned by Loop Guard'],
            ],
          },
        },
        {
          title: 'cURL Example',
          body: 'Execute a chat completion with model: "auto":',
          code: {
            language: 'bash',
            content: `curl -k -X POST https://127.0.0.1:3588/api/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <ADMIN_PASSWORD_OR_NAMED_KEY>" \\
  -d '{
    "model": "auto",
    "messages": [
      { "role": "system", "content": "You are a software architect." },
      { "role": "user", "content": "Explain raft consensus in 3 bullet points." }
    ],
    "temperature": 0.3
  }'`,
          },
        },
      ],
    },
  },
  {
    id: 'local-engines',
    title: 'Local Engines & Hardware Acceleration',
    category: 'Hardware & Platform',
    icon: '🖥️',
    summary: 'Hardware profiles for NVIDIA CUDA, AMD ROCm, and CPU inference, with Docker Compose overlays and detection scripts.',
    content: {
      overview: 'Eluvix orchestrates on-premises hardware across NVIDIA CUDA, AMD ROCm, and CPU inference engines with automatic capability tagging.',
      subsections: [
        {
          title: 'Hardware Profiles & Modular Docker Compose',
          body: 'Eluvix provides a split pick-and-choose compose architecture in docker/compose/ allowing individual subsystems to be launched independently:',
          table: {
            headers: ['Subsystem', 'Compose Command', 'Description'],
            rows: [
              ['Core Gateway & UI', 'docker compose -f docker/compose/core.yml up -d', 'Gateway router, Next.js UI, SQLite telemetry on port 3588'],
              ['Inference Pool (vLLM / SGLang)', 'docker compose -f docker/compose/core.yml -f docker/compose/inference.yml up -d', 'High-throughput local vLLM (:8000), SGLang (:30000), and Ollama (:11434)'],
              ['SWE Harnesses', 'docker compose -f docker/compose/core.yml -f docker/compose/harnesses.yml up -d', 'TrueForge (:8790) and OpenHands (:3000) coding agent environments'],
              ['Memory & Knowledge RAG', 'docker compose -f docker/compose/core.yml -f docker/compose/memory.yml up -d', 'Graphiti temporal graphs (:8000), LightRAG (:9621), OpenViking (:1933)'],
              ['Full Mesh Stack', 'docker compose -f docker/compose/core.yml -f docker/compose/inference.yml -f docker/compose/harnesses.yml -f docker/compose/memory.yml up -d', 'Complete production deployment running all engines, harnesses, and memory databases'],
            ],
          },
        },
        {
          title: 'Automated Detection Script',
          body: 'Run the included hardware detection utility to automatically inspect your GPU and apply the correct compose profile:',
          code: {
            language: 'bash',
            content: `chmod +x scripts/docker-detect-and-spinup.sh
./scripts/docker-detect-and-spinup.sh`,
          },
        },
      ],
    },
  },
  {
    id: 'cloud-providers',
    title: 'Cloud Providers & Agent CLI',
    category: 'Integration & API',
    icon: '☁️',
    summary: 'Direct integrations with OpenAI, Anthropic, Billama Cloud, Google Antigravity (agy), and Claude Code CLI.',
    content: {
      overview: 'Eluvix connects seamlessly to public cloud foundation models and terminal coding agents as resilient upstreams.',
      subsections: [
        {
          title: 'Supported Cloud Providers',
          body: 'Eluvix connects to OpenAI Direct (GPT-4o, o1, o3-mini), Anthropic Direct (Claude 3.5 Sonnet / Haiku), and Billama Cloud.',
        },
        {
          title: 'Antigravity Agent CLI (agy)',
          body: 'Eluvix provides a native upstream adapter for the Google Antigravity CLI (agy), enabling sub-agent dispatching and local shell coding tasks right through the OpenAI chat completion API.',
        },
      ],
    },
  },
  {
    id: 'configurator',
    title: 'Client Configurator',
    category: 'Integration & API',
    icon: '⚙️',
    summary: 'One-click integration guides and configuration presets for Cursor, Continue, Cline, OpenHands, and OpenAI SDKs.',
    content: {
      overview: 'Use the Client Configurator (at /configurator) to generate pre-formatted configuration files and environment snippets for your favorite AI developer tools.',
      subsections: [
        {
          title: 'Supported Client Targets',
          body: 'Eluvix exports validated configuration blocks for:',
          table: {
            headers: ['Client', 'Config Location', 'Integration Type'],
            rows: [
              ['Cursor', 'Settings > Models > OpenAI API', 'Base URL: https://127.0.0.1:3588/api/v1'],
              ['Continue.dev', '~/.continue/config.json', 'OpenAI-compatible provider block'],
              ['Cline / Roo-Code', 'VSCode Settings > Cline', 'Custom OpenAI Endpoint'],
              ['OpenHands', 'config.toml', 'LLM base_url configuration'],
              ['Python OpenAI SDK', 'os.environ["OPENAI_BASE_URL"]', 'export OPENAI_BASE_URL="https://127.0.0.1:3588/api/v1"'],
            ],
          },
        },
      ],
    },
  },
  {
    id: 'provider',
    title: 'Sell GPU Time (Compute Provider)',
    category: 'Hardware & Platform',
    icon: '⚡',
    summary: 'Monetize idle GPU compute by serving inference requests on the Billama decentralized network.',
    content: {
      overview: 'Transform your workstation or server rack into an earning compute node when your hardware is idle.',
      subsections: [
        {
          title: 'Worker Node Configuration',
          body: 'In the Provider Portal (/provider), configure your worker authorization token, floor pricing per 1K tokens, and thermal ceiling limits. When your local machine is not in active use, the background daemon processes encrypted inference jobs from the network.',
        },
      ],
    },
  },
  {
    id: 'observability',
    title: 'Observability & Activity',
    category: 'Hardware & Platform',
    icon: '📊',
    summary: 'Monitor token throughput, latency percentiles, cost savings, and stream traces to SQLite, OpenTelemetry, or Langfuse.',
    content: {
      overview: 'Inspect real-time metrics, audit logs, and cost efficiency in the Observability Dashboard (/observability).',
      subsections: [
        {
          title: 'Key Metrics Tracked',
          body: 'The dashboard computes real-time statistics including total requests, average response latency (ms), token consumption by model tier, semantic cache hit ratios, and estimated cost savings from routing simple prompts to free local hardware instead of frontier cloud models.',
        },
        {
          title: 'Telemetry Exporters',
          body: 'Export telemetry data to industry-standard monitoring systems:',
          table: {
            headers: ['Exporter', 'Protocol', 'Target'],
            rows: [
              ['Embedded SQLite', 'Native node:sqlite', 'Local persistent audit file (~/.config/eluvix/telemetry.db)'],
              ['OpenTelemetry', 'OTLP/gRPC', 'Compatible with Datadog, Jaeger, Grafana Tempo'],
              ['Langfuse', 'HTTP REST', 'Prompt tracing and LLM lifecycle evaluation'],
              ['Prometheus', 'HTTP /metrics', 'Scraped metrics for alerting and Kubernetes dashboards'],
            ],
          },
        },
      ],
    },
  },
  {
    id: 'desktop',
    title: 'Desktop Application',
    category: 'Hardware & Platform',
    icon: '💻',
    summary: 'Electron shell wrapper with native system tray daemon, GPU monitoring, and background gateway control.',
    content: {
      overview: 'The desktop edition of Eluvix (in apps/desktop) packages the entire server and dashboard into a native cross-platform application for Linux, macOS, and Windows.',
      subsections: [
        {
          title: 'Native Features',
          body: 'The desktop app includes a native system tray icon with quick actions (Start/Stop Gateway, Toggle Provider, Copy OpenAI API Env), GPU VRAM temperature gauges, and automated OS boot launch.',
        },
      ],
    },
  },
  {
    id: 'disaggregated-serving',
    title: 'Disaggregated Serving & RDMA Fabrics',
    category: 'Hardware & Platform',
    icon: '🌐',
    badge: 'RDMA / RoCEv2',
    summary: 'Disaggregate compute-bound Prefill and memory-bound Decode across RoCEv2/InfiniBand fabrics using vLLM NIXL and SGLang Mooncake connectors.',
    content: {
      overview: 'Modern LLM inference exhibits two fundamentally distinct operational regimes: the prompt Prefill phase is compute-bound (operating at thousands of FLOPs/Byte), while the auto-regressive Decode phase is memory-bandwidth bound (operating at 16–32 FLOPs/Byte). In traditional colocated serving, long prompts saturate Tensor Cores and stall interactive token generation for all concurrent users (the "time-to-first-token bubble"). Eluvix disaggregates Prefill and Decode onto dedicated hardware nodes interconnected by ultra-low-latency GPUDirect RDMA / RoCEv2 fabrics.',
      subsections: [
        {
          title: 'The Roofline Model: Compute-Bound vs. Memory-Bound',
          body: 'On an NVIDIA H100 SXM5 GPU (989.4 TFLOPS dense FP8, 3.35 TB/s HBM3), the Roofline operational ridge point occurs at 295.3 FLOPs/Byte. During Decode, memory arithmetic intensity is restricted by loading model weights once per token generated (~16–32 FLOPs/Byte), severely underutilizing Tensor Cores. During Prefill with prompt lengths >1,024 tokens, arithmetic intensity surges above 2,048 FLOPs/Byte, fully saturating the compute pipeline. Separating these phases prevents batch-stragglers and TTFT head-of-line blocking.',
          table: {
            headers: ['Phase', 'Bottleneck', 'Arithmetic Intensity', 'Optimal Node Topology'],
            rows: [
              ['Prefill (Prompt Processing)', 'Compute (Tensor Cores)', '>2,048 FLOPs/Byte', 'High Tensor Parallelism (TP4/TP8), FP8 Matrix Units'],
              ['Decode (Token Generation)', 'Memory Bandwidth (HBM)', '16–32 FLOPs/Byte', 'High Pipeline Parallelism (PP) or Tensor Parallelism (TP2/TP4), Low Batch Size'],
            ],
          },
        },
        {
          title: 'KV-Cache Footprints: GQA vs. DeepSeek MLA',
          body: 'To enable seamless KV-cache transfer from Prefill to Decode workers, KV footprint must be minimized. Standard Grouped-Query Attention (GQA-8, e.g. Llama-3.3-70B) requires 160 KiB/token in FP8 (320 KiB in BF16). DeepSeek Multi-Head Latent Attention (MLA) uses low-rank latent compression (512-dim latent + 64-dim decoupled RoPE), shrinking the KV cache to 34.3 KiB/token (4.66x smaller), dramatically accelerating wire transfer across RDMA links.',
          table: {
            headers: ['Architecture', 'KV Dimension / Token', 'FP8 Cache Size (4k tokens)', 'Wire Transfer Time (400GbE)'],
            rows: [
              ['Llama-3.3-70B (GQA-8)', '163,840 bytes/tok', '625.0 MB', '12.5 ms'],
              ['DeepSeek-V3 / R1 (MLA)', '35,136 bytes/tok', '134.0 MB', '2.68 ms'],
              ['Llama-3.1-8B (GQA-8)', '65,536 bytes/tok', '250.0 MB', '5.0 ms'],
            ],
          },
        },
        {
          title: 'Pipelined KV-Transfer with vLLM NIXL and SGLang Mooncake',
          body: 'Rather than waiting for the entire prompt prefill to complete before initiating network transmission, Eluvix leverages layer-by-layer GPUDirect RDMA pipelining. As each transformer layer finishes computation on the Prefill node, its KV tensors are immediately written over RDMA into the target Decode node GPU memory. This overlaps 96%–98% of the transfer time with compute, exposing less than 1–2ms of network overhead to the client.',
          code: {
            language: 'bash',
            content: `# Launch vLLM Prefill Node with NIXL Connector
vllm serve meta-llama/Llama-3.3-70B-Instruct \
  --kv-transfer-config '{"kv_connector":"NixlConnector","kv_role":"kv_producer","kv_buffer_device":"mlx5_0"}' \
  --tensor-parallel-size 4 --port 8000

# Launch vLLM Decode Node with NIXL Connector
vllm serve meta-llama/Llama-3.3-70B-Instruct \
  --kv-transfer-config '{"kv_connector":"NixlConnector","kv_role":"kv_consumer","kv_buffer_device":"mlx5_0"}' \
  --tensor-parallel-size 4 --port 8001`,
          },
        },
        {
          title: 'Switchyard Prefill-Isolation & Prefix Affinity',
          body: 'Switchyard automatically detects request token volume: prompts exceeding prefillIsolationThresholdTokens (default 1,024) are steered to dedicated Prefill nodes or disaggregated clusters. Prompts sharing common system prefixes are hashed (SHA-256) and routed with affinity to the specific worker retaining the warm KV cache in GPU memory, maximizing RadixAttention and chunked prefill hit rates.',
          note: 'Prefix affinity entries are held in an in-memory LRU cache with a 30-minute time-to-live (TTL).',
        },
        {
          title: 'TTFT vs. ITL Telemetry and Goodput SLAs',
          body: 'Traditional gateways measure only end-to-end request duration. Eluvix instruments Server-Sent Events (SSE) streaming chunks to isolate Time to First Token (TTFT, prefill phase) from Inter-Token Latency (ITL, decode phase). Every response emits x-eluvix-ttft-ms, x-eluvix-itl-ms, and x-eluvix-kv-cache-kb headers, allowing observability dashboards to track SLA Goodput (percentage of requests meeting both TTFT and ITL SLOs).',
        },
      ],
    },
  },
  {
    id: 'confidential-computing-tee',
    title: 'Zero-Trust Confidential Silicon (TEE)',
    category: 'Security & Privacy',
    icon: '🔐',
    badge: 'SEV-SNP / TDX / H100 CC',
    summary: 'Hardware-enforced CPU & GPU Trusted Execution Environments (AMD SEV-SNP, Intel TDX, NVIDIA H100 CC-On & Blackwell B200 TEE-I/O) with IETF RATS Dual-Attestation.',
    content: {
      overview: 'Eluvix integrates hardware-rooted Confidential Computing across CPU Trusted Execution Environments (AMD SEV-SNP and Intel TDX) and GPU Trusted Execution Environments (NVIDIA Hopper H100 CC-On/PPCIE and Blackwell B200 TEE-I/O). This removes the host hypervisor (KVM/QEMU), cloud provider root administrator, and physical PCIe bus from the Trusted Computing Base (TCB), protecting both proprietary 70B+ model weights and sensitive user prompts in flight and in memory.',
      subsections: [
        {
          title: 'Silicon Threat Mitigations: RMP, S-EPT, Restricted Injection & GSP Firewall',
          body: 'Standard memory encryption (such as first-gen AMD SEV-ES) encrypts DRAM against physical cold-boot attacks but leaves guest page tables and interrupt vectors exposed to a malicious hypervisor. Eluvix verifies four critical silicon primitives before routing confidential traffic:',
          table: {
            headers: ['Attack Vector', 'Hypervisor / Hardware Exploit', 'Silicon Defense Verified by Eluvix'],
            rows: [
              ['Physical DRAM Snoop', 'Host /dev/mem dump or DDR5 bus interposer', 'AES-128/256 inline memory engines (AMD ASP / Intel MKTME) + 28-bit SHA-3 ECC MACs'],
              ['NPT / EPT Page Remapping', 'Hypervisor maps two GPAs to same SPA or replays ciphertext pages', 'AMD Reverse Map Table (RMP) + PVALIDATE / Intel Secure EPT (S-EPT) inside CPU SEAM'],
              ['#VC / #VE Interrupt Injection', 'WeSee / Ahoi attacks inject forged #VC (vector 29) or #VE (vector 20) to leak CPU registers', 'AMD Restricted Injection (#HV, vector 28) / Intel SEPT_VE_DISABLE'],
              ['Host BAR1 GPU VRAM Snooping', 'Host root reads model weights or KV cache via PCIe BAR0/BAR1', 'NVIDIA GSP MMU hardware firewall locks BAR0/BAR1 (returns 0xFFFFFFFF to host) + SPDM AES-GCM-256 DMA'],
            ],
          },
        },
        {
          title: 'Hopper H100 (SWIOTLB Bounce Buffers) vs. Blackwell B200 (TEE-I/O Inline IDE)',
          body: 'In NVIDIA Hopper H100 CC-On mode, every Host-to-Device (H2D) PCIe transfer must pass through a guest Software I/O Translation Lookaside Buffer (SWIOTLB), where the CPU and GPU Copy Engine (CE) encrypt/decrypt DMA payloads using AES-GCM-256 (~8.64 GB/s effective bandwidth, ~8.1s cold load for 70GB weights, -5.5% single-GPU decode overhead). NVIDIA Blackwell B200 TEE-I/O eliminates bounce buffers using hardware PCIe Gen6 Integrity & Data Encryption (IDE), TDISP, and inline encrypted 5th-Gen NVLink (1.8 TB/s), achieving 24.2 GB/s H2D bandwidth (2.9s cold load), -1.1% single-GPU overhead, and 98.6% 8-GPU AllReduce efficiency.',
          table: {
            headers: ['Architecture', 'PCIe DMA Encryption', 'Effective H2D BW', '70GB Cold Weight Load', 'Single-GPU Decode', '8x GPU AllReduce'],
            rows: [
              ['AMD SEV-SNP + H100 (CC-On)', 'SWIOTLB Bounce + CE AES-GCM-256', '8.64 GB/s', '8.1 s', '121.4 tok/s (-5.5%)', '81.4% efficiency'],
              ['Intel TDX + B200 (TEE-I/O)', 'PCIe Gen6 IDE + TDISP + Inline NVLink', '24.20 GB/s', '2.9 s', '127.1 tok/s (-1.1%)', '98.6% efficiency'],
            ],
          },
        },
        {
          title: 'IETF RATS Dual-Attestation & Encrypted RAM Weight Unsealing',
          body: 'Before releasing the 256-bit AES-GCM Model Weight Decryption Key (DEK) from the Trustee Key Broker Service (KBS), the enclave executes a dual-attestation handshake. It binds a fresh KBS nonce and ephemeral public key into the 512-bit CPU REPORT_DATA field (SHA512(nonce || ephemeral_pubkey)) at VMPL 0, collects the ECDSA P-384 signed SPDM 1.2 GPU measurement report, and verifies both against AMD VCEK / Intel PCS and NVIDIA Reference Integrity Manifests (RIM). Once verified, model weights are unsealed directly into an encrypted RAM-backed tmpfs mount (/mnt/enclave-weights) so plaintext weights never touch host disk.',
          code: {
            language: 'bash',
            content: `# Enforce fail-closed Dual-Attestation on a chat completion request
curl https://127.0.0.1:3588/api/v1/chat/completions \\
  -H "Authorization: Bearer $ELUVIX_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "x-eluvix-confidential: require-dual-attestation" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Process confidential genomic sequence..."}]
  }'`,
          },
          note: 'When confidentialPolicy is set to require-tee or require-dual-attestation, Eluvix fails closed with HTTP 503 (confidential_enclave_unavailable) if no hardware-attested enclave upstream is healthy.',
        },
      ],
    },
  },
  {
    id: 'nvfp4-microscaling-quantization',
    title: 'Sub-4-Bit Microscaling (NVFP4 / MXFP4 & Hadamard)',
    category: 'Orchestration & Routing',
    icon: '🧮',
    badge: 'NVFP4 / MXFP4 / QuaRot',
    summary: 'Lossless W4A4 LLM inference using OCP MXFP4, NVIDIA Blackwell NVFP4 (E2M1) two-level microscaling, and Walsh-Hadamard outlier rotation (QuaRot / SpinQuant / SVDQuant).',
    content: {
      overview: 'When dropping from 8-bit (FP8 E4M3) to 4-bit (W4A4) Tensor Core execution, standard integer quantization (INT4-AWQ / GPTQ) hits a severe accuracy wall on reasoning models due to Emergent Activation Outliers (50x-100x channel spikes after SiLU_and_Mul preceding down_proj). Eluvix integrates hardware-accelerated OCP MXFP4 and NVIDIA Blackwell NVFP4 (E2M1) microscaling paired with orthogonal Walsh-Hadamard outlier rotation (QuaRot / SpinQuant) and Quantization-Aware Switchyard routing.',
      subsections: [
        {
          title: 'OCP MXFP4 vs. NVIDIA Blackwell NVFP4 (E2M1) Two-Level Microscaling',
          body: 'Both OCP MXFP4 and NVIDIA NVFP4 standardize on E2M1 (1 sign bit, 2 exponent bits, 1 mantissa bit, bias b=1), wasting zero bit patterns on Inf/NaN so all 16 bit patterns represent exact magnitudes (±0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0). Standard OCP MXFP4 shares an 8-bit power-of-2 E8M0 scale across 32 elements (4.25 bits/weight), which suffers from a "sawtooth" quantization error whenever a block maximum slightly exceeds 6.0 * 2^k. NVIDIA Blackwell NVFP4 solves this with a 16-element micro-block, a fractional FP8 E4M3 Level-1 scale (3 mantissa bits), and a per-tensor FP32 Level-2 global scale (4.50 bits/weight), cutting quantization MSE by ~2.4x inside the SM100 tcgen05.mma.kind::mxf4nvf4 instruction (20 PFLOPS dense).',
          table: {
            headers: ['Specification', 'INT4-AWQ (W4A16)', 'OCP MXFP4 (Standard)', 'NVIDIA NVFP4 (Blackwell SM100)'],
            rows: [
              ['Element Format', '4-bit Signed Int ([-8..7])', 'E2M1 (1s, 2e, 1m)', 'E2M1 (1s, 2e, 1m)'],
              ['Micro-Block Size (k)', '128 elements', '32 elements', '16 elements'],
              ['Level-1 Block Scale', 'FP16 (16-bit)', 'E8M0 (8-bit power-of-2)', 'FP8 E4M3 (8-bit fractional)'],
              ['Level-2 Global Scale', 'None', 'None', 'Per-Tensor FP32 (S_tensor)'],
              ['Effective Bits / Weight', '4.125 bits', '4.25 bits', '4.50 bits (39.4 GB for 70B)'],
              ['Hardware PTX Instruction', 'Dequantizes to FP16', 'tcgen05.mma.kind::mxf4', 'tcgen05.mma.kind::mxf4nvf4 (20 PFLOPS)'],
            ],
          },
        },
        {
          title: 'Walsh-Hadamard Outlier Rotation (R1..R4) & SVDQuant',
          body: 'By exploiting orthogonal invariance (Y = X * W^T = (X * Q)(W * Q)^T where Q * Q^T = I), QuaRot and SpinQuant apply Fast Walsh-Hadamard Transforms (FWHT) across four strategic transformer boundaries: R1 (offline residual stream rotation via RMSNorm invariance), R2 (offline per-head Value/Output H_128 folding), R3 (online post-RoPE Query/Key rotation for 4-bit KV cache), and R4 (online fused O(d log2 d) FWHT in the SiLU_and_Mul epilogue before down_proj). Across d=8,192 channels, a 120.0 outlier spike is damped by sqrt(8192) ≈ 90.5x in <8 microseconds, recovering 99.6% of BF16 MATH-500 reasoning accuracy at 3.42x throughput.',
          table: {
            headers: ['Precision Format (Llama-3.3-70B)', 'Weight RAM', 'MMLU-Pro', 'MATH-500 (Reasoning)', 'LiveCodeBench', 'Relative Throughput'],
            rows: [
              ['BF16 (Baseline)', '140.0 GB (TP=2+)', '68.9%', '76.4%', '54.2%', '1.00x'],
              ['FP8 (W8A8 E4M3)', '70.0 GB', '68.7%', '76.1%', '54.0%', '1.85x'],
              ['Weight-Only INT4-AWQ (W4A16)', '36.2 GB', '67.1%', '71.2% (-5.2%)', '50.8%', '2.10x (BW Only)'],
              ['Naive OCP MXFP4 (No Rotation)', '37.2 GB', '66.4%', '68.9% (-7.5%)', '49.1%', '3.35x'],
              ['NVIDIA NVFP4 + Hadamard (W4A4)', '39.4 GB (Single GPU TP=1)', '68.6%', '76.1% (99.6% Rec)', '53.9%', '3.42x (Compute + BW)'],
            ],
          },
        },
        {
          title: 'Quantization-Aware Switchyard Routing & Telemetry Headers',
          body: 'When Switchyard is configured with quantizationPolicy: "lossless-reasoning" (or per-request via the x-eluvix-quantization header), Eluvix blocks naive/unrotated 4-bit upstreams (INT4-AWQ, INT4-GPTQ, or unrotated MXFP4) from serving complex reasoning and coding prompts, routing exclusively to NVFP4+Hadamard, FP8 E4M3, or BF16 workers.',
          code: {
            language: 'bash',
            content: `# Route a math/reasoning prompt with lossless quantization enforcement
curl https://127.0.0.1:3588/api/v1/chat/completions \\
  -H "Authorization: Bearer $ELUVIX_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "x-eluvix-quantization: lossless-reasoning" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Prove that every orthogonal Walsh-Hadamard matrix preserves the L2 norm..."}]
  }'`,
          },
          note: 'Responses from quantized upstreams include x-eluvix-quantization-format, x-eluvix-outlier-rotation, and x-eluvix-tensor-core-ptx telemetry headers.',
        },
      ],
    },
  },
  {
    id: 'clos-fabric-bgp-evpn-srv6-dlb',
    title: 'Rail-Optimized Clos Fabrics (BGP EVPN, SRv6 uSID & DLB)',
    category: 'Orchestration & Routing',
    icon: '🕸️',
    badge: '400G/800G RoCEv2',
    summary: 'Eliminate ECMP hash polarization (44.6% utilization) under NCCL AllReduce & MoE AllToAll using 8-Rail Clos + NCCL PxN, RFC 8950 BGP Unnumbered, SRv6 uSID, and Switch DLB with ConnectX-7/8 OOO-DDP.',
    content: {
      overview: 'Standard cloud Leaf-Spine (Clos) networks using static 5-tuple ECMP hashing buckle under AI GPU collective traffic because synchronized 400G/800G RoCEv2 Queue Pairs ("elephant flows") collide on Spine uplinks in 99.76% of iterations (K=8, M=8). Eluvix models and orchestrates Rail-Optimized Plane-Separated Clos topologies, NCCL PxN intra-node NVSwitch proxying, RFC 8950 BGP Unnumbered + EVPN underlays, 128-bit SRv6 Micro-SID (uSID) deterministic Spine pinning, and Switch Dynamic Load Balancing (DLB) with ConnectX-7/8 Out-of-Order Direct Data Placement (OOO-DDP).',
      subsections: [
        {
          title: 'Balls-into-Bins ECMP Hash Polarization vs. 8-Rail Clos + NCCL PxN',
          body: 'When M = 8 GPU NICs inject synchronized line-rate RoCEv2 flows into a Leaf switch with K = 8 Spine uplinks under static 5-tuple ECMP, the zero-collision probability is P(zero collision) = 8! / 8^8 ≈ 0.24% (a 99.76% collision rate) and E[Idle Uplinks] = (7/8)^8 ≈ 34.36%, collapsing effective AllReduce bus bandwidth to 44.6%. A Rail-Optimized topology wires NIC i of every node into Rail i Leaf Switch so same-rank AllReduce completes in a single ~380ns cut-through hop without touching the Spine, while NCCL PxN (NCCL_PXN_DISABLE=0) proxies cross-rail traffic over the intra-node 900 GB/s NVSwitch domain before entering the target Rail Leaf.',
          table: {
            headers: ['Network Fabric Architecture (256x H100, 400GbE)', 'AllReduce BusBW', 'AllToAll (MoE) BusBW', 'Effective Link Util', 'PFC Pause Storms / Step'],
            rows: [
              ['Standard ToR + Static 5-Tuple ECMP (1 QP)', '214 GB/s', '168 GB/s', '44.6%', 'Frequent (Tail stalls)'],
              ['Rail-Optimized Clos + PxN + Static ECMP (4 QPs)', '458 GB/s', '312 GB/s', '82.1%', 'Rare (Only cross-pod AllToAll)'],
              ['Rail-Optimized + SRv6 uSID Explicit Spine Pinning', '466 GB/s', '438 GB/s', '94.8%', '0 (Zero Collisions)'],
              ['Rail-Optimized + DLB Packet Spraying (OOO-DDP)', '469 GB/s', '452 GB/s', '97.8% (Line Rate!)', '0 (Zero Collisions)'],
            ],
          },
        },
        {
          title: '128-Bit SRv6 Micro-SIDs (uSID, RFC 8986) & Switch DLB + ConnectX-7/8 OOO-DDP',
          body: 'To steer cross-pod traffic deterministically without a 40+ byte SRH extension header, SRv6 uSID packs six 16-bit micro-instructions directly into the 128-bit IPv6 Destination Address (e.g., fcbb:bb00:0202:0104:0040:: for Block fcbb:bb00 -> Spine 0202 -> Egress Leaf 0104 -> VRF DT4 0040). The Spine ASIC executes an 8-nanosecond 16-bit left shift (End.uN). For dynamic Mixture-of-Experts (MoE) AllToAll bursts, Tomahawk 5 / Spectrum-4 Dynamic Load Balancing (DLB) sprays individual packets across all spines while ConnectX-7/8 SuperNICs perform hardware Out-of-Order Direct Data Placement (OOO-DDP, OO_RECV_WR_EN=1) via an on-NIC sliding PSN bitmap window directly into GPU HBM3e.',
          code: {
            language: 'bash',
            content: `# Route a distributed MoE / long-context request requiring a collision-free Rail-Optimized fabric
curl https://127.0.0.1:3588/api/v1/chat/completions \\
  -H "Authorization: Bearer $ELUVIX_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "x-eluvix-fabric: require-collision-free-fabric" \\
  -d '{
    "model": "deepseek-ai/DeepSeek-V3",
    "messages": [{"role": "user", "content": "Analyze cross-pod AllToAll MoE dispatch latency..."}]
  }'`,
          },
          note: 'Responses from fabric-configured upstreams emit x-eluvix-fabric-topology, x-eluvix-rdma-transport, and x-eluvix-srv6-usid-carrier telemetry headers.',
        },
      ],
    },
  },
];
