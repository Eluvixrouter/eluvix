import type { RouterConfig } from '@eluvix/router-core';

export type DockerServiceCategory = 'core' | 'inference' | 'memory' | 'harnesses';

export interface DockerCatalogEntry {
  name: string;
  container: string;
  port: number;
  category: DockerServiceCategory;
  composeFile: string;
  description: string;
  defaultSelected?: boolean;
}

export const DOCKER_SERVICE_CATALOG: DockerCatalogEntry[] = [
  {
    name: 'switchyard',
    container: 'eluvix-switchyard',
    port: 8080,
    category: 'core',
    composeFile: 'docker/compose/core.yml',
    description: 'Complexity & cost routing proxy',
    defaultSelected: true
  },
  {
    name: 'vllm-sr',
    container: 'eluvix-vllm-sr',
    port: 8001,
    category: 'core',
    composeFile: 'docker/compose/core.yml',
    description: 'Semantic router & intent classifier',
    defaultSelected: true
  },
  {
    name: 'agent-router',
    container: 'eluvix-agent-router',
    port: 8002,
    category: 'core',
    composeFile: 'docker/compose/core.yml',
    description: 'Task & sub-agent dispatcher',
    defaultSelected: true
  },
  {
    name: 'agentgateway',
    container: 'eluvix-agentgateway',
    port: 8003,
    category: 'core',
    composeFile: 'docker/compose/core.yml',
    description: 'MCP tool & agent protocol gateway',
    defaultSelected: true
  },
  {
    name: 'ollama',
    container: 'eluvix-ollama',
    port: 11434,
    category: 'inference',
    composeFile: 'docker/compose/inference.yml',
    description: 'Local GGUF model runner',
    defaultSelected: true
  },
  {
    name: 'vllm',
    container: 'eluvix-vllm',
    port: 8000,
    category: 'inference',
    composeFile: 'docker/compose/inference.yml',
    description: 'High-throughput GPU inference server',
    defaultSelected: false
  },
  {
    name: 'openviking',
    container: 'eluvix-openviking',
    port: 1933,
    category: 'memory',
    composeFile: 'docker/compose/memory.yml',
    description: 'Hierarchical L0/L1/L2 memory sidecar',
    defaultSelected: true
  },
  {
    name: 'lightrag',
    container: 'eluvix-lightrag',
    port: 9621,
    category: 'memory',
    composeFile: 'docker/compose/memory.yml',
    description: 'Dual-level GraphRAG & document index',
    defaultSelected: false
  },
  {
    name: 'graphiti',
    container: 'eluvix-graphiti',
    port: 8004,
    category: 'memory',
    composeFile: 'docker/compose/memory.yml',
    description: 'Temporal knowledge graph memory',
    defaultSelected: false
  },
  {
    name: 'trueforge',
    container: 'eluvix-trueforge',
    port: 8790,
    category: 'harnesses',
    composeFile: 'docker/compose/harnesses.yml',
    description: 'TrueForge stateful agent harness',
    defaultSelected: true
  },
  {
    name: 'sandbox',
    container: 'eluvix-sandbox',
    port: 3986,
    category: 'harnesses',
    composeFile: 'docker/compose/harnesses.yml',
    description: 'Isolated VM code execution sandbox',
    defaultSelected: false
  }
];

export const COMPOSE_MODULE_FILES = [
  'docker-compose.yml',
  'docker/compose/core.yml',
  'docker/compose/inference.yml',
  'docker/compose/memory.yml',
  'docker/compose/harnesses.yml'
];

export function getServicesByCategory(category: DockerServiceCategory): string[] {
  return DOCKER_SERVICE_CATALOG.filter((s) => s.category === category).map((s) => s.name);
}

/**
 * Inspects an active RouterConfig and returns the set of Docker service names
 * that are directly referenced by its upstreams, memory provider, knowledge base, or sandbox.
 */
export function getRequiredServicesForConfig(config?: RouterConfig | null): string[] {
  if (!config) return ['switchyard', 'ollama'];
  const needed = new Set<string>();

  for (const u of config.upstreams || []) {
    const ep = (u.endpoint || '').toLowerCase();
    if (u.type === 'ollama' || ep.includes(':11434') || ep.includes('ollama')) {
      needed.add('ollama');
    }
    if (u.type === 'vllm' || ep.includes(':8000')) {
      needed.add('vllm');
    }
    if (ep.includes(':8080') || ep.includes('switchyard')) {
      needed.add('switchyard');
    }
    if (ep.includes(':8001') || ep.includes('vllm-sr')) {
      needed.add('vllm-sr');
    }
    if (ep.includes(':8002') || ep.includes('agent-router')) {
      needed.add('agent-router');
    }
    if (ep.includes(':8003') || ep.includes('agentgateway')) {
      needed.add('agentgateway');
    }
    if (u.type === 'harness') {
      const kind = u.harness?.kind || 'trueforge';
      if (kind === 'trueforge' || ep.includes(':8790')) {
        needed.add('trueforge');
      }
      if (u.harness?.sandboxEndpoint || u.harness?.sandboxType === 'docker-local') {
        needed.add('sandbox');
      }
    }
  }

  if (config.memory?.enabled) {
    const prov = config.memory.provider || 'builtin';
    if (prov === 'openviking') needed.add('openviking');
    if (prov === 'lightrag') needed.add('lightrag');
    if (prov === 'graphiti') needed.add('graphiti');
  }

  const anyConfig = config as any;
  if (anyConfig.knowledge?.enabled) {
    if (anyConfig.knowledge.backend === 'openviking-resources') needed.add('openviking');
    if (anyConfig.knowledge.backend === 'lightrag') needed.add('lightrag');
  }
  if (anyConfig.sandbox?.enabled && anyConfig.sandbox?.runtime === 'docker-local') {
    needed.add('sandbox');
  }

  if (needed.size === 0) {
    needed.add('switchyard');
  }

  return Array.from(needed);
}
