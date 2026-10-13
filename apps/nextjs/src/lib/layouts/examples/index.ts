import { Layout } from '../types';

export const EXAMPLE_LAYOUTS: Layout[] = [
  // 1. Default / Full Production Stack
  {
    id: 'default',
    name: 'Full Production Stack',
    description: 'Complete production pipeline with Privacy Guard, Semantic Prompt Defense, Switchyard Balancer, Local Lemonade/Ollama engines, and Agentic Coding CLI fallbacks.',
    category: 'starter',
    tags: ['production', 'recommended', 'privacy', 'hybrid', 'agent'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.85 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 50, y: 220 }, data: { label: 'Client Input' } },
      {
        id: 'privacy-guard-1',
        type: 'privacyGuardNode',
        position: { x: 300, y: 120 },
        data: {
          action: 'anonymize',
          detectPii: { apiKey: true, ssn: true, creditCard: true, email: true, phone: true }
        }
      },
      {
        id: 'semantic-guard-1',
        type: 'semanticGuardNode',
        position: { x: 620, y: 120 },
        data: { routeName: 'prompt-injection-defense', encoder: 'deberta-v3-injection', threshold: 0.85 }
      },
      {
        id: 'switchyard-1',
        type: 'switchyardNode',
        position: { x: 920, y: 180 },
        data: { strategy: 'cost-complexity', failover: 'enabled' }
      },
      {
        id: 'lemonade-1',
        type: 'lemonadeNode',
        position: { x: 1300, y: 30 },
        data: { label: 'Lemonade Engine', endpoint: 'http://localhost:13305', priority: 30, selectedModel: '*' }
      },
      {
        id: 'ollama-1',
        type: 'ollamaNode',
        position: { x: 1300, y: 210 },
        data: { label: 'Ollama Engine', endpoint: 'http://localhost:11434', priority: 25, selectedModel: '*' }
      },
      {
        id: 'antigravity-1',
        type: 'antigravityNode',
        position: { x: 1300, y: 350 },
        data: {
          label: 'Google Antigravity Agent',
          model: 'gemini-3.8-flash',
          executionMode: 'cli',
          cliPath: 'agy',
          endpoint: 'cli://agy',
          sandboxMode: 'standard',
          agentBehavior: 'autonomous',
          enableSubagents: true,
          maxSubagentDepth: 2,
          extendedThinking: true,
          thinkingBudget: 2048,
          persona: 'software-engineer'
        }
      },
      {
        id: 'claude-code-1',
        type: 'claudeCodeNode',
        position: { x: 1300, y: 520 },
        data: {
          label: 'Claude Code Agent',
          model: 'claude-3-7-sonnet',
          permissionMode: 'accept-non-destructive',
          extendedThinking: true,
          thinkingBudget: 4096,
          persona: 'claude-architect'
        }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 1760, y: 240 },
        data: { projectName: 'eluvix-production', captureInputs: true }
      }
    ],
    edges: [
      { id: 'e-in-privacy', source: 'input-1', target: 'privacy-guard-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-privacy-semantic', source: 'privacy-guard-1', sourceHandle: 'clean', target: 'semantic-guard-1', animated: true, style: { stroke: '#f97316' } },
      { id: 'e-semantic-switchyard', source: 'semantic-guard-1', sourceHandle: 'match', target: 'switchyard-1', animated: true, style: { stroke: '#3b82f6' } },
      { id: 'e-switchyard-lemonade', source: 'switchyard-1', sourceHandle: 'tier-1', target: 'lemonade-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-switchyard-ollama', source: 'switchyard-1', sourceHandle: 'tier-2', target: 'ollama-1', animated: true, style: { stroke: '#eab308' } },
      { id: 'e-switchyard-antigravity', source: 'switchyard-1', sourceHandle: 'tier-3', target: 'antigravity-1', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-switchyard-claude', source: 'switchyard-1', sourceHandle: 'tier-4', target: 'claude-code-1', animated: true, style: { stroke: '#f59e0b' } },
      { id: 'e-lemonade-obs', source: 'lemonade-1', target: 'observability-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-ollama-obs', source: 'ollama-1', target: 'observability-1', animated: true, style: { stroke: '#eab308' } },
      { id: 'e-antigravity-obs', source: 'antigravity-1', sourceHandle: 'output', target: 'observability-1', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-claude-obs', source: 'claude-code-1', sourceHandle: 'output', target: 'observability-1', animated: true, style: { stroke: '#f59e0b' } }
    ]
  },

  // 2. Local-Only Private
  {
    id: 'local-only-private',
    name: '100% Local Airgapped Cluster',
    description: 'Pure zero-egress local inference cluster. Strict Privacy Guard blocking sensitive tokens, routing only through local Lemonade, vLLM, and Ollama.',
    category: 'local',
    tags: ['local', 'zero-egress', 'privacy', 'offline'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.85 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 50, y: 220 }, data: { label: 'Client Input' } },
      {
        id: 'privacy-guard-1',
        type: 'privacyGuardNode',
        position: { x: 300, y: 140 },
        data: { action: 'block', detectPii: { apiKey: true, ssn: true, creditCard: true, email: true, phone: true } }
      },
      {
        id: 'semantic-guard-1',
        type: 'semanticGuardNode',
        position: { x: 600, y: 140 },
        data: { routeName: 'prompt-injection-defense', encoder: 'deberta-v3-injection', threshold: 0.85 }
      },
      {
        id: 'switchyard-1',
        type: 'switchyardNode',
        position: { x: 900, y: 200 },
        data: { strategy: 'lowest-cost', failover: 'enabled' }
      },
      {
        id: 'lemonade-1',
        type: 'lemonadeNode',
        position: { x: 1260, y: 40 },
        data: { label: 'Lemonade Engine', endpoint: 'http://localhost:13305', priority: 30, selectedModel: '*' }
      },
      {
        id: 'vllm-1',
        type: 'vllmNode',
        position: { x: 1260, y: 200 },
        data: { label: 'vLLM Engine', endpoint: 'http://localhost:8000', priority: 25, selectedModel: '*' }
      },
      {
        id: 'ollama-1',
        type: 'ollamaNode',
        position: { x: 1260, y: 360 },
        data: { label: 'Ollama Engine', endpoint: 'http://localhost:11434', priority: 20, selectedModel: '*' }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 1650, y: 200 },
        data: { projectName: 'eluvix-local-cluster', captureInputs: false }
      }
    ],
    edges: [
      { id: 'e-in-priv', source: 'input-1', target: 'privacy-guard-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-priv-sem', source: 'privacy-guard-1', sourceHandle: 'clean', target: 'semantic-guard-1', animated: true, style: { stroke: '#f97316' } },
      { id: 'e-sem-sw', source: 'semantic-guard-1', sourceHandle: 'match', target: 'switchyard-1', animated: true, style: { stroke: '#3b82f6' } },
      { id: 'e-sw-lem', source: 'switchyard-1', sourceHandle: 'tier-1', target: 'lemonade-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-sw-vllm', source: 'switchyard-1', sourceHandle: 'tier-2', target: 'vllm-1', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-sw-ollama', source: 'switchyard-1', sourceHandle: 'tier-3', target: 'ollama-1', animated: true, style: { stroke: '#eab308' } },
      { id: 'e-lem-obs', source: 'lemonade-1', target: 'observability-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-vllm-obs', source: 'vllm-1', target: 'observability-1', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-ollama-obs', source: 'ollama-1', target: 'observability-1', animated: true, style: { stroke: '#eab308' } }
    ]
  },

  // 3. Local-First Coding
  {
    id: 'local-first-coding',
    name: 'Local-First Coding with AGY Frontier',
    description: 'Optimized coding stack. Routes lightweight code completions to local Qwen 2.5 Coder and escalates complex multi-file architectural tasks to Google Antigravity (AGY).',
    category: 'hybrid',
    tags: ['coding', 'hybrid', 'antigravity', 'qwen'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.9 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 60, y: 200 }, data: { label: 'Client Input' } },
      {
        id: 'privacy-guard-1',
        type: 'privacyGuardNode',
        position: { x: 320, y: 150 },
        data: { action: 'anonymize', detectPii: { apiKey: true, ssn: true, creditCard: true } }
      },
      {
        id: 'switchyard-1',
        type: 'switchyardNode',
        position: { x: 640, y: 180 },
        data: { strategy: 'cost-complexity', failover: 'enabled' }
      },
      {
        id: 'ollama-coder',
        type: 'ollamaNode',
        position: { x: 1000, y: 60 },
        data: { label: 'Ollama Qwen 2.5 Coder', endpoint: 'http://localhost:11434', priority: 30, selectedModel: 'qwen2.5-coder' }
      },
      {
        id: 'antigravity-1',
        type: 'antigravityNode',
        position: { x: 1000, y: 280 },
        data: {
          label: 'Google Antigravity Frontier',
          model: 'gemini-3.1-pro',
          executionMode: 'cli',
          cliPath: 'agy',
          endpoint: 'cli://agy',
          sandboxMode: 'standard',
          agentBehavior: 'autonomous',
          enableSubagents: true,
          extendedThinking: true,
          thinkingBudget: 4096,
          persona: 'software-engineer'
        }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 1400, y: 190 },
        data: { projectName: 'eluvix-coding-pipeline', captureInputs: true }
      }
    ],
    edges: [
      { id: 'e-in-priv', source: 'input-1', target: 'privacy-guard-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-priv-sw', source: 'privacy-guard-1', sourceHandle: 'clean', target: 'switchyard-1', animated: true, style: { stroke: '#3b82f6' } },
      { id: 'e-sw-ollama', source: 'switchyard-1', sourceHandle: 'tier-1', target: 'ollama-coder', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-sw-agy', source: 'switchyard-1', sourceHandle: 'tier-3', target: 'antigravity-1', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-ollama-obs', source: 'ollama-coder', target: 'observability-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-agy-obs', source: 'antigravity-1', sourceHandle: 'output', target: 'observability-1', animated: true, style: { stroke: '#06b6d4' } }
    ]
  },

  // 4. Fast Chat Tiny
  {
    id: 'fast-chat-tiny',
    name: 'Ultra-Low Latency Edge Chat',
    description: 'Designed for instant conversational responsiveness. Uses lowest-latency routing targeting compact 1B models across Lemonade FLM and Ollama GGUF.',
    category: 'cost',
    tags: ['latency', 'fast', 'edge', 'small-models'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.95 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 60, y: 180 }, data: { label: 'Client Input' } },
      {
        id: 'switchyard-1',
        type: 'switchyardNode',
        position: { x: 380, y: 160 },
        data: { strategy: 'lowest-latency', failover: 'enabled' }
      },
      {
        id: 'lemonade-tiny',
        type: 'lemonadeNode',
        position: { x: 740, y: 60 },
        data: { label: 'Lemonade 1B FLM', endpoint: 'http://localhost:13305', priority: 35, selectedModel: 'llama3.2-1b-FLM' }
      },
      {
        id: 'ollama-tiny',
        type: 'ollamaNode',
        position: { x: 740, y: 260 },
        data: { label: 'Ollama 1B Q4', endpoint: 'http://localhost:11434', priority: 25, selectedModel: 'llama3.2:1b' }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 1140, y: 160 },
        data: { projectName: 'eluvix-edge-chat', captureInputs: false }
      }
    ],
    edges: [
      { id: 'e-in-sw', source: 'input-1', target: 'switchyard-1', animated: true, style: { stroke: '#3b82f6' } },
      { id: 'e-sw-lem', source: 'switchyard-1', sourceHandle: 'tier-1', target: 'lemonade-tiny', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-sw-oll', source: 'switchyard-1', sourceHandle: 'tier-2', target: 'ollama-tiny', animated: true, style: { stroke: '#eab308' } },
      { id: 'e-lem-obs', source: 'lemonade-tiny', target: 'observability-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-oll-obs', source: 'ollama-tiny', target: 'observability-1', animated: true, style: { stroke: '#eab308' } }
    ]
  },

  // 5. Cost Cascade
  {
    id: 'cost-cascade',
    name: 'Tiered Cost Cascade Routing',
    description: 'Strict economic tiered cascade: routes first to $0 local engines (Lemonade/Ollama), spilling to budget frontier agents, and finally to top-tier reasoning.',
    category: 'cost',
    tags: ['cost', 'cascade', 'tiered', 'budget'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.8 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 50, y: 220 }, data: { label: 'Client Input' } },
      {
        id: 'privacy-guard-1',
        type: 'privacyGuardNode',
        position: { x: 290, y: 140 },
        data: { action: 'anonymize', detectPii: { apiKey: true, ssn: true, creditCard: true } }
      },
      {
        id: 'switchyard-1',
        type: 'switchyardNode',
        position: { x: 600, y: 190 },
        data: { strategy: 'cascade-cost', failover: 'enabled' }
      },
      {
        id: 'tier1-lemonade',
        type: 'lemonadeNode',
        position: { x: 960, y: 20 },
        data: { label: 'Tier 1: Lemonade ($0)', endpoint: 'http://localhost:13305', priority: 40, selectedModel: '*' }
      },
      {
        id: 'tier2-ollama',
        type: 'ollamaNode',
        position: { x: 960, y: 170 },
        data: { label: 'Tier 2: Ollama ($0)', endpoint: 'http://localhost:11434', priority: 30, selectedModel: '*' }
      },
      {
        id: 'tier3-antigravity',
        type: 'antigravityNode',
        position: { x: 960, y: 320 },
        data: {
          label: 'Tier 3: AGY Flash ($0.001)',
          model: 'gemini-3.8-flash',
          executionMode: 'cli',
          cliPath: 'agy',
          endpoint: 'cli://agy',
          sandboxMode: 'standard',
          agentBehavior: 'autonomous'
        }
      },
      {
        id: 'tier4-claude',
        type: 'claudeCodeNode',
        position: { x: 960, y: 480 },
        data: {
          label: 'Tier 4: Claude Sonnet ($0.003)',
          model: 'claude-3-7-sonnet',
          permissionMode: 'accept-non-destructive',
          persona: 'claude-architect'
        }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 1420, y: 220 },
        data: { projectName: 'eluvix-cost-cascade', captureInputs: true }
      }
    ],
    edges: [
      { id: 'e-in-priv', source: 'input-1', target: 'privacy-guard-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-priv-sw', source: 'privacy-guard-1', sourceHandle: 'clean', target: 'switchyard-1', animated: true, style: { stroke: '#3b82f6' } },
      { id: 'e-sw-t1', source: 'switchyard-1', sourceHandle: 'tier-1', target: 'tier1-lemonade', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-sw-t2', source: 'switchyard-1', sourceHandle: 'tier-2', target: 'tier2-ollama', animated: true, style: { stroke: '#eab308' } },
      { id: 'e-sw-t3', source: 'switchyard-1', sourceHandle: 'tier-3', target: 'tier3-antigravity', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-sw-t4', source: 'switchyard-1', sourceHandle: 'tier-4', target: 'tier4-claude', animated: true, style: { stroke: '#f59e0b' } },
      { id: 'e-t1-obs', source: 'tier1-lemonade', target: 'observability-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-t2-obs', source: 'tier2-ollama', target: 'observability-1', animated: true, style: { stroke: '#eab308' } },
      { id: 'e-t3-obs', source: 'tier3-antigravity', sourceHandle: 'output', target: 'observability-1', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-t4-obs', source: 'tier4-claude', sourceHandle: 'output', target: 'observability-1', animated: true, style: { stroke: '#f59e0b' } }
    ]
  },

  // 6. Privacy Max
  {
    id: 'privacy-max',
    name: 'Zero-Data-Leak Airgap Shield',
    description: 'Maximum security configuration. Enforces hard-blocking of API keys, SSNs, credit cards, emails, phone numbers, and IPs before forwarding to an isolated local engine.',
    category: 'privacy',
    tags: ['privacy', 'airgap', 'security', 'pii-block'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.9 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 60, y: 180 }, data: { label: 'Client Input' } },
      {
        id: 'privacy-guard-1',
        type: 'privacyGuardNode',
        position: { x: 300, y: 130 },
        data: {
          action: 'block',
          detectPii: { apiKey: true, ssn: true, creditCard: true, email: true, phone: true }
        }
      },
      {
        id: 'semantic-guard-1',
        type: 'semanticGuardNode',
        position: { x: 620, y: 130 },
        data: { routeName: 'prompt-injection-defense', encoder: 'deberta-v3-injection', threshold: 0.90 }
      },
      {
        id: 'lemonade-isolated',
        type: 'lemonadeNode',
        position: { x: 960, y: 130 },
        data: { label: 'Airgapped Lemonade', endpoint: 'http://localhost:13305', priority: 50, selectedModel: '*' }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 1320, y: 130 },
        data: { projectName: 'eluvix-airgap-audit', captureInputs: false }
      }
    ],
    edges: [
      { id: 'e-in-priv', source: 'input-1', target: 'privacy-guard-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-priv-sem', source: 'privacy-guard-1', sourceHandle: 'clean', target: 'semantic-guard-1', animated: true, style: { stroke: '#f97316' } },
      { id: 'e-sem-lem', source: 'semantic-guard-1', sourceHandle: 'match', target: 'lemonade-isolated', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-lem-obs', source: 'lemonade-isolated', target: 'observability-1', animated: true, style: { stroke: '#10b981' } }
    ]
  },

  // 7. Agent Heavy
  {
    id: 'agent-heavy',
    name: 'Multi-Agent Autonomous Engineering',
    description: 'Orchestrates three leading autonomous coding agents (Google Antigravity, Claude Code, and OpenAI Codex) under Switchyard task allocation.',
    category: 'agent',
    tags: ['agents', 'antigravity', 'claude-code', 'codex', 'autonomous'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.8 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 50, y: 240 }, data: { label: 'Task Specification' } },
      {
        id: 'switchyard-1',
        type: 'switchyardNode',
        position: { x: 380, y: 210 },
        data: { strategy: 'cost-complexity', failover: 'enabled' }
      },
      {
        id: 'antigravity-1',
        type: 'antigravityNode',
        position: { x: 780, y: 40 },
        data: {
          label: 'Google Antigravity Agent',
          model: 'gemini-3.8-flash',
          executionMode: 'cli',
          cliPath: 'agy',
          endpoint: 'cli://agy',
          sandboxMode: 'standard',
          agentBehavior: 'autonomous',
          enableSubagents: true,
          extendedThinking: true,
          thinkingBudget: 4096,
          persona: 'software-engineer'
        }
      },
      {
        id: 'claude-code-1',
        type: 'claudeCodeNode',
        position: { x: 780, y: 220 },
        data: {
          label: 'Claude Code Agent',
          model: 'claude-3-7-sonnet',
          permissionMode: 'accept-non-destructive',
          extendedThinking: true,
          thinkingBudget: 4096,
          persona: 'claude-architect'
        }
      },
      {
        id: 'codex-1',
        type: 'codexNode',
        position: { x: 780, y: 400 },
        data: {
          label: 'OpenAI Codex',
          model: 'o3-mini',
          reasoningEffort: 'medium',
          approvalMode: 'confirm-risky',
          persona: 'codex-engineer'
        }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 1240, y: 230 },
        data: { projectName: 'eluvix-multi-agent-ops', captureInputs: true }
      }
    ],
    edges: [
      { id: 'e-in-sw', source: 'input-1', target: 'switchyard-1', animated: true, style: { stroke: '#3b82f6' } },
      { id: 'e-sw-agy', source: 'switchyard-1', sourceHandle: 'tier-1', target: 'antigravity-1', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-sw-claude', source: 'switchyard-1', sourceHandle: 'tier-2', target: 'claude-code-1', animated: true, style: { stroke: '#f59e0b' } },
      { id: 'e-sw-codex', source: 'switchyard-1', sourceHandle: 'tier-3', target: 'codex-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-agy-obs', source: 'antigravity-1', sourceHandle: 'output', target: 'observability-1', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-claude-obs', source: 'claude-code-1', sourceHandle: 'output', target: 'observability-1', animated: true, style: { stroke: '#f59e0b' } },
      { id: 'e-codex-obs', source: 'codex-1', sourceHandle: 'output', target: 'observability-1', animated: true, style: { stroke: '#10b981' } }
    ]
  },

  // 8. Antigravity Direct
  {
    id: 'antigravity-direct',
    name: 'Direct Google Antigravity (AGY)',
    description: 'Direct pathway to the Google Antigravity autonomous CLI with Gemini 3.8 Flash, extended thinking budget (2048 tokens), and isolated subagents enabled.',
    category: 'agent',
    tags: ['antigravity', 'gemini', 'cli', 'extended-thinking'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.95 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 80, y: 200 }, data: { label: 'Task Specification' } },
      {
        id: 'antigravity-1',
        type: 'antigravityNode',
        position: { x: 420, y: 150 },
        data: {
          label: 'Google Antigravity Agent',
          model: 'gemini-3.8-flash',
          executionMode: 'cli',
          cliPath: 'agy',
          endpoint: 'cli://agy',
          sandboxMode: 'standard',
          agentBehavior: 'autonomous',
          enableSubagents: true,
          maxSubagentDepth: 3,
          extendedThinking: true,
          thinkingBudget: 2048,
          persona: 'software-engineer',
          systemInstructions: 'You are an expert autonomous software engineer pair-programming to build production features.'
        }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 880, y: 190 },
        data: { projectName: 'eluvix-antigravity-direct', captureInputs: true }
      }
    ],
    edges: [
      { id: 'e-in-agy', source: 'input-1', target: 'antigravity-1', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-agy-obs', source: 'antigravity-1', sourceHandle: 'output', target: 'observability-1', animated: true, style: { stroke: '#06b6d4' } }
    ]
  },

  // 9. Round Robin Lab
  {
    id: 'round-robin-lab',
    name: 'Round-Robin Model Evaluation Lab',
    description: 'Distributes incoming evaluation benchmarks equally across Lemonade, vLLM, and Ollama instances for side-by-side performance profiling.',
    category: 'hybrid',
    tags: ['eval', 'benchmark', 'round-robin', 'testing'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.85 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 60, y: 220 }, data: { label: 'Benchmark Request' } },
      {
        id: 'switchyard-1',
        type: 'switchyardNode',
        position: { x: 380, y: 190 },
        data: { strategy: 'round-robin', failover: 'disabled' }
      },
      {
        id: 'lemonade-bench',
        type: 'lemonadeNode',
        position: { x: 760, y: 40 },
        data: { label: 'Lemonade Engine', endpoint: 'http://localhost:13305', priority: 10, selectedModel: '*' }
      },
      {
        id: 'vllm-bench',
        type: 'vllmNode',
        position: { x: 760, y: 200 },
        data: { label: 'vLLM Engine', endpoint: 'http://localhost:8000', priority: 10, selectedModel: '*' }
      },
      {
        id: 'ollama-bench',
        type: 'ollamaNode',
        position: { x: 760, y: 360 },
        data: { label: 'Ollama Engine', endpoint: 'http://localhost:11434', priority: 10, selectedModel: '*' }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 1180, y: 200 },
        data: { projectName: 'eluvix-model-eval', captureInputs: true }
      }
    ],
    edges: [
      { id: 'e-in-sw', source: 'input-1', target: 'switchyard-1', animated: true, style: { stroke: '#3b82f6' } },
      { id: 'e-sw-lem', source: 'switchyard-1', sourceHandle: 'tier-1', target: 'lemonade-bench', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-sw-vllm', source: 'switchyard-1', sourceHandle: 'tier-2', target: 'vllm-bench', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-sw-oll', source: 'switchyard-1', sourceHandle: 'tier-3', target: 'ollama-bench', animated: true, style: { stroke: '#eab308' } },
      { id: 'e-lem-obs', source: 'lemonade-bench', target: 'observability-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-vllm-obs', source: 'vllm-bench', target: 'observability-1', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-oll-obs', source: 'ollama-bench', target: 'observability-1', animated: true, style: { stroke: '#eab308' } }
    ]
  },

  // 10. Vision Multimodal
  {
    id: 'vision-multimodal',
    name: 'Multimodal & Vision Pipeline',
    description: 'Automatically identifies image payloads and routes vision tasks between local vision adapters and Google Antigravity multimodal agents.',
    category: 'hybrid',
    tags: ['vision', 'multimodal', 'images', 'hybrid'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.9 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 60, y: 200 }, data: { label: 'Multimodal Input' } },
      {
        id: 'switchyard-1',
        type: 'switchyardNode',
        position: { x: 380, y: 170 },
        data: { strategy: 'cost-complexity', failover: 'enabled' }
      },
      {
        id: 'lemonade-vision',
        type: 'lemonadeNode',
        position: { x: 760, y: 60 },
        data: { label: 'Lemonade Vision (Local)', endpoint: 'http://localhost:13305', priority: 30, selectedModel: '*' }
      },
      {
        id: 'antigravity-vision',
        type: 'antigravityNode',
        position: { x: 760, y: 270 },
        data: {
          label: 'AGY Gemini 3.8 Multimodal',
          model: 'gemini-3.8-flash',
          executionMode: 'cli',
          cliPath: 'agy',
          endpoint: 'cli://agy',
          sandboxMode: 'standard',
          agentBehavior: 'autonomous',
          persona: 'software-engineer'
        }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 1180, y: 180 },
        data: { projectName: 'eluvix-multimodal-observability', captureInputs: true }
      }
    ],
    edges: [
      { id: 'e-in-sw', source: 'input-1', target: 'switchyard-1', animated: true, style: { stroke: '#3b82f6' } },
      { id: 'e-sw-lem', source: 'switchyard-1', sourceHandle: 'tier-1', target: 'lemonade-vision', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-sw-agy', source: 'switchyard-1', sourceHandle: 'tier-2', target: 'antigravity-vision', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-lem-obs', source: 'lemonade-vision', target: 'observability-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-agy-obs', source: 'antigravity-vision', sourceHandle: 'output', target: 'observability-1', animated: true, style: { stroke: '#06b6d4' } }
    ]
  },

  // 11. MCP Tools
  {
    id: 'mcp-tools',
    name: 'MCP Agent Toolkit Hub',
    description: 'Connects Model Context Protocol (MCP) server tools to an Agent Gateway, giving Antigravity and Claude Code access to filesystem and DB integrations.',
    category: 'agent',
    tags: ['mcp', 'tools', 'agent-gateway', 'integrations'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.8 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 50, y: 220 }, data: { label: 'Client Input' } },
      {
        id: 'task-router-1',
        type: 'taskRouterNode',
        position: { x: 300, y: 200 },
        data: { preference: 'balanced' }
      },
      {
        id: 'mcp-fs',
        type: 'mcpToolNode',
        position: { x: 300, y: 400 },
        data: { toolName: 'Filesystem MCP', mcpEndpoint: 'http://localhost:8003/mcp' }
      },
      {
        id: 'agent-gateway-1',
        type: 'agentGatewayNode',
        position: { x: 620, y: 240 },
        data: { accessPolicy: 'restrictive', mcpEndpoint: 'http://localhost:8003/mcp', enableNativeTools: true }
      },
      {
        id: 'antigravity-mcp',
        type: 'antigravityNode',
        position: { x: 960, y: 200 },
        data: {
          label: 'Antigravity MCP Agent',
          model: 'gemini-3.8-flash',
          executionMode: 'cli',
          cliPath: 'agy',
          endpoint: 'cli://agy',
          sandboxMode: 'standard',
          agentBehavior: 'autonomous',
          enableMcpTools: true,
          enableWriteTools: true,
          extendedThinking: true,
          thinkingBudget: 2048
        }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 1380, y: 220 },
        data: { projectName: 'eluvix-mcp-hub', captureInputs: true }
      }
    ],
    edges: [
      { id: 'e-in-tr', source: 'input-1', target: 'task-router-1', animated: true, style: { stroke: '#eab308' } },
      { id: 'e-tr-ag', source: 'task-router-1', sourceHandle: 'task-out', target: 'agent-gateway-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-mcp-ag', source: 'mcp-fs', sourceHandle: 'tool-out', target: 'agent-gateway-1', animated: true, style: { stroke: '#eab308' } },
      { id: 'e-ag-agy', source: 'agent-gateway-1', sourceHandle: 'ag-out', target: 'antigravity-mcp', animated: true, style: { stroke: '#06b6d4' } },
      { id: 'e-agy-obs', source: 'antigravity-mcp', sourceHandle: 'output', target: 'observability-1', animated: true, style: { stroke: '#06b6d4' } }
    ]
  },

  // 12. Observability Debug
  {
    id: 'observability-debug',
    name: 'Deep Observability & Semantic Debug',
    description: 'High-sensitivity prompt injection auditing and detailed trace logging with full input payload capture for security research.',
    category: 'starter',
    tags: ['observability', 'debug', 'prompt-injection', 'security'],
    isExample: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 0.85 },
    nodes: [
      { id: 'input-1', type: 'inputNode', position: { x: 60, y: 200 }, data: { label: 'Audit Stream' } },
      {
        id: 'semantic-guard-debug',
        type: 'semanticGuardNode',
        position: { x: 320, y: 140 },
        data: { routeName: 'strict-prompt-injection', encoder: 'deberta-v3-injection', threshold: 0.70 }
      },
      {
        id: 'privacy-guard-debug',
        type: 'privacyGuardNode',
        position: { x: 620, y: 140 },
        data: { action: 'warn', detectPii: { apiKey: true, ssn: true, creditCard: true, email: true, phone: true } }
      },
      {
        id: 'switchyard-1',
        type: 'switchyardNode',
        position: { x: 920, y: 180 },
        data: { strategy: 'cost-complexity', failover: 'enabled' }
      },
      {
        id: 'lemonade-1',
        type: 'lemonadeNode',
        position: { x: 1260, y: 80 },
        data: { label: 'Lemonade Engine', endpoint: 'http://localhost:13305', priority: 30, selectedModel: '*' }
      },
      {
        id: 'observability-1',
        type: 'observabilityNode',
        position: { x: 1600, y: 160 },
        data: { projectName: 'eluvix-audit-debug', captureInputs: true }
      }
    ],
    edges: [
      { id: 'e-in-sem', source: 'input-1', target: 'semantic-guard-debug', animated: true, style: { stroke: '#f97316' } },
      { id: 'e-sem-priv', source: 'semantic-guard-debug', sourceHandle: 'match', target: 'privacy-guard-debug', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-priv-sw', source: 'privacy-guard-debug', sourceHandle: 'clean', target: 'switchyard-1', animated: true, style: { stroke: '#3b82f6' } },
      { id: 'e-sw-lem', source: 'switchyard-1', sourceHandle: 'tier-1', target: 'lemonade-1', animated: true, style: { stroke: '#10b981' } },
      { id: 'e-lem-obs', source: 'lemonade-1', target: 'observability-1', animated: true, style: { stroke: '#6366f1' } }
    ]
  }
];
