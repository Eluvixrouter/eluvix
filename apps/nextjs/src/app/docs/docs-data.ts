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
          title: 'Hardware Profiles & Docker Overlays',
          body: 'Modular compose overlays adapt Eluvix to your specific acceleration hardware:',
          table: {
            headers: ['Hardware', 'Compose Command', 'Requirements'],
            rows: [
              ['NVIDIA CUDA', 'docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d', 'nvidia-smi and NVIDIA Container Toolkit'],
              ['AMD ROCm', 'docker compose -f docker-compose.yml -f docker-compose.amd.yml up -d', 'ROCm 6.2 with /dev/kfd and /dev/dri passthrough'],
              ['CPU Only', 'docker compose -f docker-compose.yml -f docker-compose.cpu.yml up -d', 'Standard x86_64 or ARM64 host without GPU'],
              ['OpenViking Profile', 'docker compose --profile memory up -d', 'Runs OpenViking context database on port 1933'],
              ['TrueForge Profile', 'docker compose --profile harness up -d', 'Runs TrueForge agent runtime on port 8790'],
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
];
