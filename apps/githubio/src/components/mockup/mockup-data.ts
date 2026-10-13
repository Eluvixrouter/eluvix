export interface MockUpstream {
  id: string;
  name: string;
  type: 'vllm' | 'vllm-sr' | 'ollama' | 'lemonade' | 'switchyard' | 'billama' | 'openai-compatible';
  endpoint: string;
  priority: number;
  models: string[];
  latencyMs: number;
  status: 'online' | 'degraded' | 'offline';
  enabled: boolean;
  costPer1k: number;
}

export const INITIAL_UPSTREAMS: MockUpstream[] = [
  {
    id: 'local-vllm',
    name: 'Local vLLM GPU Server',
    type: 'vllm',
    endpoint: 'http://localhost:8000',
    priority: 25,
    models: ['meta-llama/Llama-3-8b', 'meta-llama/Llama-3-70b', 'mistralai/Mistral-7B-Instruct-v0.3'],
    latencyMs: 14,
    status: 'online',
    enabled: true,
    costPer1k: 0.0,
  },
  {
    id: 'local-vllm-sr',
    name: 'Local vLLM-sr (Speculative)',
    type: 'vllm-sr',
    endpoint: 'http://localhost:8001',
    priority: 22,
    models: ['meta-llama/Llama-3-8b-instruct', 'deepseek-ai/deepseek-coder-6.7b'],
    latencyMs: 9,
    status: 'online',
    enabled: true,
    costPer1k: 0.0,
  },
  {
    id: 'local-ollama',
    name: 'Local Ollama Engine',
    type: 'ollama',
    endpoint: 'http://localhost:11434',
    priority: 20,
    models: ['llama3.1:latest', 'qwen2.5-coder:7b', 'mistral:latest', 'phi3:mini', 'llava:latest'],
    latencyMs: 18,
    status: 'online',
    enabled: true,
    costPer1k: 0.0,
  },
  {
    id: 'local-lemonade',
    name: 'Lemonade Router',
    type: 'lemonade',
    endpoint: 'http://localhost:13305',
    priority: 18,
    models: ['llama3.2-1b-FLM', 'Qwen3.5-4B-MTP-GGUF'],
    latencyMs: 12,
    status: 'online',
    enabled: true,
    costPer1k: 0.0,
  },
  {
    id: 'local-switchyard',
    name: 'Local Switchyard Edge Node',
    type: 'switchyard',
    endpoint: 'http://localhost:8080',
    priority: 15,
    models: ['deepseek-ai/deepseek-coder-6.7b', 'codellama:13b'],
    latencyMs: 24,
    status: 'online',
    enabled: true,
    costPer1k: 0.0,
  },
  {
    id: 'billama-cloud',
    name: 'Billama Decentralized Mesh',
    type: 'billama',
    endpoint: 'https://api.billama.dev',
    priority: 10,
    models: ['* (Community GPU Mesh)'],
    latencyMs: 48,
    status: 'online',
    enabled: true,
    costPer1k: 0.00015,
  },
  {
    id: 'openai-direct',
    name: 'OpenAI Direct Frontier',
    type: 'openai-compatible',
    endpoint: 'https://api.openai.com',
    priority: 5,
    models: ['gpt-4o', 'gpt-4o-mini', 'o1-preview'],
    latencyMs: 310,
    status: 'online',
    enabled: true,
    costPer1k: 0.005,
  },
];

export interface TopologyNode {
  id: string;
  name: string;
  type: 'gateway' | 'security' | 'classifier' | 'switchyard' | 'local' | 'cloud' | 'telemetry';
  label: string;
  status: 'active' | 'standby' | 'bypassed';
  details: string;
  x: number;
  y: number;
}

export interface TopologyLink {
  from: string;
  to: string;
  label?: string;
  animated?: boolean;
}

export interface TopologyPreset {
  id: string;
  name: string;
  description: string;
  badge: string;
  savingsRate: string;
  latencyAvg: string;
  sovereigntyScore: string;
  nodes: TopologyNode[];
  links: TopologyLink[];
}

export const TOPOLOGY_PRESETS: TopologyPreset[] = [
  {
    id: 'local-first',
    name: '1. Local-First Default (Recommended)',
    description: 'Routes 85%+ of general tasks to zero-cost local hardware (Ollama/vLLM) with automated cloud fallback only for complex reasoning.',
    badge: 'Balanced Sovereign',
    savingsRate: '88.4%',
    latencyAvg: '14.2ms',
    sovereigntyScore: '98%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'POST /v1/chat/completions', x: 50, y: 150 },
      { id: 'sec', name: 'Privacy Guard', type: 'security', label: 'In-Flight Redactor', status: 'active', details: 'Regex + Presidio + SHA256', x: 250, y: 150 },
      { id: 'cls', name: 'Complexity Filter', type: 'classifier', label: 'DeBERTa-v3 Intent', status: 'active', details: 'Tokens <= 4k -> Local', x: 450, y: 150 },
      { id: 'ollama', name: 'Local Ollama', type: 'local', label: 'Llama 3.1 8B ($0)', status: 'active', details: 'Primary execution (18ms)', x: 670, y: 80 },
      { id: 'vllm', name: 'Local vLLM', type: 'local', label: 'Qwen Coder 7B ($0)', status: 'active', details: 'Coding execution (14ms)', x: 670, y: 160 },
      { id: 'cloud', name: 'Frontier Fallback', type: 'cloud', label: 'GPT-4o / Claude', status: 'standby', details: 'Complex escalations only', x: 670, y: 240 },
    ],
    links: [
      { from: 'gw', to: 'sec', animated: true },
      { from: 'sec', to: 'cls', animated: true },
      { from: 'cls', to: 'ollama', label: 'General (70%)', animated: true },
      { from: 'cls', to: 'vllm', label: 'Code (18%)', animated: true },
      { from: 'cls', to: 'cloud', label: 'Reasoning (12%)' },
    ],
  },
  {
    id: 'airgapped',
    name: '2. Airgapped Enclave (100% Offline)',
    description: 'Strict offline mode. All external cloud egress interfaces are physically severed. Only local localhost unix sockets and LAN upstreams permitted.',
    badge: '100% Offline',
    savingsRate: '100%',
    latencyAvg: '11.8ms',
    sovereigntyScore: '100%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'Airgapped loopback only', x: 50, y: 150 },
      { id: 'sec', name: 'Sovereign Enclave', type: 'security', label: 'Zero-Egress Firewall', status: 'active', details: 'Block WAN egress / DNS leak prevention', x: 260, y: 150 },
      { id: 'sw', name: 'Switchyard LAN', type: 'switchyard', label: 'Local Mesh Dispatcher', status: 'active', details: 'Local subnet routing', x: 470, y: 150 },
      { id: 'vllm', name: 'vLLM Server', type: 'local', label: 'Llama 3 70B Quantized', status: 'active', details: 'NVLink Dual 4090 ($0)', x: 680, y: 100 },
      { id: 'ollama', name: 'Ollama Edge', type: 'local', label: 'Mistral 7B Local', status: 'active', details: 'Instant CPU/GPU fallback ($0)', x: 680, y: 200 },
    ],
    links: [
      { from: 'gw', to: 'sec', animated: true },
      { from: 'sec', to: 'sw', animated: true },
      { from: 'sw', to: 'vllm', label: 'Heavy tasks', animated: true },
      { from: 'sw', to: 'ollama', label: 'Quick answers', animated: true },
    ],
  },
  {
    id: 'cost-optimizer',
    name: '3. Hard Budget Cost Optimizer',
    description: 'Enforces hard per-request and per-month budget caps. Automatically routes high-token prompts to quantized local checkpoints.',
    badge: 'Max Savings',
    savingsRate: '95.2%',
    latencyAvg: '16.5ms',
    sovereigntyScore: '96%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'Budget check in-flight', x: 50, y: 150 },
      { id: 'bgt', name: 'Budget Guard', type: 'security', label: 'Ceiling: $0.005/req', status: 'active', details: 'Reject expensive cloud triggers', x: 260, y: 150 },
      { id: 'cls', name: 'Token Quantizer', type: 'classifier', label: 'Size & Complexity Matcher', status: 'active', details: 'Match prompt to minimal viable weights', x: 470, y: 150 },
      { id: 'ollama', name: 'Local Ollama', type: 'local', label: 'Qwen 2.5 Coder 7B', status: 'active', details: '$0.00 / 1k tokens', x: 680, y: 100 },
      { id: 'billama', name: 'Billama Mesh', type: 'cloud', label: 'P2P Micro-GPU', status: 'active', details: '$0.00015 / 1k tokens', x: 680, y: 200 },
    ],
    links: [
      { from: 'gw', to: 'bgt', animated: true },
      { from: 'bgt', to: 'cls', animated: true },
      { from: 'cls', to: 'ollama', label: 'Local (92%)', animated: true },
      { from: 'cls', to: 'billama', label: 'Mesh Overflow (8%)', animated: true },
    ],
  },
  {
    id: 'fast-response',
    name: '4. Fast Response (Sub-50ms Ultra-Low Latency)',
    description: 'Prioritizes Time-to-First-Token (TTFT). Uses speculative decoding with vLLM-sr and local small models for real-time interactive autocomplete.',
    badge: 'Sub-50ms',
    savingsRate: '91.0%',
    latencyAvg: '8.4ms',
    sovereigntyScore: '99%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'Speculative pipeline', x: 50, y: 150 },
      { id: 'vllmsr', name: 'vLLM-sr', type: 'local', label: 'Speculative Draft Model', status: 'active', details: 'Llama-3-1B Draft + 8B Verifier (9ms)', x: 280, y: 150 },
      { id: 'out', name: 'Stream Multiplexer', type: 'telemetry', label: 'Chunk Streamer', status: 'active', details: '0.4ms TTFT chunk dispatch', x: 520, y: 150 },
      { id: 'cache', name: 'Semantic KV Cache', type: 'switchyard', label: 'Prompt Prefix Cache', status: 'active', details: '94% hit rate on frequent templates', x: 520, y: 250 },
    ],
    links: [
      { from: 'gw', to: 'vllmsr', animated: true },
      { from: 'vllmsr', to: 'out', animated: true },
      { from: 'gw', to: 'cache' },
    ],
  },
  {
    id: 'privacy-strict',
    name: '5. Privacy Strict (Zero Trust Redaction)',
    description: 'High-assurance privacy pipeline: scrubs PII, API tokens, patient identifiers, and trade secrets before data ever touches any execution layer.',
    badge: 'HIPAA & GDPR Ready',
    savingsRate: '87.5%',
    latencyAvg: '15.1ms',
    sovereigntyScore: '99.9%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'Encrypted mTLS input', x: 50, y: 150 },
      { id: 'pii', name: 'Regex Sanitizer', type: 'security', label: 'SSN / CC / Keys / Email', status: 'active', details: '100+ high-entropy patterns', x: 250, y: 90 },
      { id: 'presidio', name: 'NER Classifier', type: 'security', label: 'Contextual Named Entity Filter', status: 'active', details: 'Medical & Legal entity obfuscator', x: 250, y: 210 },
      { id: 'vault', name: 'Local Hash Vault', type: 'security', label: 'Deterministic SHA-256 Map', status: 'active', details: 'Un-masks tokens upon local return', x: 470, y: 150 },
      { id: 'loc', name: 'Sanitized Local Execution', type: 'local', label: 'Local vLLM / Ollama', status: 'active', details: 'Processes sanitized payload only', x: 690, y: 150 },
    ],
    links: [
      { from: 'gw', to: 'pii', animated: true },
      { from: 'gw', to: 'presidio', animated: true },
      { from: 'pii', to: 'vault', animated: true },
      { from: 'presidio', to: 'vault', animated: true },
      { from: 'vault', to: 'loc', animated: true },
    ],
  },
  {
    id: 'vision-multimodal',
    name: '6. Vision & Multimodal Splitter',
    description: 'Intelligently detects base64 image payloads. Routes text prompts to fast local LLMs and image/diagram understanding to local LLaVA or vision cloud.',
    badge: 'Multimodal Routing',
    savingsRate: '79.3%',
    latencyAvg: '28.0ms',
    sovereigntyScore: '94%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'Payload inspector', x: 50, y: 150 },
      { id: 'mime', name: 'Payload Classifier', type: 'classifier', label: 'Image vs Text Detector', status: 'active', details: 'Inspects image_url parts', x: 260, y: 150 },
      { id: 'txt', name: 'Text Stream', type: 'local', label: 'Ollama Qwen 2.5 (18ms)', status: 'active', details: '$0 text reasoning', x: 500, y: 90 },
      { id: 'vis', name: 'Vision Engine', type: 'local', label: 'Local LLaVA / Qwen-VL', status: 'active', details: 'Local visual understanding ($0)', x: 500, y: 210 },
      { id: 'cvis', name: 'Cloud Fallback', type: 'cloud', label: 'Claude 3.5 Sonnet Vision', status: 'standby', details: 'High-res OCR fallback', x: 720, y: 210 },
    ],
    links: [
      { from: 'gw', to: 'mime', animated: true },
      { from: 'mime', to: 'txt', label: 'Text Only', animated: true },
      { from: 'mime', to: 'vis', label: 'Images Detected', animated: true },
      { from: 'vis', to: 'cvis', label: 'If Low Confidence' },
    ],
  },
  {
    id: 'high-availability',
    name: '7. High-Availability Automatic Failover',
    description: 'Active-active upstream clustering. If local Ollama runs out of VRAM or crashes, traffic seamlessly diverts to vLLM or secondary node in 0.5ms.',
    badge: '99.99% Uptime',
    savingsRate: '86.1%',
    latencyAvg: '15.8ms',
    sovereigntyScore: '97%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'Circuit breaker enabled', x: 50, y: 150 },
      { id: 'hb', name: 'Health Probe', type: 'switchyard', label: 'Active Ping (every 2s)', status: 'active', details: 'Tracks node error states', x: 260, y: 150 },
      { id: 'p1', name: 'Primary: Ollama Node 1', type: 'local', label: 'RTX 4090 ($0)', status: 'active', details: 'Primary target (18ms)', x: 500, y: 80 },
      { id: 'p2', name: 'Secondary: vLLM Node 2', type: 'local', label: 'RTX 3090 ($0)', status: 'standby', details: 'Instant standby fallback', x: 500, y: 160 },
      { id: 'p3', name: 'Tertiary: Cloud Fallback', type: 'cloud', label: 'OpenAI Direct', status: 'standby', details: 'Disaster recovery only', x: 500, y: 240 },
    ],
    links: [
      { from: 'gw', to: 'hb', animated: true },
      { from: 'hb', to: 'p1', label: 'Active Path', animated: true },
      { from: 'hb', to: 'p2', label: 'Failover 1' },
      { from: 'hb', to: 'p3', label: 'Failover 2' },
    ],
  },
  {
    id: 'self-quantized',
    name: '8. Self-Hosted Quantization Pipeline',
    description: 'Optimized for consumer laptops and workstations (Apple Silicon M-series, RTX 3060). Routes requests to GGUF and AWQ 4-bit quantizations.',
    badge: 'Lightweight VRAM',
    savingsRate: '92.4%',
    latencyAvg: '19.4ms',
    sovereigntyScore: '99%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'VRAM budget monitor', x: 50, y: 150 },
      { id: 'vram', name: 'VRAM Governor', type: 'classifier', label: 'Checks available VRAM', status: 'active', details: 'Ensures zero system freeze', x: 270, y: 150 },
      { id: 'q4', name: 'Lemonade / GGUF Q4_K_M', type: 'local', label: 'Llama 3.2 3B (2.1GB VRAM)', status: 'active', details: 'Runs on any modern Mac or PC ($0)', x: 520, y: 100 },
      { id: 'awq', name: 'vLLM AWQ 4-Bit', type: 'local', label: 'Qwen 7B (5.2GB VRAM)', status: 'active', details: 'High throughput quantization ($0)', x: 520, y: 200 },
    ],
    links: [
      { from: 'gw', to: 'vram', animated: true },
      { from: 'vram', to: 'q4', label: '< 4GB free', animated: true },
      { from: 'vram', to: 'awq', label: '>= 6GB free', animated: true },
    ],
  },
  {
    id: 'billama-mesh',
    name: '9. Billama Community Mesh Provider',
    description: 'Dual-mode topology: executes private queries locally while monetizing spare GPU cycles by serving distributed batch jobs for the Billama network.',
    badge: 'Earn While Idle',
    savingsRate: '94.8%',
    latencyAvg: '14.0ms',
    sovereigntyScore: '96%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'Dual worker-client proxy', x: 50, y: 150 },
      { id: 'pri', name: 'Priority Arbiter', type: 'switchyard', label: 'User Preemption Engine', status: 'active', details: 'Pauses worker jobs instantly when user types', x: 270, y: 150 },
      { id: 'user', name: 'Local User Job', type: 'local', label: 'Local GPU (User Query)', status: 'active', details: 'Instant priority response ($0)', x: 530, y: 90 },
      { id: 'billama', name: 'Billama Worker Daemon', type: 'cloud', label: 'Community Job Receiver', status: 'active', details: 'Earns $0.00025 / 1k tokens while idle', x: 530, y: 210 },
    ],
    links: [
      { from: 'gw', to: 'pri', animated: true },
      { from: 'pri', to: 'user', label: 'User Active (Preempt)', animated: true },
      { from: 'pri', to: 'billama', label: 'GPU Idle (Monetize)', animated: true },
    ],
  },
  {
    id: 'developer-stack',
    name: '10. Developer Localhost Stack',
    description: 'Tailored for Cursor, Claude Code, Continue.dev, and Aider. Specialized code completion dispatch to fast 7B coders with deep architectural reasoning fallback.',
    badge: 'Code Optimized',
    savingsRate: '89.1%',
    latencyAvg: '11.2ms',
    sovereigntyScore: '98%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'OpenAI endpoint emulation', x: 50, y: 150 },
      { id: 'intent', name: 'Code Router', type: 'classifier', label: 'Completion vs Refactor', status: 'active', details: 'Detects FIM (Fill-in-the-Middle)', x: 260, y: 150 },
      { id: 'fim', name: 'Fast Tab-Autocomplete', type: 'local', label: 'vLLM Qwen 2.5 Coder 7B', status: 'active', details: 'Sub-20ms autocomplete ($0)', x: 520, y: 80 },
      { id: 'chat', name: 'Local Code Chat', type: 'local', label: 'DeepSeek Coder 6.7B', status: 'active', details: 'Fast terminal explanation ($0)', x: 520, y: 160 },
      { id: 'sonnet', name: 'Deep Architecture', type: 'cloud', label: 'Claude 3.5 Sonnet', status: 'standby', details: 'Large refactors & whole-repo diffs', x: 520, y: 240 },
    ],
    links: [
      { from: 'gw', to: 'intent', animated: true },
      { from: 'intent', to: 'fim', label: 'Inline Autocomplete', animated: true },
      { from: 'intent', to: 'chat', label: 'Unit Test / Function' },
      { from: 'intent', to: 'sonnet', label: 'Major Refactor' },
    ],
  },
  {
    id: 'enterprise-mixed',
    name: '11. Enterprise Mixed Topology',
    description: 'Multi-tiered enterprise routing: sensitive corporate data stays strictly on on-premise local servers; non-sensitive general content uses cloud endpoints.',
    badge: 'Enterprise Hybrid',
    savingsRate: '82.3%',
    latencyAvg: '17.3ms',
    sovereigntyScore: '97%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'Corporate SSO / RBAC', x: 50, y: 150 },
      { id: 'audit', name: 'Audit Logger', type: 'telemetry', label: 'SQLite Cryptographic Log', status: 'active', details: 'Audit trail for SOC2 / ISO27001', x: 260, y: 150 },
      { id: 'tag', name: 'Tag Classifier', type: 'classifier', label: 'Confidential vs Public', status: 'active', details: 'Classification taxonomy tags', x: 470, y: 150 },
      { id: 'onprem', name: 'On-Premises vLLM Cluster', type: 'local', label: 'Internal GPU Cluster', status: 'active', details: 'Zero data leaves enterprise ($0)', x: 690, y: 90 },
      { id: 'cloudpub', name: 'Frontier Public Models', type: 'cloud', label: 'Public OpenAI / Anthropic', status: 'active', details: 'Sanitized queries only', x: 690, y: 210 },
    ],
    links: [
      { from: 'gw', to: 'audit', animated: true },
      { from: 'audit', to: 'tag', animated: true },
      { from: 'tag', to: 'onprem', label: 'Internal Confidential', animated: true },
      { from: 'tag', to: 'cloudpub', label: 'Public Sanitize' },
    ],
  },
  {
    id: 'zdr-retention',
    name: '12. Zero-Data-Retention (ZDR)',
    description: 'Ephemeral in-memory processing. Telemetry logs discard prompt content entirely and store only token statistics and cryptographic hash fingerprints.',
    badge: 'Zero Retention',
    savingsRate: '93.0%',
    latencyAvg: '13.5ms',
    sovereigntyScore: '100%',
    nodes: [
      { id: 'gw', name: 'Gateway', type: 'gateway', label: '127.0.0.1:3000', status: 'active', details: 'RAM-only volatile buffers', x: 50, y: 150 },
      { id: 'shred', name: 'Memory Scrubber', type: 'security', label: 'Immediate Memory Zeroing', status: 'active', details: 'Zeros buffers post-inference', x: 280, y: 150 },
      { id: 'ephem', name: 'Local GPU Session', type: 'local', label: 'Ollama Stateless Mode', status: 'active', details: 'No history stored on disk ($0)', x: 530, y: 150 },
    ],
    links: [
      { from: 'gw', to: 'shred', animated: true },
      { from: 'shred', to: 'ephem', animated: true },
    ],
  },
];

export interface MockSamplePrompt {
  id: string;
  title: string;
  category: string;
  rawPrompt: string;
  maskedPrompt: string;
  sanitizationDetails: string[];
  chosenRoute: string;
  model: string;
  routeReason: string;
  response: string;
  ttftMs: number;
  totalMs: number;
  promptTokens: number;
  completionTokens: number;
  localCost: string;
  cloudCost: string;
}

export const SAMPLE_PROMPTS: MockSamplePrompt[] = [
  {
    id: 'debug-code',
    title: 'Python Memory Leak & Refactor',
    category: 'Coding',
    rawPrompt: `Fix this memory leak in our worker loop:
def process_items(queue):
    global_cache = []
    while True:
        item = queue.get()
        global_cache.append(item)
        calculate_metrics(item)`,
    maskedPrompt: `Fix this memory leak in our worker loop:
def process_items(queue):
    global_cache = []
    while True:
        item = queue.get()
        global_cache.append(item)
        calculate_metrics(item)`,
    sanitizationDetails: ['No PII detected. Prompt passed through raw.'],
    chosenRoute: 'Local vLLM GPU Server',
    model: 'qwen2.5-coder:7b',
    routeReason: 'High code content detected. Directed to high-speed local code engine.',
    response: `The issue is that \`global_cache\` grows indefinitely on every iteration of the \`while True\` loop, causing an unbounded memory leak. 

Here is the fixed pattern using a bounded \`collections.deque\` with a maximum length or clearing periodically:

\`\`\`python
from collections import deque

def process_items(queue, max_cache_size=1000):
    cache = deque(maxlen=max_cache_size)
    while True:
        item = queue.get()
        if item is None:  # Sentinel value to exit cleanly
            break
        cache.append(item)
        calculate_metrics(item)
\`\`\`

Key fixes:
1. Replaced unbounded list with \`deque(maxlen=...)\` so older entries are automatically evicted.
2. Removed global scope leakage.
3. Added clean exit sentinel.`,
    ttftMs: 14,
    totalMs: 142,
    promptTokens: 48,
    completionTokens: 164,
    localCost: '$0.0000',
    cloudCost: '$0.0042',
  },
  {
    id: 'pii-leak',
    title: 'Medical Summary with Patient SSN & API Keys',
    category: 'Privacy Shield',
    rawPrompt: `Patient John Doe (SSN: 342-88-9124, DOB: 04/12/1982) was diagnosed with Acute Bronchitis. 
Please sync this to internal health API using key sk-live-99238472910384719284910238471.`,
    maskedPrompt: `Patient [PERSON_NAME_1] (SSN: [REDACTED_SSN_1], DOB: [DATE_OF_BIRTH_1]) was diagnosed with Acute Bronchitis. 
Please sync this to internal health API using key [REDACTED_API_KEY_1].`,
    sanitizationDetails: [
      'Masked Person: "John Doe" -> [PERSON_NAME_1]',
      'Redacted SSN: "342-88-9124" -> [REDACTED_SSN_1] (SHA: 8f3c7a10...)',
      'Redacted Secret: "sk-live-99..." -> [REDACTED_API_KEY_1] (SHA: e491bc02...)',
      'Airgapped Policy Triggered: Request forced to local sovereign hardware.',
    ],
    chosenRoute: 'Local Ollama Engine (Airgapped)',
    model: 'llama3.1:latest',
    routeReason: 'Protected Health Information (PHI) & Secret Credentials identified. Cloud routing blocked.',
    response: `### Clinical Summary & Ingestion Guidance

**Condition Assessment**:
The patient presents with symptoms consistent with **Acute Bronchitis**, characterized by bronchial inflammation and typical acute cough symptoms.

**Recommended Plan**:
1. Supportive symptomatic care (hydration, rest, antitussives if sleep disrupted).
2. Monitor for secondary bacterial complications or respiratory distress.
3. Secure record synchronization acknowledged using authorized service credentials.

*(Note: In-flight telemetry sanitized all identifiers before local inference execution).*`,
    ttftMs: 18,
    totalMs: 195,
    promptTokens: 62,
    completionTokens: 110,
    localCost: '$0.0000',
    cloudCost: '$0.0035',
  },
  {
    id: 'deep-reasoning',
    title: 'Complex Distributed Consensus Proof',
    category: 'Cloud Escalation',
    rawPrompt: `Compare Paxos vs Raft consensus under asymmetric network partitioning with 2 out of 5 Byzantine faulty nodes. Provide mathematical proof of safety violation boundaries.`,
    maskedPrompt: `Compare Paxos vs Raft consensus under asymmetric network partitioning with 2 out of 5 Byzantine faulty nodes. Provide mathematical proof of safety violation boundaries.`,
    sanitizationDetails: ['No confidential identifiers detected. Complexity evaluation score: 9.4/10.'],
    chosenRoute: 'OpenAI Direct Frontier (Escalation)',
    model: 'gpt-4o',
    routeReason: 'Mathematical rigor & proof complexity exceeded local 8B threshold. Escalated to frontier model.',
    response: `### Consensus Safety Under Asymmetric Partitions with Byzantine Faults

Standard Paxos and Raft are **Crash-Fault-Tolerant (CFT)** protocols, not **Byzantine-Fault-Tolerant (BFT)**.

**1. Fault Tolerance Bounds**:
- For CFT protocols (Paxos, Raft): Maximum tolerable crash faults \(f < \\frac{n}{2}\). With \(n=5\), \(f_{max}=2\).
- For BFT protocols (PBFT): Maximum tolerable Byzantine faults \(f < \\frac{n}{3}\). With \(n=5\), \(f_{max}=1\).

**2. Proof of Safety Violation**:
Given \(n=5\) with \(f=2\) Byzantine nodes:
Suppose nodes \(B_1, B_2\) are Byzantine, and \(C_1, C_2, C_3\) are correct.
If an asymmetric partition isolates \(C_1\) from \(C_2\) while \(C_3\) observes disjoint message histories propagated by \(B_1\) and \(B_2\):
Byzantine nodes can send conflicting \`AppendEntries\` or \`Prepare/Promise\` acks to \(C_1\) and \(C_2\), establishing two concurrent quorums of size \(Q = \\lfloor \\frac{5}{2} \\rfloor + 1 = 3\):
- Quorum A: \(\{C_1, B_1, B_2\}\) commits value \(V_1\) at term \(t\).
- Quorum B: \(\{C_2, B_1, B_2\}\) commits value \(V_2\) at term \(t\) with \(V_1 \\neq V_2\).

Since \(B_1, B_2\) can equivocate across partitions, the intersection of Quorums A and B contains only Byzantine nodes:
\\[
Q_A \\cap Q_B = \\{B_1, B_2\\} \\subseteq \\text{Faulty}
\\]
Hence, the non-empty intersection property of correct nodes fails, violating the State Machine Safety invariant.`,
    ttftMs: 290,
    totalMs: 780,
    promptTokens: 42,
    completionTokens: 380,
    localCost: 'N/A (Escalated)',
    cloudCost: '$0.0124',
  },
];

export interface MockTrace {
  id: string;
  time: string;
  model: string;
  upstream: string;
  tokens: number;
  durationMs: number;
  cost: string;
  savings: string;
  status: '200 OK' | 'Fallback' | 'Sanitized';
  client: string;
}

export const MOCK_TRACES: MockTrace[] = [
  { id: 'req_8921a', time: '11:42:15', model: 'qwen2.5-coder:7b', upstream: 'Local vLLM', tokens: 412, durationMs: 24, cost: '$0.0000', savings: '$0.0082', status: '200 OK', client: 'Cursor IDE' },
  { id: 'req_8920b', time: '11:42:01', model: 'llama3.1:latest', upstream: 'Local Ollama', tokens: 184, durationMs: 18, cost: '$0.0000', savings: '$0.0036', status: 'Sanitized', client: 'Claude Code CLI' },
  { id: 'req_8919c', time: '11:41:48', model: 'gpt-4o', upstream: 'OpenAI Direct', tokens: 620, durationMs: 310, cost: '$0.0062', savings: '$0.0000', status: 'Fallback', client: 'Open WebUI' },
  { id: 'req_8918d', time: '11:41:30', model: 'meta-llama/Llama-3-8b', upstream: 'Local vLLM', tokens: 295, durationMs: 16, cost: '$0.0000', savings: '$0.0059', status: '200 OK', client: 'Continue.dev' },
  { id: 'req_8917e', time: '11:41:12', model: 'deepseek-coder:6.7b', upstream: 'Local Switchyard', tokens: 540, durationMs: 28, cost: '$0.0000', savings: '$0.0108', status: '200 OK', client: 'Python SDK' },
  { id: 'req_8916f', time: '11:40:55', model: 'llama3.2-1b-FLM', upstream: 'Lemonade Router', tokens: 92, durationMs: 8, cost: '$0.0000', savings: '$0.0018', status: '200 OK', client: 'Cursor Autocomplete' },
  { id: 'req_8915g', time: '11:40:32', model: 'llama3.1:latest', upstream: 'Local Ollama', tokens: 320, durationMs: 19, cost: '$0.0000', savings: '$0.0064', status: 'Sanitized', client: 'Aider AI' },
];

export interface MockDockerContainer {
  name: string;
  service: string;
  port: number;
  running: boolean;
  image: string;
}

export const INITIAL_DOCKER_SERVICES: MockDockerContainer[] = [
  { name: 'eluvix-ollama', service: 'Ollama Engine', port: 11434, running: true, image: 'ollama/ollama:latest' },
  { name: 'eluvix-vllm', service: 'vLLM OpenAI Server', port: 8000, running: true, image: 'vllm/vllm-openai:latest' },
  { name: 'eluvix-lemonade', service: 'Lemonade Router', port: 13305, running: true, image: 'lemonade/router:latest' },
  { name: 'eluvix-switchyard', service: 'Switchyard Node', port: 8080, running: false, image: 'eluvix/switchyard:v0.1' },
];
