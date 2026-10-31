"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import LogViewer from './LogViewer';
import {
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  Connection,
  Edge,
  Node
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import InputNode from './nodes/InputNode';
import AgentNode from './nodes/AgentNode';
import SwitchyardNode from './nodes/SwitchyardNode';
import SemanticGuardNode from './nodes/SemanticGuardNode';
import TaskRouterNode from './nodes/TaskRouterNode';
import AgentGatewayNode from './nodes/AgentGatewayNode';
import McpToolNode from "./nodes/McpToolNode";
import ModelGatewayNode from './nodes/ModelGatewayNode';
import ObservabilityNode from './nodes/ObservabilityNode';
import PrivacyGuardNode from './nodes/PrivacyGuardNode';
import LemonadeNode from './nodes/LemonadeNode';
import VllmNode from './nodes/VllmNode';
import SglangNode from './nodes/SglangNode';
import OllamaNode from './nodes/OllamaNode';
import AntigravityNode from './nodes/AntigravityNode';
import CodexNode from './nodes/CodexNode';
import ClaudeCodeNode from './nodes/ClaudeCodeNode';
import BillamaNode from './nodes/BillamaNode';
import OpenAiNode from './nodes/OpenAiNode';
import ClaudeNode from './nodes/ClaudeNode';
import MemoryNode from './nodes/MemoryNode';
import HarnessNode from './nodes/HarnessNode';
import SandboxNode from './nodes/SandboxNode';
import KnowledgeBaseNode from './nodes/KnowledgeBaseNode';
import SemanticCacheNode from './nodes/SemanticCacheNode';
import ConsensusNode from './nodes/ConsensusNode';
import FallbackChainNode from './nodes/FallbackChainNode';
import ConfidentialEnclaveNode from './nodes/ConfidentialEnclaveNode';
import { compileGraph } from '@/lib/orchestration/compiler';
import { diffRouterConfigs, type ConfigDiff } from '@/lib/config-diff';
import SaveAsModal from './SaveAsModal';
import LayoutBrowserModal from './LayoutBrowserModal';
import { LayoutMetadata } from '@/lib/layouts/types';

const DEFAULT_NODE_DATA: Record<string, any> = {
  memoryNode: {
    label: 'OpenViking Context & Memory',
    provider: 'openviking',
    endpoint: 'http://localhost:1933',
    recallBudgetTokens: 600,
    readingLevel: 'L1',
    writeBack: true,
    allowCloudEgress: false,
    cloudMode: 'filter'
  },
  harnessNode: {
    label: 'TrueForge Agent Harness',
    kind: 'trueforge',
    endpoint: 'http://localhost:8790',
    agentId: 'default',
    approvals: 'auto-approve-readonly',
    sessionMode: 'per-eluvix-session',
    priority: 30
  },
  sandboxNode: {
    label: 'Execution Sandbox',
    sandboxType: 'docker-exec',
    endpoint: 'http://localhost:3986',
    timeoutMs: 30000,
    memoryLimitMb: 512,
    networkPolicy: 'none',
    autoCleanup: true
  },
  knowledgeBaseNode: {
    label: 'Knowledge Base (RAG)',
    backend: 'lightrag',
    endpoint: 'http://localhost:9621',
    collectionUri: 'viking://resources/docs',
    retrievalMode: 'hybrid',
    citationMode: 'bracket',
    topK: 5,
    maxTokens: 1200,
    minScore: 0.65
  },
  semanticCacheNode: {
    label: 'Semantic Cache',
    backend: 'sqlite-fts',
    endpoint: 'http://localhost:6333',
    mode: 'exact',
    scopeIsolation: 'user',
    similarityThreshold: 0.94,
    ttlSeconds: 3600,
    scopeByUser: true,
    bypassOnTools: true
  },
  consensusNode: {
    label: 'Consensus Judge / Arena',
    mode: 'judge',
    strategy: 'parallel-judge',
    minQuorum: 2,
    candidateCount: 3,
    judgeModel: 'auto',
    timeoutMs: 45000,
    rubric: 'accuracy-conciseness'
  },
  fallbackChainNode: {
    label: 'Resilient Fallback Chain',
    failureThreshold: 3,
    cooldownSeconds: 30,
    hedgeDelayMs: 0,
    retryOn429: true,
    retryOn5xx: true
  },
  confidentialEnclaveNode: {
    label: 'Confidential Silicon Enclave',
    architecture: 'sev-snp-h100-cc',
    confidentialPolicy: 'require-dual-attestation',
    kbsEndpoint: 'https://kbs.internal.corp:8080',
    expectedMeasurement: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    restrictedInjection: true,
    spdmAttested: true
  },
  lemonadeNode: {
    label: 'Lemonade Engine',
    endpoint: 'http://localhost:13305',
    priority: 25,
    selectedModel: '*',
    maxContextTokens: 32768,
    maxParallelRequests: 4
  },
  vllmNode: {
    label: 'vLLM Engine',
    endpoint: 'http://localhost:8000',
    priority: 22,
    selectedModel: '*',
    maxContextTokens: 32768,
    maxParallelRequests: 8
  },
  sglangNode: {
    label: 'SGLang Engine',
    endpoint: 'http://localhost:30000',
    priority: 24,
    selectedModel: '*',
    maxContextTokens: 32768,
    maxParallelRequests: 8,
    disaggregation: {
      role: 'colocated',
      kvConnector: 'mooncake',
      kvCacheDtype: 'fp8_e4m3',
      tensorParallelSize: 4,
      rdmaDevice: 'mlx5_0'
    }
  },
  ollamaNode: {
    label: 'Ollama Engine',
    endpoint: 'http://localhost:11434',
    priority: 20,
    selectedModel: '*',
    maxContextTokens: 16384,
    maxParallelRequests: 2
  },
  semanticGuardNode: {
    routeName: 'prompt-injection-defense',
    encoder: 'deberta-v3-injection',
    threshold: 0.85,
    enforcementAction: 'block',
    threatVectors: {
      instructionOverride: true,
      danJailbreak: true,
      systemPromptLeak: true,
      obfuscation: true
    },
    bannedPhrases: []
  },
  privacyGuardNode: {
    action: 'anonymize',
    redactionStyle: 'token',
    whitelist: [],
    customPatterns: [],
    auditLogging: false,
    detectPii: {
      apiKey: true,
      ssn: true,
      creditCard: true,
      email: true,
      phone: true,
      ipAddress: true
    }
  },
  switchyardNode: { 
    strategy: 'cost-complexity', 
    failover: 'enabled',
    timeoutMs: 60000,
    retryCount: 1,
    spilloverThresholdMs: 30000,
    codeEscalation: true,
    complexityThresholds: { moderate: 300, heavy: 1500, frontier: 6000 },
    maxCostPerRequest: 0.05
  },
  taskRouterNode: {
    label: 'Task Router',
    preference: 'balanced',
    classificationEngine: 'heuristic',
    confidenceThreshold: 0.85,
    routes: [
      { id: 'intent-code', name: 'Code & Dev' },
      { id: 'intent-reasoning', name: 'Reasoning & Math' },
      { id: 'intent-fast', name: 'Fast Chit-Chat' },
      { id: 'intent-tools', name: 'Tool Dispatch' },
      { id: 'intent-default', name: 'Fallback' }
    ]
  },
  modelGatewayNode: {
    label: 'Model Gateway',
    primaryModel: 'meta-llama/Llama-3-8b',
    fallbackStrategy: 'cheaper',
    cacheEnabled: true,
    cacheTtlSeconds: 3600,
    cacheSimilarityThreshold: 0.95,
    rateLimitRpm: 60,
    systemPromptPrepend: ''
  },
  agentGatewayNode: {
    label: 'Agent Gateway',
    accessPolicy: 'restrictive',
    toolFilterMode: 'all',
    toolTimeoutMs: 10000,
    sanitizeToolOutput: true,
    vaultSecret: ''
  },
  mcpToolNode: {
    label: 'MCP Tool',
    toolName: 'read_resource',
    mcpEndpoint: 'http://localhost:3588/sse',
    executionMode: 'auto',
    timeoutMs: 15000
  },
  observabilityNode: {
    label: 'Observability Sink',
    projectName: 'eluvix-production',
    exporter: 'sqlite',
    endpointUrl: '',
    samplingRate: 100,
    scrubPii: true,
    latencyAlertMs: 5000,
    captureInputs: true
  },
  agentNode: {
    label: 'ReAct Agent',
    persona: 'Software Architect',
    capability: 'general',
    temperature: 0.7,
    maxTokens: 4096,
    memory: true,
    systemInstructions: 'You are an autonomous ReAct agent with tool execution capabilities.'
  },
  antigravityNode: {
    label: 'Antigravity Agent',
    model: 'gemini-3.8-flash',
    effort: 'auto',
    cleanHeadless: true,
    executionMode: 'cli',
    cliPath: 'agy',
    endpoint: 'cli://agy',
    sandboxMode: 'standard',
    agentBehavior: 'autonomous',
    networkAccess: false,
    workspaceIsolation: true,
    enableWriteTools: true,
    enableMcpTools: true,
    enableSubagents: true,
    maxSubagentDepth: 2,
    enableWebTools: true,
    enableGenerativeUI: true,
    extendedThinking: true,
    thinkingBudget: 2048,
    persona: 'software-engineer',
    systemInstructions: 'You are an expert autonomous software engineer pair-programming to build production features.'
  },
  codexNode: {
    label: 'OpenAI Codex',
    model: 'o3-mini',
    reasoningEffort: 'medium',
    environment: 'local-sandbox',
    approvalMode: 'confirm-risky',
    workingDirectory: './workspace',
    enableCodeInterpreter: true,
    enableBash: true,
    enableFileEditor: true,
    enableWebBrowsing: true,
    persona: 'codex-engineer',
    systemInstructions: 'You are OpenAI Codex, a premier autonomous software engineer specialized in rigorous refactoring, testing, and debugging.'
  },
  claudeCodeNode: {
    label: 'Claude Code Agent',
    model: 'claude-3-7-sonnet',
    extendedThinking: true,
    thinkingBudget: 4096,
    permissionMode: 'accept-non-destructive',
    compactContext: true,
    enableBashTool: true,
    enableFileEditTool: true,
    enableGrepTool: true,
    enableWebFetchTool: true,
    enableSubagents: true,
    maxSubagentDepth: 2,
    persona: 'claude-architect',
    systemInstructions: 'You are Claude Code, an elite agentic software engineer using terminal, ripgrep, and file editing tools to solve complex code problems.'
  },
  billamaNode: {
    label: 'Billama Cloud',
    endpoint: 'https://api.billama.dev',
    priority: 15,
    costPer1kTokens: 0.002,
    selectedModel: '*',
    visionCapable: true,
    maxContextTokens: 128000,
    maxParallelRequests: 10,
    monthlySpendLimit: 50
  },
  openaiNode: {
    label: 'OpenAI Direct',
    endpoint: 'https://api.openai.com/v1',
    priority: 10,
    costPer1kTokens: 0.005,
    selectedModel: '*',
    visionCapable: true,
    maxContextTokens: 128000,
    maxParallelRequests: 10,
    monthlySpendLimit: 100
  },
  claudeNode: {
    label: 'Anthropic Claude',
    endpoint: 'https://api.anthropic.com/v1',
    priority: 10,
    costPer1kTokens: 0.003,
    selectedModel: 'claude-3-7-sonnet',
    visionCapable: true,
    maxContextTokens: 200000,
    maxParallelRequests: 5,
    monthlySpendLimit: 100
  }
};

const initialNodes: Node[] = [
  {
    id: 'input-1',
    type: 'inputNode',
    position: { x: 50, y: 220 },
    data: { label: 'Client Input' },
  },
  {
    id: 'privacy-guard-1',
    type: 'privacyGuardNode',
    position: { x: 300, y: 120 },
    data: { ...DEFAULT_NODE_DATA.privacyGuardNode },
  },
  {
    id: 'semantic-guard-1',
    type: 'semanticGuardNode',
    position: { x: 620, y: 120 },
    data: { ...DEFAULT_NODE_DATA.semanticGuardNode },
  },
  {
    id: 'switchyard-1',
    type: 'switchyardNode',
    position: { x: 920, y: 180 },
    data: {
      strategy: 'cost-complexity',
      failover: 'enabled',
      timeoutMs: 60000,
      retryCount: 1,
      spilloverThresholdMs: 30000,
      codeEscalation: true,
      complexityThresholds: { moderate: 300, heavy: 1500, frontier: 6000 },
      maxCostPerRequest: 0.05
    },
  },
  {
    id: 'lemonade-1',
    type: 'lemonadeNode',
    position: { x: 1300, y: 30 },
    data: {
      label: 'Lemonade Engine',
      endpoint: 'http://localhost:13305',
      priority: 30,
      selectedModel: '*'
    },
  },
  {
    id: 'ollama-1',
    type: 'ollamaNode',
    position: { x: 1300, y: 210 },
    data: {
      label: 'Ollama Engine',
      endpoint: 'http://localhost:11434',
      priority: 25,
      selectedModel: '*'
    },
  },
  {
    id: 'antigravity-1',
    type: 'antigravityNode',
    position: { x: 1300, y: 330 },
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
    },
  },
  {
    id: 'claude-code-1',
    type: 'claudeCodeNode',
    position: { x: 1300, y: 490 },
    data: {
      label: 'Claude Code Agent',
      model: 'claude-3-7-sonnet',
      permissionMode: 'accept-non-destructive',
      extendedThinking: true,
      thinkingBudget: 4096,
      persona: 'claude-architect'
    },
  },
  {
    id: 'observability-1',
    type: 'observabilityNode',
    position: { x: 1760, y: 240 },
    data: {
      projectName: 'eluvix-production',
      captureInputs: true
    },
  }
];

const initialEdges: Edge[] = [
  {
    id: 'e-in-privacy',
    source: 'input-1',
    target: 'privacy-guard-1',
    animated: true,
    style: { stroke: '#10b981', strokeWidth: 3.5 }
  },
  {
    id: 'e-privacy-semantic',
    source: 'privacy-guard-1',
    sourceHandle: 'clean',
    target: 'semantic-guard-1',
    animated: true,
    style: { stroke: '#f97316', strokeWidth: 3.5 }
  },
  {
    id: 'e-semantic-switchyard',
    source: 'semantic-guard-1',
    sourceHandle: 'match',
    target: 'switchyard-1',
    animated: true,
    style: { stroke: '#3b82f6', strokeWidth: 3.5 }
  },
  {
    id: 'e-switchyard-lemonade',
    source: 'switchyard-1',
    sourceHandle: 'tier-1',
    target: 'lemonade-1',
    animated: true,
    style: { stroke: '#10b981', strokeWidth: 3.5 }
  },
  {
    id: 'e-switchyard-ollama',
    source: 'switchyard-1',
    sourceHandle: 'tier-2',
    target: 'ollama-1',
    animated: true,
    style: { stroke: '#eab308', strokeWidth: 3.5 }
  },
  {
    id: 'e-switchyard-antigravity',
    source: 'switchyard-1',
    sourceHandle: 'tier-3',
    target: 'antigravity-1',
    animated: true,
    style: { stroke: '#06b6d4', strokeWidth: 3.5 }
  },
  {
    id: 'e-switchyard-claude',
    source: 'switchyard-1',
    sourceHandle: 'tier-4',
    target: 'claude-code-1',
    animated: true,
    style: { stroke: '#f59e0b', strokeWidth: 3.5 }
  },
  {
    id: 'e-lemonade-obs',
    source: 'lemonade-1',
    target: 'observability-1',
    animated: true,
    style: { stroke: '#10b981', strokeWidth: 3.5 }
  },
  {
    id: 'e-ollama-obs',
    source: 'ollama-1',
    target: 'observability-1',
    animated: true,
    style: { stroke: '#eab308', strokeWidth: 3.5 }
  },
  {
    id: 'e-antigravity-obs',
    source: 'antigravity-1',
    sourceHandle: 'output',
    target: 'observability-1',
    animated: true,
    style: { stroke: '#06b6d4', strokeWidth: 3.5 }
  },
  {
    id: 'e-claude-obs',
    source: 'claude-code-1',
    sourceHandle: 'output',
    target: 'observability-1',
    animated: true,
    style: { stroke: '#f59e0b', strokeWidth: 3.5 }
  }
];

const nodeTypes = {
  inputNode: InputNode,
  agentNode: AgentNode,
  switchyardNode: SwitchyardNode,
  semanticGuardNode: SemanticGuardNode,
  privacyGuardNode: PrivacyGuardNode,
  taskRouterNode: TaskRouterNode,
  agentGatewayNode: AgentGatewayNode,
  mcpToolNode: McpToolNode,
  modelGatewayNode: ModelGatewayNode,
  observabilityNode: ObservabilityNode,
  lemonadeNode: LemonadeNode,
  vllmNode: VllmNode,
  sglangNode: SglangNode,
  ollamaNode: OllamaNode,
  antigravityNode: AntigravityNode,
  codexNode: CodexNode,
  claudeCodeNode: ClaudeCodeNode,
  billamaNode: BillamaNode,
  openaiNode: OpenAiNode,
  claudeNode: ClaudeNode,
  memoryNode: MemoryNode,
  harnessNode: HarnessNode,
  sandboxNode: SandboxNode,
  knowledgeBaseNode: KnowledgeBaseNode,
  semanticCacheNode: SemanticCacheNode,
  consensusNode: ConsensusNode,
  fallbackChainNode: FallbackChainNode,
  confidentialEnclaveNode: ConfidentialEnclaveNode,
};

let id = 0;
const getId = () => `dndnode_${id++}`;

function advanceIdCounter(nodes: Node[]) {
  let maxFound = 0;
  for (const node of nodes) {
    const matches = node.id.match(/\d+/g);
    if (matches) {
      for (const m of matches) {
        const num = parseInt(m, 10);
        if (!isNaN(num) && num > maxFound) {
          maxFound = num;
        }
      }
    }
  }
  if (maxFound >= id) {
    id = maxFound + 1;
  }
}

function sanitizeNodeDataForSnapshot(data: any) {
  if (!data || typeof data !== 'object') return data;
  // Ignore ephemeral scan states that should not trigger unsaved dirty warnings
  const copy = { ...data };
  delete copy.status;
  delete copy.models;
  delete copy.modelDetails;
  return copy;
}

function computeGraphSnapshot(nds: Node[], eds: Edge[]) {
  return JSON.stringify({
    nodes: nds.map((n) => ({ id: n.id, type: n.type, position: n.position, data: sanitizeNodeDataForSnapshot(n.data) })),
    edges: eds.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle }))
  });
}

export default function RoutingEditor() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);
  
  // Layout Management State
  const [currentSlug, setCurrentSlug] = useState<string>('default');
  const [currentName, setCurrentName] = useState<string>('Full Production Stack');
  const [currentDescription, setCurrentDescription] = useState<string>('');
  const [currentCategory, setCurrentCategory] = useState<string>('starter');
  const [currentTags, setCurrentTags] = useState<string[]>([]);
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState<string>('');
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [layoutsList, setLayoutsList] = useState<LayoutMetadata[]>([]);
  const [layoutsDir, setLayoutsDir] = useState<string>('~/.config/eluvix/layouts');
  const [isLayoutBrowserOpen, setIsLayoutBrowserOpen] = useState<boolean>(false);
  const [isSaveAsOpen, setIsSaveAsOpen] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [compiledConfigs, setCompiledConfigs] = useState<any>(null);
  const [pendingApply, setPendingApply] = useState<any>(null);
  const [applyDiff, setApplyDiff] = useState<ConfigDiff | null>(null);
  const [applyDiffKnown, setApplyDiffKnown] = useState(true);
  // Which authoritative write the diff confirmation gates: an editor Apply,
  // or a LOCAL-tier deploy (deployLocal rewrites the same live config file).
  const [confirmAction, setConfirmAction] = useState<'apply' | 'deploy' | null>(null);
  const [pendingDeploy, setPendingDeploy] = useState(false);
  const [availableSecrets, setAvailableSecrets] = useState<{key: string, path: string}[]>([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{success?: boolean, message?: string} | null>(null);
  const [selectedTier, setSelectedTier] = useState<'k3d' | 'compose' | 'docker' | 'local'>('k3d');
  const [orchestratorStatus, setOrchestratorStatus] = useState<any>(null);
  const [deployLogs, setDeployLogs] = useState<string[]>([]);
  const [isCreatingCluster, setIsCreatingCluster] = useState(false);

  const [selectedLogContainer, setSelectedLogContainer] = useState<string | null>(null);

  const handleNodeClick = useCallback((event: any, node: Node) => {
    switch (node.type) {
      case 'switchyardNode': setSelectedLogContainer('switchyard'); break;
      case 'semanticGuardNode': setSelectedLogContainer('vllm-sr'); break;
      case 'ollamaNode': setSelectedLogContainer('ollama'); break;
      case 'vllmNode': setSelectedLogContainer('vllm'); break;
      case 'sglangNode': setSelectedLogContainer('sglang'); break;
      case 'taskRouterNode': setSelectedLogContainer('agent-router'); break;
      case 'agentGatewayNode': setSelectedLogContainer('agentgateway'); break;
      case 'memoryNode': {
        const p = String((node.data as any)?.provider || 'openviking');
        setSelectedLogContainer(p === 'graphiti' ? 'graphiti' : p === 'lightrag' ? 'lightrag' : 'openviking');
        break;
      }
      case 'harnessNode': {
        const k = String((node.data as any)?.kind || 'trueforge');
        setSelectedLogContainer(k === 'openhands' ? 'openhands' : k === 'letta' ? 'letta' : 'trueforge');
        break;
      }
      case 'sandboxNode': setSelectedLogContainer('sandbox'); break;
      case 'knowledgeBaseNode': setSelectedLogContainer('lightrag'); break;
      default: break;
    }
  }, []);


  useEffect(() => {
    fetch('/api/secrets/discover')
      .then(res => res.json())
      .then(data => {
        if (data.secrets) {
          setAvailableSecrets(data.secrets);
        }
      })
      .catch(err => console.error("Failed to fetch openbao secrets", err));
  }, []);

  const deleteSelectedNode = useCallback((nodeId?: string) => {
    const targetId = nodeId || nodes.find(n => n.selected)?.id;
    if (!targetId) return;
    setNodes(nds => nds.filter(n => n.id !== targetId));
    setEdges(eds => eds.filter(e => e.source !== targetId && e.target !== targetId));
  }, [nodes, setNodes, setEdges]);

  const onNodesDelete = useCallback((deletedNodes: Node[]) => {
    const deletedIds = new Set(deletedNodes.map(n => n.id));
    setEdges(eds => eds.filter(e => !deletedIds.has(e.source) && !deletedIds.has(e.target)));
  }, [setEdges]);

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 3500);
  }, []);

  // Keep the latest React Flow instance in a ref so callbacks stay stable.
  const rfInstanceRef = useRef<any>(null);
  const pendingViewportRef = useRef<any>(null);
  const handleInit = useCallback((instance: any) => {
    rfInstanceRef.current = instance;
    setReactFlowInstance(instance);
    if (pendingViewportRef.current) {
      instance.setViewport(pendingViewportRef.current);
      pendingViewportRef.current = null;
    }
  }, []);
  const applyViewport = (viewport: any) => {
    if (!viewport) return;
    if (rfInstanceRef.current) rfInstanceRef.current.setViewport(viewport);
    else pendingViewportRef.current = viewport;
  };

  // Whether the current canvas is backed by a file on disk (false for New / Import).
  const [isPersisted, setIsPersisted] = useState<boolean>(true);
  const isDirtyRef = useRef(false);
  useEffect(() => { isDirtyRef.current = isDirty; }, [isDirty]);

  const confirmDiscard = useCallback((action: string) => {
    if (!isDirtyRef.current) return true;
    return confirm(`You have unsaved changes. Discard them and ${action}?`);
  }, []);

  const fetchLayoutsList = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/layouts');
      if (res.ok) {
        const data = await res.json();
        setLayoutsList(data.layouts || []);
        if (data.layoutsDir) setLayoutsDir(data.layoutsDir);
        return data;
      }
    } catch (err) {
      console.error('Failed to fetch layouts list:', err);
    }
    return null;
  }, []);

  const applyLayout = useCallback((layout: any, persisted: boolean) => {
    advanceIdCounter(layout.nodes || []);
    setNodes(layout.nodes || []);
    setEdges(layout.edges || []);
    setCurrentSlug(layout.id);
    setCurrentName(layout.name || layout.id);
    setCurrentDescription(layout.description || '');
    setCurrentCategory(layout.category || 'custom');
    setCurrentTags(layout.tags || []);
    setLastSavedSnapshot(computeGraphSnapshot(layout.nodes || [], layout.edges || []));
    setIsDirty(false);
    setIsPersisted(persisted);
    applyViewport(layout.viewport);
  }, [setNodes, setEdges]);

  const loadLayoutBySlug = useCallback(async (slug: string, opts: { activate?: boolean; skipConfirm?: boolean; silent?: boolean } = {}) => {
    const { activate = true, skipConfirm = false, silent = false } = opts;
    if (!skipConfirm && !confirmDiscard(`open "${slug}"`)) return;
    try {
      const res = await fetch(`/api/v1/layouts/${encodeURIComponent(slug)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to load layout');
      }
      const { layout } = await res.json();
      if (!layout) return;
      applyLayout(layout, true);
      if (activate) {
        fetch('/api/v1/layouts/active', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: layout.id })
        }).catch(() => {});
      }
      if (!silent) showToast(`Loaded layout "${layout.name || layout.id}"`);
    } catch (err: any) {
      console.error(`Error loading layout ${slug}:`, err);
      showToast(`Error: ${err.message}`);
    }
  }, [applyLayout, confirmDiscard, showToast]);

  // Initial load: run exactly once.
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    (async () => {
      const data = await fetchLayoutsList();
      if (data?.activeSlug) {
        await loadLayoutBySlug(data.activeSlug, { activate: false, skipConfirm: true, silent: true });
      } else {
        setLastSavedSnapshot(computeGraphSnapshot(initialNodes, initialEdges));
      }
    })();
  }, [fetchLayoutsList, loadLayoutBySlug]);

  // Track dirty changes
  useEffect(() => {
    if (!lastSavedSnapshot) return;
    setIsDirty(computeGraphSnapshot(nodes, edges) !== lastSavedSnapshot);
  }, [nodes, edges, lastSavedSnapshot]);

  // Warn before closing the tab with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const handleFastSave = useCallback(async () => {
    if (!isPersisted || !currentSlug) {
      setIsSaveAsOpen(true);
      return;
    }
    try {
      const viewport = rfInstanceRef.current?.toObject()?.viewport;
      const res = await fetch(`/api/v1/layouts/${encodeURIComponent(currentSlug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: currentName,
          description: currentDescription,
          category: currentCategory,
          tags: currentTags,
          nodes,
          edges,
          viewport
        })
      });
      if (res.status === 404) {
        setIsPersisted(false);
        setIsSaveAsOpen(true);
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save');
      }
      setLastSavedSnapshot(computeGraphSnapshot(nodes, edges));
      setIsDirty(false);
      await fetchLayoutsList();
      showToast(`Saved to ${layoutsDir}/${currentSlug}.json`);
    } catch (err: any) {
      showToast(`Save failed: ${err.message}`);
    }
  }, [isPersisted, currentSlug, currentName, currentDescription, currentCategory, currentTags, nodes, edges, layoutsDir, fetchLayoutsList, showToast]);

  const handleSaveAs = useCallback(async (data: {
    name: string;
    slug: string;
    description: string;
    category: string;
    tags: string[];
    overwrite: boolean;
  }) => {
    const viewport = rfInstanceRef.current?.toObject()?.viewport;
    const res = await fetch('/api/v1/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, nodes, edges, viewport, setActive: true })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to save new layout');
    }
    const { layout: saved } = await res.json();
    setCurrentSlug(saved.id);
    setCurrentName(saved.name);
    setCurrentDescription(saved.description || '');
    setCurrentCategory(saved.category || 'custom');
    setCurrentTags(saved.tags || []);
    setLastSavedSnapshot(computeGraphSnapshot(nodes, edges));
    setIsDirty(false);
    setIsPersisted(true);
    await fetchLayoutsList();
    showToast(`Created layout ${layoutsDir}/${saved.id}.json`);
  }, [nodes, edges, layoutsDir, fetchLayoutsList, showToast]);

  const handleDeleteLayout = useCallback(async (slug: string) => {
    if (slug === currentSlug && !confirmDiscard('delete the open layout')) return;
    const res = await fetch(`/api/v1/layouts/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to delete layout');
    }
    await fetchLayoutsList();
    if (currentSlug === slug) {
      await loadLayoutBySlug('default', { skipConfirm: true });
    }
    showToast(`Deleted layout ${slug}.json`);
  }, [currentSlug, confirmDiscard, fetchLayoutsList, loadLayoutBySlug, showToast]);

  const handleDuplicateLayout = useCallback(async (sourceSlug: string) => {
    if (!confirmDiscard(`duplicate "${sourceSlug}"`)) return;
    const res = await fetch(`/api/v1/layouts/${encodeURIComponent(sourceSlug)}`);
    if (!res.ok) throw new Error('Could not read source layout');
    const { layout } = await res.json();

    // Find a free slug: <base>-copy, <base>-copy-2, ... (max 64 chars)
    const taken = new Set(layoutsList.map(l => l.id));
    let targetSlug = '';
    for (let i = 1; i < 1000; i++) {
      const suffix = i === 1 ? '-copy' : `-copy-${i}`;
      const candidate = `${sourceSlug.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!taken.has(candidate)) { targetSlug = candidate; break; }
    }
    if (!targetSlug) throw new Error('Could not find a free slug for the copy');

    const createRes = await fetch('/api/v1/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: targetSlug,
        name: `${layout.name} (Copy)`,
        description: layout.description,
        category: 'custom',
        tags: layout.tags,
        nodes: layout.nodes,
        edges: layout.edges,
        viewport: layout.viewport,
        setActive: true
      })
    });
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to duplicate layout');
    }
    await fetchLayoutsList();
    await loadLayoutBySlug(targetSlug, { skipConfirm: true, silent: true });
    showToast(`Duplicated to ${targetSlug}.json`);
  }, [layoutsList, confirmDiscard, fetchLayoutsList, loadLayoutBySlug, showToast]);

  const handleRestoreExamples = useCallback(async () => {
    const res = await fetch('/api/v1/layouts/restore-examples', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to restore example layouts');
    }
    const result = await res.json();
    const list = await fetchLayoutsList();
    const activeIsExample = (result.overwritten || []).includes(currentSlug) ||
      list?.layouts?.some((l: LayoutMetadata) => l.id === currentSlug && l.isExample);
    if (activeIsExample && isPersisted) {
      await loadLayoutBySlug(currentSlug, { activate: false, silent: true });
    }
    showToast(`Restored ${result.count} example templates`);
  }, [currentSlug, isPersisted, fetchLayoutsList, loadLayoutBySlug, showToast]);

  const handleNewCanvas = useCallback(() => {
    if (!confirmDiscard('create a new canvas')) return;
    const starterNodes: Node[] = [
      { id: 'input-1', type: 'inputNode', position: { x: 100, y: 200 }, data: { label: 'Client Input' } },
      { id: 'switchyard-1', type: 'switchyardNode', position: { x: 450, y: 180 }, data: { strategy: 'cost-complexity', failover: 'enabled', timeoutMs: 60000, retryCount: 1, spilloverThresholdMs: 30000, codeEscalation: true, complexityThresholds: { moderate: 300, heavy: 1500, frontier: 6000 }, maxCostPerRequest: 0.05 } }
    ];
    const starterEdges: Edge[] = [
      { id: 'e-in-sw', source: 'input-1', target: 'switchyard-1', animated: true, style: { stroke: '#3b82f6' } }
    ];
    applyLayout({ id: 'untitled-layout', name: 'Untitled Layout', category: 'custom', tags: [], nodes: starterNodes, edges: starterEdges }, false);
    // A brand-new canvas has never been saved.
    setLastSavedSnapshot('__unsaved__');
    showToast('Created new canvas');
  }, [applyLayout, confirmDiscard, showToast]);

  const handleExportJson = useCallback(() => {
    const exportPayload = {
      id: currentSlug,
      name: currentName,
      description: currentDescription,
      category: currentCategory,
      tags: currentTags,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      viewport: rfInstanceRef.current?.toObject()?.viewport,
      nodes,
      edges
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentSlug || 'routing-layout'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${currentSlug}.json`);
  }, [currentSlug, currentName, currentDescription, currentCategory, currentTags, nodes, edges, showToast]);

  const handleImportJson = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!confirmDiscard(`import ${file.name}`)) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          throw new Error('Imported JSON must contain "nodes" and "edges" arrays');
        }
        const baseSlug = String(parsed.id || file.name.replace(/\.json$/i, ''))
          .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'imported-layout';
        applyLayout({
          id: baseSlug,
          name: typeof parsed.name === 'string' ? parsed.name : baseSlug,
          description: typeof parsed.description === 'string' ? parsed.description : '',
          category: 'custom',
          tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: unknown) => typeof t === 'string') : [],
          nodes: parsed.nodes,
          edges: parsed.edges,
          viewport: parsed.viewport
        }, false);
        setLastSavedSnapshot('__unsaved__');
        showToast(`Imported layout from ${file.name} (not yet saved)`);
      } catch (err: any) {
        alert(`Invalid layout file: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }, [applyLayout, confirmDiscard, showToast]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd+S works everywhere, including inside inputs.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleFastSave();
        return;
      }
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          (active as HTMLElement).isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const selectedNodes = nodes.filter(n => n.selected);
        const selectedEdges = edges.filter(e => e.selected);
        if (selectedNodes.length > 0) {
          const selectedIds = new Set(selectedNodes.map(n => n.id));
          setNodes(nds => nds.filter(n => !selectedIds.has(n.id)));
          setEdges(eds => eds.filter(e => !selectedIds.has(e.source) && !selectedIds.has(e.target) && !e.selected));
        } else if (selectedEdges.length > 0) {
          const selectedEdgeIds = new Set(selectedEdges.map(e => e.id));
          setEdges(eds => eds.filter(e => !selectedEdgeIds.has(e.id)));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nodes, edges, setNodes, setEdges, handleFastSave]);

  const isValidConnection = useCallback(
    (connection: Edge | Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);

      if (!sourceNode || !targetNode) return false;

      // Define valid target types for each source type
      const allUpstreamTargets = ['lemonadeNode', 'vllmNode', 'sglangNode', 'ollamaNode', 'modelGatewayNode', 'billamaNode', 'openaiNode', 'claudeNode', 'antigravityNode', 'codexNode', 'claudeCodeNode', 'harnessNode', 'agentNode', 'consensusNode', 'fallbackChainNode'];
      const preRouteTargets = ['privacyGuardNode', 'semanticGuardNode', 'memoryNode', 'knowledgeBaseNode', 'semanticCacheNode', 'confidentialEnclaveNode', 'taskRouterNode', 'switchyardNode', ...allUpstreamTargets];

      const rules: Record<string, string[]> = {
        inputNode: preRouteTargets,
        privacyGuardNode: preRouteTargets,
        semanticGuardNode: preRouteTargets,
        memoryNode: [...preRouteTargets, 'observabilityNode'],
        knowledgeBaseNode: [...preRouteTargets, 'observabilityNode'],
        semanticCacheNode: [...preRouteTargets, 'observabilityNode'],
        confidentialEnclaveNode: ['switchyardNode', ...allUpstreamTargets, 'observabilityNode'],
        taskRouterNode: ['memoryNode', 'knowledgeBaseNode', 'semanticCacheNode', 'confidentialEnclaveNode', 'switchyardNode', ...allUpstreamTargets],
        agentNode: ['agentGatewayNode', 'sandboxNode', 'modelGatewayNode', 'switchyardNode', ...allUpstreamTargets, 'observabilityNode'],
        antigravityNode: ['agentGatewayNode', 'sandboxNode', 'modelGatewayNode', 'switchyardNode', ...allUpstreamTargets, 'observabilityNode'],
        codexNode: ['agentGatewayNode', 'sandboxNode', 'modelGatewayNode', 'switchyardNode', ...allUpstreamTargets, 'observabilityNode'],
        claudeCodeNode: ['agentGatewayNode', 'sandboxNode', 'modelGatewayNode', 'switchyardNode', ...allUpstreamTargets, 'observabilityNode'],
        harnessNode: ['agentGatewayNode', 'sandboxNode', 'modelGatewayNode', 'switchyardNode', ...allUpstreamTargets, 'observabilityNode'],
        sandboxNode: ['harnessNode', 'antigravityNode', 'codexNode', 'claudeCodeNode', 'agentNode', 'observabilityNode'],
        agentGatewayNode: ['switchyardNode', 'sandboxNode', ...allUpstreamTargets],
        mcpToolNode: ['agentGatewayNode'],
        modelGatewayNode: ['switchyardNode', 'observabilityNode'],
        switchyardNode: [...allUpstreamTargets, 'observabilityNode'],
        consensusNode: [...allUpstreamTargets, 'observabilityNode'],
        fallbackChainNode: [...allUpstreamTargets, 'observabilityNode'],
        lemonadeNode: ['switchyardNode', 'observabilityNode'],
        vllmNode: ['switchyardNode', 'observabilityNode'],
        sglangNode: ['switchyardNode', 'observabilityNode'],
        ollamaNode: ['switchyardNode', 'observabilityNode'],
        billamaNode: ['switchyardNode', 'observabilityNode'],
        openaiNode: ['switchyardNode', 'observabilityNode'],
        claudeNode: ['switchyardNode', 'observabilityNode'],
        observabilityNode: [] // End of the line
      };

      const allowedTargets = rules[sourceNode.type || ''] || [];
      return allowedTargets.includes(targetNode.type || '');
    },
    [nodes]
  );

  const onConnect = useCallback(
    (params: Connection) => {
      if (isValidConnection(params)) {
        setEdges((eds) =>
          addEdge(
            {
              ...params,
              animated: true,
              style: { strokeWidth: 3.5, stroke: '#38bdf8' },
            },
            eds
          )
        );
      }
    },
    [setEdges, isValidConnection]
  );

  const addNode = (type: string) => {
    const id = getId();
    const position = reactFlowInstance
      ? reactFlowInstance.screenToFlowPosition({
          x: (reactFlowWrapper.current?.clientWidth || 800) / 2 + (Math.random() * 80 - 40),
          y: (reactFlowWrapper.current?.clientHeight || 600) / 2 + (Math.random() * 80 - 40)
        })
      : { x: 500, y: 300 };

    const newNode = {
      id,
      type,
      position,
      data: DEFAULT_NODE_DATA[type] ? { ...DEFAULT_NODE_DATA[type] } : { label: `${type} node` }
    };

    setNodes((nds) => nds.concat(newNode));
  };

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow');
      if (typeof type === 'undefined' || !type) {
        return;
      }

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode = {
        id: getId(),
        type,
        position,
        data: DEFAULT_NODE_DATA[type] ? { ...DEFAULT_NODE_DATA[type] } : { label: `${type} node` },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance, setNodes]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const fetchOrchestratorStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/orchestrator/status');
      if (res.ok) {
        const data = await res.json();
        setOrchestratorStatus(data);
      }
    } catch (e) {
      console.warn('Failed to query orchestrator status:', e);
    }
  }, []);

  const handleCreateCluster = useCallback(async () => {
    setIsCreatingCluster(true);
    setDeployLogs(prev => [...prev, '🚀 Creating local k3d cluster "eluvix-local" with load balancer ports...']);
    try {
      const res = await fetch('/api/orchestrator/cluster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create' })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to create cluster');
      showToast('k3d cluster created successfully');
      setDeployLogs(prev => [...prev, data.stdout || '✓ k3d cluster created.']);
      await fetchOrchestratorStatus();
    } catch (e: any) {
      showToast(`Cluster creation failed: ${e.message}`);
      setDeployLogs(prev => [...prev, `❌ ${e.message}`]);
    } finally {
      setIsCreatingCluster(false);
    }
  }, [fetchOrchestratorStatus, showToast]);

  // Fetch the live router config and stage the diff against a candidate
  // config for the confirmation modal. Shared by Apply and LOCAL-tier
  // deploy: both perform the same authoritative write of the live config,
  // deleting every upstream that is not in the candidate.
  const prepareConfigDiff = useCallback(async (nextConfig: any) => {
    let current: any = null;
    let known = true;
    try {
      const res = await fetch('/api/v1/config');
      if (res.ok) {
        current = await res.json();
      } else {
        known = false;
      }
    } catch {
      known = false;
    }
    setApplyDiffKnown(known);
    setApplyDiff(diffRouterConfigs(current, nextConfig));
  }, []);

  const onApplyToRouter = useCallback(async () => {
    const compiled = compileGraph(nodes as any, edges as any);
    if (!compiled.rawRouterConfig) {
      setCompiledConfigs(compiled);
      setIsExportModalOpen(true);
      return;
    }
    // Authoritative apply deletes every live upstream that is not on the
    // canvas. Show the user the exact diff — especially the removals —
    // before anything is written.
    await prepareConfigDiff(compiled.rawRouterConfig);
    setConfirmAction('apply');
    setPendingApply(compiled);
  }, [nodes, edges, prepareConfigDiff]);

  const cancelApplyToRouter = useCallback(() => {
    setPendingApply(null);
    setPendingDeploy(false);
    setConfirmAction(null);
    setApplyDiff(null);
  }, []);

  const confirmApplyToRouter = useCallback(async () => {
    const compiled = pendingApply;
    if (!compiled?.rawRouterConfig) return;
    setPendingApply(null);
    setConfirmAction(null);
    setApplyDiff(null);
    setCompiledConfigs(compiled);
    setIsExportModalOpen(true);
    setDeployResult(null);
    setDeployLogs([]);
    fetchOrchestratorStatus();

    try {
      // Authoritative apply: the canvas is the source of truth for the live
      // router configuration. Upstreams that are not on the canvas are
      // removed, so deleting a node in the editor actually deletes it from
      // the router instead of silently preserving it.
      const payloadToSave = compiled.rawRouterConfig;

      const res = await fetch('/api/v1/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadToSave)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Router rejected config (HTTP ${res.status})`);
      }
      setDeployResult({ success: true, message: 'Live router configuration applied to memory.' });
      showToast('Synchronized live router configuration');
    } catch (e: any) {
      console.warn('Failed to sync live router config:', e);
      setDeployResult({ success: false, message: `Apply failed: ${e.message}` });
      showToast(`Apply failed: ${e.message}`);
    }
  }, [pendingApply, showToast, fetchOrchestratorStatus]);

  const executeDeploy = async () => {
    setIsDeploying(true);
    setDeployResult(null);
    setDeployLogs([`🚀 Deploying configuration to target: ${selectedTier.toUpperCase()}...`]);
    try {
      const res = await fetch('/api/orchestrator/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: selectedTier,
          compiledConfigs
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.message || 'Failed to deploy');
      }
      
      setDeployLogs(data.logs || []);
      setDeployResult({ success: true, message: data.message || `Successfully deployed to ${selectedTier.toUpperCase()}.` });
      showToast(`Successfully deployed to ${selectedTier.toUpperCase()}`);
      await fetchOrchestratorStatus();
    } catch (err: any) {
      setDeployResult({ success: false, message: err.message || 'Deployment error' });
      setDeployLogs(prev => [...prev, `❌ ${err.message}`]);
    } finally {
      setIsDeploying(false);
    }
  };

  // A LOCAL-tier deploy rewrites the live router config file authoritatively
  // (deployLocal) and reloads the router — the same destructive write as
  // Apply — so it goes through the same diff confirmation first. The other
  // tiers provision containers/clusters and never touch the live config,
  // so they deploy directly.
  const handleDeploy = async () => {
    if (selectedTier === 'local' && compiledConfigs?.rawRouterConfig) {
      await prepareConfigDiff(compiledConfigs.rawRouterConfig);
      setConfirmAction('deploy');
      setPendingDeploy(true);
      return;
    }
    await executeDeploy();
  };

  const confirmDeploy = async () => {
    setPendingDeploy(false);
    setConfirmAction(null);
    setApplyDiff(null);
    await executeDeploy();
  };


  return (
    <div className="flex h-full w-full bg-slate-950 text-slate-100 overflow-hidden">
      <ReactFlowProvider>
        {/* Sidebar */}
        <div className="w-72 border-r border-slate-800 bg-slate-900 p-4 flex flex-col gap-4 overflow-y-auto shrink-0 select-none">
          <div className="border-b border-slate-800 pb-3">
            <h2 className="font-bold text-lg text-slate-100 flex items-center gap-2">
              <span>🧰</span> Node Toolbox
            </h2>
            <div className="text-[11px] text-slate-400 mt-0.5">Click or drag nodes onto the canvas</div>
          </div>
          
          {/* Semantic & Task Routing */}
          <div className="mb-2">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-emerald-400 font-semibold flex items-center gap-1.5">
                <span>🛡️</span> Guardrails &amp; Filters
              </h3>
              <span className="text-[9px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono">Security</span>
            </div>

            {/* Privacy Guard */}
            <div
              className="p-2.5 mb-2 border border-emerald-500/80 bg-emerald-950/20 rounded-lg cursor-grab hover:bg-emerald-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'privacyGuardNode')}
              onClick={() => addNode('privacyGuardNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🛡️</span>
                <div>
                  <div className="font-semibold text-xs text-emerald-300 group-hover:text-emerald-200">Privacy &amp; PII Guard</div>
                  <div className="text-[10px] text-slate-400 font-mono">Regex &amp; NER PII Redactor</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-emerald-400 font-mono">+ Add</span>
            </div>

            {/* Semantic Guard */}
            <div
              className="p-2.5 mb-2 border border-orange-500/80 bg-orange-950/20 rounded-lg cursor-grab hover:bg-orange-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'semanticGuardNode')}
              onClick={() => addNode('semanticGuardNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🎯</span>
                <div>
                  <div className="font-semibold text-xs text-orange-300 group-hover:text-orange-200">Semantic Guard</div>
                  <div className="text-[10px] text-slate-400 font-mono">Embedding Injection Filter</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-orange-400 font-mono">+ Add</span>
            </div>

            {/* Confidential Silicon Enclave (TEE) */}
            <div
              className="p-2.5 mb-2 border border-emerald-500/80 bg-emerald-950/25 rounded-lg cursor-grab hover:bg-emerald-900/35 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'confidentialEnclaveNode')}
              onClick={() => addNode('confidentialEnclaveNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🔐</span>
                <div>
                  <div className="font-semibold text-xs text-emerald-300 group-hover:text-emerald-200">Confidential Enclave</div>
                  <div className="text-[10px] text-slate-400 font-mono">SEV-SNP / TDX + H100 CC RATS</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-emerald-400 font-mono">+ Add</span>
            </div>

            {/* Task Router */}
            <div
              className="p-2.5 mb-2 border border-amber-500/80 bg-amber-950/20 rounded-lg cursor-grab hover:bg-amber-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'taskRouterNode')}
              onClick={() => addNode('taskRouterNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🔀</span>
                <div>
                  <div className="font-semibold text-xs text-amber-300 group-hover:text-amber-200">Task Router</div>
                  <div className="text-[10px] text-slate-400 font-mono">Complexity &amp; Intent Dispatch</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-amber-400 font-mono">+ Add</span>
            </div>

            {/* OpenViking Context & Memory */}
            <div
              className="p-2.5 mb-2 border border-fuchsia-500/80 bg-fuchsia-950/20 rounded-lg cursor-grab hover:bg-fuchsia-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'memoryNode')}
              onClick={() => addNode('memoryNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🧠</span>
                <div>
                  <div className="font-semibold text-xs text-fuchsia-300 group-hover:text-fuchsia-200">Context &amp; Memory</div>
                  <div className="text-[10px] text-slate-400 font-mono">OpenViking • Graphiti • LightRAG</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-fuchsia-400 font-mono">+ Add</span>
            </div>

            {/* Knowledge Base (RAG) */}
            <div
              className="p-2.5 mb-2 border border-indigo-500/80 bg-indigo-950/20 rounded-lg cursor-grab hover:bg-indigo-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'knowledgeBaseNode')}
              onClick={() => addNode('knowledgeBaseNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">📚</span>
                <div>
                  <div className="font-semibold text-xs text-indigo-300 group-hover:text-indigo-200">Knowledge Base (RAG)</div>
                  <div className="text-[10px] text-slate-400 font-mono">:9621 • Hybrid Corpus RAG</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-indigo-400 font-mono">+ Add</span>
            </div>

            {/* Semantic Cache */}
            <div
              className="p-2.5 mb-2 border border-teal-500/80 bg-teal-950/20 rounded-lg cursor-grab hover:bg-teal-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'semanticCacheNode')}
              onClick={() => addNode('semanticCacheNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">⚡</span>
                <div>
                  <div className="font-semibold text-xs text-teal-300 group-hover:text-teal-200">Semantic Cache</div>
                  <div className="text-[10px] text-slate-400 font-mono">SQLite FTS5 / Qdrant Hit/Miss</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-teal-400 font-mono">+ Add</span>
            </div>
          </div>

          {/* Local LLM Engines */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-yellow-400 font-semibold">Local LLM Engines</h3>
              <span className="text-[9px] bg-yellow-500/20 text-yellow-300 px-1.5 py-0.5 rounded font-mono">Self-Hosted</span>
            </div>
            
            {/* Lemonade */}
            <div
              className="p-2.5 mb-2 border border-yellow-500/80 bg-yellow-950/20 rounded cursor-grab hover:bg-yellow-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'lemonadeNode')}
              onClick={() => addNode('lemonadeNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🍋</span>
                <div>
                  <div className="font-semibold text-xs text-yellow-300 group-hover:text-yellow-200">Lemonade Local</div>
                  <div className="text-[10px] text-gray-400 font-mono">:13305 • Multi-Model</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-yellow-400">+ Add</span>
            </div>

            {/* vLLM */}
            <div
              className="p-2.5 mb-2 border border-cyan-500/80 bg-cyan-950/20 rounded cursor-grab hover:bg-cyan-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'vllmNode')}
              onClick={() => addNode('vllmNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">⚡</span>
                <div>
                  <div className="font-semibold text-xs text-cyan-300 group-hover:text-cyan-200">vLLM Engine</div>
                  <div className="text-[10px] text-gray-400 font-mono">:8000 • PagedAttention / NIXL</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-cyan-400">+ Add</span>
            </div>

            {/* SGLang */}
            <div
              className="p-2.5 mb-2 border border-emerald-500/80 bg-emerald-950/20 rounded cursor-grab hover:bg-emerald-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'sglangNode')}
              onClick={() => addNode('sglangNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🌙</span>
                <div>
                  <div className="font-semibold text-xs text-emerald-300 group-hover:text-emerald-200">SGLang Engine</div>
                  <div className="text-[10px] text-gray-400 font-mono">:30000 • RadixAttention / Mooncake</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-emerald-400">+ Add</span>
            </div>

            {/* Ollama */}
            <div
              className="p-2.5 mb-2 border border-purple-500/80 bg-purple-950/20 rounded cursor-grab hover:bg-purple-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'ollamaNode')}
              onClick={() => addNode('ollamaNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🦙</span>
                <div>
                  <div className="font-semibold text-xs text-purple-300 group-hover:text-purple-200">Ollama Engine</div>
                  <div className="text-[10px] text-gray-400 font-mono">:11434 • GGUF Runner</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-purple-400">+ Add</span>
            </div>
          </div>

          {/* Cloud LLM Providers */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-sky-400 font-semibold">Cloud LLM Providers</h3>
              <span className="text-[9px] bg-sky-500/20 text-sky-300 px-1.5 py-0.5 rounded font-mono">Cloud / Remote</span>
            </div>

            {/* Billama Cloud */}
            <div
              className="p-2.5 mb-2 border border-blue-500/80 bg-blue-950/20 rounded cursor-grab hover:bg-blue-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'billamaNode')}
              onClick={() => addNode('billamaNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🦙</span>
                <div>
                  <div className="font-semibold text-xs text-blue-300 group-hover:text-blue-200">Billama Cloud</div>
                  <div className="text-[10px] text-gray-400 font-mono">api.billama.dev • Multi-Model</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-blue-400">+ Add</span>
            </div>

            {/* OpenAI Direct */}
            <div
              className="p-2.5 mb-2 border border-emerald-500/80 bg-emerald-950/20 rounded cursor-grab hover:bg-emerald-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'openaiNode')}
              onClick={() => addNode('openaiNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">⚡</span>
                <div>
                  <div className="font-semibold text-xs text-emerald-300 group-hover:text-emerald-200">OpenAI Direct</div>
                  <div className="text-[10px] text-gray-400 font-mono">api.openai.com • GPT-4o / o-series</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-emerald-400">+ Add</span>
            </div>

            {/* Anthropic Claude */}
            <div
              className="p-2.5 mb-2 border border-amber-500/80 bg-amber-950/20 rounded cursor-grab hover:bg-amber-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'claudeNode')}
              onClick={() => addNode('claudeNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">✳️</span>
                <div>
                  <div className="font-semibold text-xs text-amber-300 group-hover:text-amber-200">Anthropic Claude</div>
                  <div className="text-[10px] text-gray-400 font-mono">api.anthropic.com • Claude 3.7 / 3.5</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-amber-400">+ Add</span>
            </div>
          </div>

          {/* Autonomous Agents */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-cyan-400 font-semibold">Autonomous Agents</h3>
              <span className="text-[9px] bg-cyan-500/20 text-cyan-300 px-1.5 py-0.5 rounded font-mono">CLI / HARNESS</span>
            </div>

            {/* Agent Harness */}
            <div
              className="p-2.5 mb-2 border border-amber-500/80 bg-amber-950/20 rounded cursor-grab hover:bg-amber-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'harnessNode')}
              onClick={() => addNode('harnessNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">⚒️</span>
                <div>
                  <div className="font-semibold text-xs text-amber-300 group-hover:text-amber-200">Agent Harness</div>
                  <div className="text-[10px] text-gray-400 font-mono">TrueForge • OpenHands • Letta • A2A</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-amber-400">+ Add</span>
            </div>

            {/* Execution Sandbox */}
            <div
              className="p-2.5 mb-2 border border-rose-500/80 bg-rose-950/20 rounded cursor-grab hover:bg-rose-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'sandboxNode')}
              onClick={() => addNode('sandboxNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">📦</span>
                <div>
                  <div className="font-semibold text-xs text-rose-300 group-hover:text-rose-200">Execution Sandbox</div>
                  <div className="text-[10px] text-gray-400 font-mono">:8910 • Isolated Code Runner</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-rose-400">+ Add</span>
            </div>

            {/* Antigravity Node */}
            <div
              className="p-2.5 mb-2 border border-cyan-500/80 bg-cyan-950/20 rounded cursor-grab hover:bg-cyan-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'antigravityNode')}
              onClick={() => addNode('antigravityNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🪐</span>
                <div>
                  <div className="font-semibold text-xs text-cyan-300 group-hover:text-cyan-200">Google Antigravity</div>
                  <div className="text-[10px] text-gray-400 font-mono">agy • Sandboxed Agent</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-cyan-400">+ Add</span>
            </div>

            {/* OpenAI Codex Node */}
            <div
              className="p-2.5 mb-2 border border-emerald-500/80 bg-emerald-950/20 rounded cursor-grab hover:bg-emerald-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'codexNode')}
              onClick={() => addNode('codexNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">⚡</span>
                <div>
                  <div className="font-semibold text-xs text-emerald-300 group-hover:text-emerald-200">OpenAI Codex</div>
                  <div className="text-[10px] text-gray-400 font-mono">o3-mini / o1 • Interpreter</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-emerald-400">+ Add</span>
            </div>

            {/* Claude Code Node */}
            <div
              className="p-2.5 mb-2 border border-amber-500/80 bg-amber-950/20 rounded cursor-grab hover:bg-amber-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'claudeCodeNode')}
              onClick={() => addNode('claudeCodeNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">✳️</span>
                <div>
                  <div className="font-semibold text-xs text-amber-300 group-hover:text-amber-200">Claude Code</div>
                  <div className="text-[10px] text-gray-400 font-mono">claude 3.7 • Ripgrep / Edit</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-amber-400">+ Add</span>
            </div>

            {/* Standard Agent */}
            <div
              className="p-2.5 mb-2 border border-purple-500/80 bg-purple-950/20 rounded cursor-grab hover:bg-purple-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'agentNode')}
              onClick={() => addNode('agentNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🤖</span>
                <div>
                  <div className="font-semibold text-xs text-purple-300 group-hover:text-purple-200">Custom LLM Agent</div>
                  <div className="text-[10px] text-gray-400 font-mono">Single Target Model</div>
                </div>
              </div>
              <span className="text-[10px] text-gray-400 group-hover:text-purple-400">+ Add</span>
            </div>
          </div>

          {/* Gateways & Tool Protocols */}
          <div className="mb-2">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-emerald-400 font-semibold flex items-center gap-1.5">
                <span>🚪</span> Gateways &amp; Protocols
              </h3>
              <span className="text-[9px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono">Bifrost / MCP</span>
            </div>

            {/* Agent Gateway (MCP) */}
            <div
              className="p-2.5 mb-2 border border-emerald-500/80 bg-emerald-950/20 rounded-lg cursor-grab hover:bg-emerald-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'agentGatewayNode')}
              onClick={() => addNode('agentGatewayNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🔌</span>
                <div>
                  <div className="font-semibold text-xs text-emerald-300 group-hover:text-emerald-200">Agent Gateway</div>
                  <div className="text-[10px] text-slate-400 font-mono">MCP Protocol Gateway</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-emerald-400 font-mono">+ Add</span>
            </div>

            {/* MCP Tool Node */}
            <div
              className="p-2.5 mb-2 border border-yellow-500/80 bg-yellow-950/20 rounded-lg cursor-grab hover:bg-yellow-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'mcpToolNode')}
              onClick={() => addNode('mcpToolNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🔧</span>
                <div>
                  <div className="font-semibold text-xs text-yellow-300 group-hover:text-yellow-200">MCP Tool Node</div>
                  <div className="text-[10px] text-slate-400 font-mono">Function &amp; Tool Runner</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-yellow-400 font-mono">+ Add</span>
            </div>

            {/* Model Gateway */}
            <div
              className="p-2.5 mb-2 border border-teal-500/80 bg-teal-950/20 rounded-lg cursor-grab hover:bg-teal-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'modelGatewayNode')}
              onClick={() => addNode('modelGatewayNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🚪</span>
                <div>
                  <div className="font-semibold text-xs text-teal-300 group-hover:text-teal-200">Model Gateway</div>
                  <div className="text-[10px] text-slate-400 font-mono">Bifrost OpenAI Adapter</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-teal-400 font-mono">+ Add</span>
            </div>
          </div>

          {/* Execution & Observability */}
          <div className="mb-2">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-blue-400 font-semibold flex items-center gap-1.5">
                <span>⚖️</span> Balancers &amp; Sinks
              </h3>
              <span className="text-[9px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded font-mono">Runtime</span>
            </div>

            {/* Switchyard Balancer */}
            <div
              className="p-2.5 mb-2 border border-blue-500/80 bg-blue-950/20 rounded-lg cursor-grab hover:bg-blue-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'switchyardNode')}
              onClick={() => addNode('switchyardNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">⚖️</span>
                <div>
                  <div className="font-semibold text-xs text-blue-300 group-hover:text-blue-200">Switchyard Balancer</div>
                  <div className="text-[10px] text-slate-400 font-mono">Multi-Tier Priority Routing</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-blue-400 font-mono">+ Add</span>
            </div>

            {/* Consensus / Judge Arena */}
            <div
              className="p-2.5 mb-2 border border-violet-500/80 bg-violet-950/20 rounded-lg cursor-grab hover:bg-violet-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'consensusNode')}
              onClick={() => addNode('consensusNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🏛️</span>
                <div>
                  <div className="font-semibold text-xs text-violet-300 group-hover:text-violet-200">Consensus / Judge</div>
                  <div className="text-[10px] text-slate-400 font-mono">Parallel N-Model Fan-Out</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-violet-400 font-mono">+ Add</span>
            </div>

            {/* Fallback Chain / Circuit Breaker */}
            <div
              className="p-2.5 mb-2 border border-sky-500/80 bg-sky-950/20 rounded-lg cursor-grab hover:bg-sky-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'fallbackChainNode')}
              onClick={() => addNode('fallbackChainNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🛡️</span>
                <div>
                  <div className="font-semibold text-xs text-sky-300 group-hover:text-sky-200">Fallback Chain</div>
                  <div className="text-[10px] text-slate-400 font-mono">Circuit Breaker &amp; Hedging</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-sky-400 font-mono">+ Add</span>
            </div>

            {/* Observability */}
            <div
              className="p-2.5 mb-2 border border-indigo-500/80 bg-indigo-950/20 rounded-lg cursor-grab hover:bg-indigo-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'observabilityNode')}
              onClick={() => addNode('observabilityNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">📊</span>
                <div>
                  <div className="font-semibold text-xs text-indigo-300 group-hover:text-indigo-200">Observability Sink</div>
                  <div className="text-[10px] text-slate-400 font-mono">Live Telemetry &amp; Logs</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-indigo-400 font-mono">+ Add</span>
            </div>
          </div>

          {/* Basics */}
          <div className="mb-2">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-purple-400 font-semibold flex items-center gap-1.5">
                <span>🤖</span> Custom Inference
              </h3>
              <span className="text-[9px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded font-mono">Prompt</span>
            </div>

            {/* Agent / Model */}
            <div
              className="p-2.5 mb-2 border border-purple-500/80 bg-purple-950/20 rounded-lg cursor-grab hover:bg-purple-900/30 transition flex items-center justify-between group"
              onDragStart={(e) => onDragStart(e, 'agentNode')}
              onClick={() => addNode('agentNode')}
              draggable
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🤖</span>
                <div>
                  <div className="font-semibold text-xs text-purple-300 group-hover:text-purple-200">Custom LLM Agent</div>
                  <div className="text-[10px] text-slate-400 font-mono">Generic Prompt Agent</div>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 group-hover:text-purple-400 font-mono">+ Add</span>
            </div>
          </div>
          
          {/* Bottom Action Buttons */}
          <div className="mt-auto pt-4 border-t border-slate-800 space-y-2.5">
             <button 
               type="button"
               onClick={handleFastSave}
               className={`w-full font-bold py-2.5 px-3 rounded-lg text-xs transition flex items-center justify-center gap-2 shadow-lg ${
                 isDirty
                   ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-amber-600/20'
                   : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
               }`}
               title="Save layout to XDG_CONFIG (Ctrl+S / Cmd+S)"
             >
               <span>💾</span>
               <span>Save Layout</span>
               <span className="text-[10px] opacity-60 font-mono">⌘S</span>
             </button>
             <button 
               type="button"
               onClick={onApplyToRouter}
               className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold py-2.5 px-3 rounded-lg text-xs transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/25"
               title="Compile graph & deploy live router configuration"
             >
               <span>🚀</span>
               <span>Apply to Router</span>
             </button>
          </div>
        </div>

        {/* Canvas Area */}
        <div className="flex-1 relative flex flex-col min-w-0" ref={reactFlowWrapper}>
          {/* Top Canvas Toolbar */}
          <div className="h-12 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between z-10 shrink-0">
            {/* Left: Current Layout Info */}
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={() => setIsLayoutBrowserOpen(true)}
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 hover:text-white rounded-lg border border-slate-700 text-xs font-semibold transition"
                title="Browse and load layouts"
              >
                <span>📂</span>
                <span className="font-bold max-w-[180px] truncate">{currentName}</span>
                <span className="text-[10px] text-slate-400 font-mono hidden sm:inline">({currentSlug}.json)</span>
                <span className="text-slate-400 text-[10px]">▼</span>
              </button>

              {isDirty ? (
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-950/60 border border-amber-500/40 text-amber-300 text-[10px] font-medium shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  Unsaved
                </span>
              ) : (
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-600/40 text-emerald-400 text-[10px] font-medium shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Saved
                </span>
              )}

              {toastMessage && (
                <span className="text-xs text-sky-400 font-mono bg-sky-950/60 border border-sky-500/40 px-2.5 py-0.5 rounded-md animate-in fade-in truncate max-w-[280px]">
                  {toastMessage}
                </span>
              )}
            </div>

            {/* Right: Layout Operations */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleFastSave}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                  isDirty
                    ? 'bg-amber-600 hover:bg-amber-500 text-white shadow'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'
                }`}
                title="Save layout (Ctrl+S / Cmd+S)"
              >
                <span>💾</span>
                <span>Save</span>
                <span className="text-[10px] opacity-60 font-mono hidden md:inline">⌘S</span>
              </button>

              <button
                type="button"
                onClick={() => setIsSaveAsOpen(true)}
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg border border-slate-700 text-xs font-medium transition"
                title="Save copy with a new name"
              >
                Save As...
              </button>

              <div className="h-4 w-px bg-slate-800 mx-1 hidden sm:block" />

              <button
                type="button"
                onClick={handleNewCanvas}
                className="px-2.5 py-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg text-xs transition hidden sm:inline-flex"
                title="Create a new clean canvas"
              >
                ➕ New
              </button>

              <button
                type="button"
                onClick={handleExportJson}
                className="px-2.5 py-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg text-xs transition hidden md:inline-flex"
                title="Export Layout JSON to disk"
              >
                ⬇️ Export
              </button>

              <label
                className="px-2.5 py-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg text-xs transition cursor-pointer hidden md:inline-flex"
                title="Import Layout JSON from disk"
              >
                ⬆️ Import
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleImportJson}
                />
              </label>

              <div className="h-4 w-px bg-slate-800 mx-1" />

              <button
                type="button"
                onClick={onApplyToRouter}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition shadow flex items-center gap-1.5"
                title="Compile graph & deploy live router configuration"
              >
                <span>🚀</span>
                <span>Apply to Router</span>
              </button>
            </div>
          </div>

          <div className="flex-1 relative">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onInit={handleInit}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onNodeClick={handleNodeClick}
              nodeTypes={nodeTypes}
              onNodesDelete={onNodesDelete}
              deleteKeyCode={['Backspace', 'Delete']}
              defaultEdgeOptions={{
                style: { strokeWidth: 3.5 },
                animated: true,
              }}
              connectionLineStyle={{
                strokeWidth: 3.5,
                stroke: '#38bdf8',
              }}
              fitView
              className="bg-slate-950"
            >
            <Controls className="bg-slate-900 border-slate-700/80 fill-slate-300" />
            <MiniMap 
               nodeColor={(n) => {
                 if (n.type === 'inputNode') return '#22c55e';
                 if (n.type === 'privacyGuardNode') return '#10b981';
                 if (n.type === 'semanticGuardNode') return '#f97316';
                 if (n.type === 'switchyardNode') return '#3b82f6';
                 if (n.type === 'lemonadeNode') return '#eab308';
                 if (n.type === 'vllmNode') return '#06b6d4';
                 if (n.type === 'sglangNode') return '#10b981';
                 if (n.type === 'ollamaNode') return '#c084fc';
                 if (n.type === 'antigravityNode') return '#06b6d4';
                 if (n.type === 'codexNode') return '#10b981';
                 if (n.type === 'claudeCodeNode') return '#f59e0b';
                 if (n.type === 'billamaNode') return '#3b82f6';
                 if (n.type === 'openaiNode') return '#10b981';
                 if (n.type === 'claudeNode') return '#f59e0b';
                 if (n.type === 'modelGatewayNode') return '#10b981';
                 if (n.type === 'observabilityNode') return '#6366f1';
                 if (n.type === 'agentNode') return '#a855f7';
                 if (n.type === 'memoryNode') return '#d946ef';
                 if (n.type === 'harnessNode') return '#f59e0b';
                 if (n.type === 'sandboxNode') return '#f43f5e';
                 if (n.type === 'knowledgeBaseNode') return '#6366f1';
                 if (n.type === 'semanticCacheNode') return '#14b8a6';
                 if (n.type === 'consensusNode') return '#8b5cf6';
                 if (n.type === 'fallbackChainNode') return '#0ea5e9';
                 if (n.type === 'confidentialEnclaveNode') return '#10b981';
                 return '#94a3b8';
               }}
               maskColor="rgba(2, 6, 23, 0.75)"
               className="bg-slate-900/95 border-slate-700/60" 
            />
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#334155" />
          </ReactFlow>
          <LogViewer containerName={selectedLogContainer} onClose={() => setSelectedLogContainer(null)} />
          </div>
        </div>

        {/* Properties Panel */}
        {nodes.find(n => n.selected) && (
          <div className="w-84 border-l border-slate-800 bg-slate-900/95 p-4 flex flex-col overflow-y-auto backdrop-blur shrink-0 select-none">
            {(() => {
              const node = nodes.find(n => n.selected)!;
              const updateData = (key: string, value: any) => {
                setNodes((nds) => nds.map((n) => n.id === node.id ? { ...n, data: { ...n.data, [key]: value } } : n));
              };

              return (
                <div className="space-y-4">
                  <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
                    <div>
                      <h2 className="font-bold text-lg text-slate-100 flex items-center gap-2">
                        <span>⚙️</span> Properties
                      </h2>
                      <span className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">{node.type}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteSelectedNode(node.id)}
                      title="Delete selected node (Backspace / Delete)"
                      className="px-2.5 py-1 bg-red-600/20 hover:bg-red-600 border border-red-500/40 text-red-200 hover:text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shadow"
                    >
                      <span>🗑️</span>
                      <span>Delete</span>
                    </button>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1 font-semibold">Node ID</label>
                    <div className="text-xs font-mono bg-slate-950 p-2.5 rounded-lg border border-slate-800 text-sky-400">{node.id}</div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1 font-semibold">Node Type</label>
                    <div className="text-xs font-mono bg-slate-950 p-2.5 rounded-lg border border-slate-800 text-slate-300">{node.type}</div>
                  </div>

                  {node.type === 'antigravityNode' && (
                    <>
                      <div>
                        <label className="block text-xs mb-1">Gemini / AGY Model</label>
                        <select 
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.model as string) || 'gemini-3.8-flash'}
                          onChange={(e) => updateData('model', e.target.value)}
                        >
                          <option value="gemini-4-argon">Gemini 4 Argon (Next-Gen Flagship)</option>
                          <option value="gemini-3.8-flash">Gemini 3.8 Flash (Fast & Reasoning)</option>
                          <option value="claude-opus-5-5">Claude Opus 5.5 (Deep Reasoning)</option>
                          <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (Fast Frontier)</option>
                          <option value="gpt-oss-120b">GPT-OSS 120B (Open Weights)</option>
                          <option value="claude-3-7-sonnet">Claude 3.7 Sonnet</option>
                          <option value="custom">Custom Identifier...</option>
                        </select>
                      </div>

                      {node.data.model === 'custom' && (
                        <div>
                          <label className="block text-xs text-cyan-400 mb-1">Custom Model Identifier</label>
                          <input 
                            type="text"
                            className="w-full bg-gray-900 border border-cyan-500/50 rounded p-2 text-white text-sm font-mono"
                            value={(node.data.customModel as string) || ''}
                            onChange={(e) => updateData('customModel', e.target.value)}
                            placeholder="e.g. gemma-4-26b"
                          />
                        </div>
                      )}

                      <div>
                        <label className="block text-xs mb-1">Reasoning Effort (--effort)</label>
                        <select
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.effort as string) || 'auto'}
                          onChange={(e) => updateData('effort', e.target.value)}
                        >
                          <option value="auto">⚡ Auto (Mapped from Complexity Score)</option>
                          <option value="low" disabled={String(node.data.model || '').startsWith('gpt-oss-120b')}>Low (Fastest TTFT)</option>
                          <option value="medium">Medium (Balanced Reasoning)</option>
                          <option value="high" disabled={String(node.data.model || '').startsWith('gpt-oss-120b')}>High (Deep Architectural Thinking)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs mb-1">Terminal Sandbox Mode</label>
                        <select 
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.sandboxMode as string) || 'standard'}
                          onChange={(e) => updateData('sandboxMode', e.target.value)}
                        >
                          <option value="standard">🛡️ Standard Sandbox (Isolated, No Net)</option>
                          <option value="bypass">⚡ Bypass Sandbox (Full Access, Direct OS)</option>
                          <option value="read-only">🔒 Read-Only (Safe Inspection)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs mb-1">Execution Behavior</label>
                        <select 
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.agentBehavior as string) || 'autonomous'}
                          onChange={(e) => updateData('agentBehavior', e.target.value)}
                        >
                          <option value="autonomous">🤖 Autonomous (Non-interactive)</option>
                          <option value="interactive">💬 Interactive (Collaborative)</option>
                          <option value="planning">📋 Planning Mode (Plan First)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs mb-1">Extended Thinking Budget</label>
                        <div className="flex items-center gap-2">
                          <input 
                            type="range"
                            min="512"
                            max="8192"
                            step="512"
                            className="w-full accent-cyan-400"
                            value={Number(node.data.thinkingBudget ?? 2048)}
                            onChange={(e) => updateData('thinkingBudget', Number(e.target.value))}
                          />
                          <span className="text-xs font-mono text-cyan-400 whitespace-nowrap">{String(node.data.thinkingBudget ?? 2048)} tok</span>
                        </div>
                      </div>

                      <div className="space-y-1.5 pt-2 border-t border-gray-700">
                        <label className="flex items-center text-xs gap-2 cursor-pointer" title="Isolates .gemini plugin registry to prevent IDE SessionStart hooks and reduce prefill by ~26k tokens">
                          <input 
                            type="checkbox" 
                            className="rounded bg-gray-900 border-gray-700 text-cyan-500"
                            checked={(node.data.cleanHeadless as boolean) !== false}
                            onChange={(e) => updateData('cleanHeadless', e.target.checked)}
                          />
                          <span>Clean Headless Mode (Zero Plugin Hooks)</span>
                        </label>
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="rounded bg-gray-900 border-gray-700 text-cyan-500"
                            checked={(node.data.enableWriteTools as boolean) !== false}
                            onChange={(e) => updateData('enableWriteTools', e.target.checked)}
                          />
                          <span>Enable Write &amp; Shell Tools</span>
                        </label>
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="rounded bg-gray-900 border-gray-700 text-cyan-500"
                            checked={(node.data.enableSubagents as boolean) !== false}
                            onChange={(e) => updateData('enableSubagents', e.target.checked)}
                          />
                          <span>Enable Subagent Delegation</span>
                        </label>
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="rounded bg-gray-900 border-gray-700 text-cyan-500"
                            checked={(node.data.networkAccess as boolean) === true}
                            onChange={(e) => updateData('networkAccess', e.target.checked)}
                          />
                          <span>Allow Outbound Network Access</span>
                        </label>
                      </div>
                    </>
                  )}

                  {node.type === 'codexNode' && (
                    <>
                      <div>
                        <label className="block text-xs mb-1">OpenAI Codex Model</label>
                        <select 
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.model as string) || 'o3-mini'}
                          onChange={(e) => updateData('model', e.target.value)}
                        >
                          <option value="o3-mini">o3-mini (High Coding Reasoning)</option>
                          <option value="o1">o1 (Frontier Deep Reasoning)</option>
                          <option value="o1-mini">o1-mini (Fast Coding Reasoning)</option>
                          <option value="gpt-4o">GPT-4o (Omni Coding)</option>
                          <option value="gpt-4o-mini">GPT-4o mini (Low Cost)</option>
                          <option value="custom">Custom Model Identifier...</option>
                        </select>
                      </div>

                      {node.data.model === 'custom' && (
                        <div>
                          <label className="block text-xs text-emerald-400 mb-1">Custom Model Identifier</label>
                          <input 
                            type="text"
                            className="w-full bg-gray-900 border border-emerald-500/50 rounded p-2 text-white text-sm font-mono"
                            value={(node.data.customModel as string) || ''}
                            onChange={(e) => updateData('customModel', e.target.value)}
                            placeholder="e.g. ft:o3-mini:my-org:custom"
                          />
                        </div>
                      )}

                      {((node.data.model as string) === 'o3-mini' || (node.data.model as string) === 'o1' || (node.data.model as string) === 'o1-mini') && (
                        <div>
                          <label className="block text-xs mb-1">Reasoning Effort</label>
                          <select 
                            className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                            value={(node.data.reasoningEffort as string) || 'medium'}
                            onChange={(e) => updateData('reasoningEffort', e.target.value)}
                          >
                            <option value="low">Low (Fast, Lower Token Cost)</option>
                            <option value="medium">Medium (Balanced)</option>
                            <option value="high">High (Deepest Code Logic)</option>
                          </select>
                        </div>
                      )}

                      <div>
                        <label className="block text-xs mb-1">Execution Environment</label>
                        <select 
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.environment as string) || 'local-sandbox'}
                          onChange={(e) => updateData('environment', e.target.value)}
                        >
                          <option value="local-sandbox">🔒 Local Process Sandbox</option>
                          <option value="docker">🐳 Docker Container Isolation</option>
                          <option value="e2b-cloud">☁️ E2B Sandboxed MicroVM</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs mb-1">Approval Policy</label>
                        <select 
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.approvalMode as string) || 'confirm-risky'}
                          onChange={(e) => updateData('approvalMode', e.target.value)}
                        >
                          <option value="confirm-risky">🛡️ Confirm Risky Actions (Auto reads)</option>
                          <option value="always-ask">🔒 Always Ask Confirmation</option>
                          <option value="auto-approve">⚡ Auto-Approve (Headless / CI)</option>
                        </select>
                      </div>

                      <div className="space-y-1.5 pt-2 border-t border-gray-700">
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="rounded bg-gray-900 border-gray-700 text-emerald-500"
                            checked={(node.data.enableCodeInterpreter as boolean) !== false}
                            onChange={(e) => updateData('enableCodeInterpreter', e.target.checked)}
                          />
                          <span>Enable Python Code Interpreter</span>
                        </label>
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="rounded bg-gray-900 border-gray-700 text-emerald-500"
                            checked={(node.data.enableBash as boolean) !== false}
                            onChange={(e) => updateData('enableBash', e.target.checked)}
                          />
                          <span>Enable Terminal / Shell Tool</span>
                        </label>
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="rounded bg-gray-900 border-gray-700 text-emerald-500"
                            checked={(node.data.enableFileEditor as boolean) !== false}
                            onChange={(e) => updateData('enableFileEditor', e.target.checked)}
                          />
                          <span>Enable File Editor &amp; Diff Tool</span>
                        </label>
                      </div>
                    </>
                  )}

                  {node.type === 'claudeCodeNode' && (
                    <>
                      <div>
                        <label className="block text-xs mb-1">Anthropic Claude Model</label>
                        <select 
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.model as string) || 'claude-3-7-sonnet'}
                          onChange={(e) => updateData('model', e.target.value)}
                        >
                          <option value="claude-3-7-sonnet">Claude 3.7 Sonnet (Hybrid Reasoning)</option>
                          <option value="claude-3-5-sonnet">Claude 3.5 Sonnet (Coding Workhorse)</option>
                          <option value="claude-3-5-haiku">Claude 3.5 Haiku (High Speed)</option>
                          <option value="claude-3-opus">Claude 3 Opus (Legacy Frontier)</option>
                          <option value="custom">Custom Identifier...</option>
                        </select>
                      </div>

                      {node.data.model === 'custom' && (
                        <div>
                          <label className="block text-xs text-amber-400 mb-1">Custom Model Identifier</label>
                          <input 
                            type="text"
                            className="w-full bg-gray-900 border border-amber-500/50 rounded p-2 text-white text-sm font-mono"
                            value={(node.data.customModel as string) || ''}
                            onChange={(e) => updateData('customModel', e.target.value)}
                            placeholder="e.g. anthropic.claude-3-7-sonnet-v1"
                          />
                        </div>
                      )}

                      <div>
                        <label className="block text-xs mb-1">Permission Mode</label>
                        <select 
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.permissionMode as string) || 'accept-non-destructive'}
                          onChange={(e) => updateData('permissionMode', e.target.value)}
                        >
                          <option value="accept-non-destructive">🛡️ Accept Non-Destructive (Auto grep/read)</option>
                          <option value="prompt">🔒 Prompt Every Action (Maximum Control)</option>
                          <option value="dangerously-skip-permissions">⚡ Skip Permissions (Headless/CI)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs mb-1">Extended Thinking Budget</label>
                        <div className="flex items-center gap-2">
                          <input 
                            type="range"
                            min="1024"
                            max="64000"
                            step="1024"
                            className="w-full accent-amber-500"
                            value={Number(node.data.thinkingBudget ?? 4096)}
                            onChange={(e) => updateData('thinkingBudget', Number(e.target.value))}
                          />
                          <span className="text-xs font-mono text-amber-400 whitespace-nowrap">{String(node.data.thinkingBudget ?? 4096)} tok</span>
                        </div>
                      </div>

                      <div className="space-y-1.5 pt-2 border-t border-gray-700">
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="rounded bg-gray-900 border-gray-700 text-amber-500"
                            checked={(node.data.enableBashTool as boolean) !== false}
                            onChange={(e) => updateData('enableBashTool', e.target.checked)}
                          />
                          <span>Enable Bash Tool</span>
                        </label>
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="rounded bg-gray-900 border-gray-700 text-amber-500"
                            checked={(node.data.enableFileEditTool as boolean) !== false}
                            onChange={(e) => updateData('enableFileEditTool', e.target.checked)}
                          />
                          <span>Enable File Edit Tool</span>
                        </label>
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="rounded bg-gray-900 border-gray-700 text-amber-500"
                            checked={(node.data.enableGrepTool as boolean) !== false}
                            onChange={(e) => updateData('enableGrepTool', e.target.checked)}
                          />
                          <span>Enable Grep &amp; Glob Tools</span>
                        </label>
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="rounded bg-gray-900 border-gray-700 text-amber-500"
                            checked={(node.data.enableSubagents as boolean) !== false}
                            onChange={(e) => updateData('enableSubagents', e.target.checked)}
                          />
                          <span>Enable Subagent Task Delegation</span>
                        </label>
                      </div>
                    </>
                  )}

                  {node.type === 'billamaNode' && (
                    <>
                      <div>
                        <label className="block text-xs mb-1">Provider Label</label>
                        <input
                          type="text"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.label as string) || 'Billama Cloud'}
                          onChange={(e) => updateData('label', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">Cloud Endpoint</label>
                        <input
                          type="text"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm font-mono text-xs"
                          value={(node.data.endpoint as string) || 'https://api.billama.dev'}
                          onChange={(e) => updateData('endpoint', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">API Key</label>
                        <input
                          type="password"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm font-mono text-xs"
                          value={(node.data.apiKey as string) || ''}
                          onChange={(e) => updateData('apiKey', e.target.value)}
                          placeholder="billama_sk_..."
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">Priority (Higher = preferred in same tier)</label>
                        <input
                          type="number"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={Number(node.data.priority ?? 15)}
                          onChange={(e) => updateData('priority', parseInt(e.target.value, 10))}
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">Cost Rate ($ / 1k Tokens)</label>
                        <input
                          type="number"
                          step="0.0001"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm font-mono"
                          value={Number(node.data.costPer1kTokens ?? 0.002)}
                          onChange={(e) => updateData('costPer1kTokens', parseFloat(e.target.value))}
                        />
                      </div>
                      <div>
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            className="rounded bg-gray-900 border-gray-700 text-blue-500"
                            checked={(node.data.visionCapable as boolean) !== false}
                            onChange={(e) => updateData('visionCapable', e.target.checked)}
                          />
                          <span>Vision Capable (Multimodal)</span>
                        </label>
                      </div>
                    </>
                  )}

                  {node.type === 'openaiNode' && (
                    <>
                      <div>
                        <label className="block text-xs mb-1">Provider Label</label>
                        <input
                          type="text"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.label as string) || 'OpenAI Direct'}
                          onChange={(e) => updateData('label', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">OpenAI API Endpoint</label>
                        <input
                          type="text"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm font-mono text-xs"
                          value={(node.data.endpoint as string) || 'https://api.openai.com/v1'}
                          onChange={(e) => updateData('endpoint', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">API Key</label>
                        <input
                          type="password"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm font-mono text-xs"
                          value={(node.data.apiKey as string) || ''}
                          onChange={(e) => updateData('apiKey', e.target.value)}
                          placeholder="sk-proj-..."
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">Organization ID (Optional)</label>
                        <input
                          type="text"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm font-mono text-xs"
                          value={(node.data.organization as string) || ''}
                          onChange={(e) => updateData('organization', e.target.value)}
                          placeholder="org-..."
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">Priority (Higher = preferred in same tier)</label>
                        <input
                          type="number"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={Number(node.data.priority ?? 10)}
                          onChange={(e) => updateData('priority', parseInt(e.target.value, 10))}
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">Cost Rate ($ / 1k Tokens)</label>
                        <input
                          type="number"
                          step="0.0001"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm font-mono"
                          value={Number(node.data.costPer1kTokens ?? 0.005)}
                          onChange={(e) => updateData('costPer1kTokens', parseFloat(e.target.value))}
                        />
                      </div>
                      <div>
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            className="rounded bg-gray-900 border-gray-700 text-emerald-500"
                            checked={(node.data.visionCapable as boolean) !== false}
                            onChange={(e) => updateData('visionCapable', e.target.checked)}
                          />
                          <span>Vision Capable (Multimodal)</span>
                        </label>
                      </div>
                    </>
                  )}

                  {node.type === 'claudeNode' && (
                    <>
                      <div>
                        <label className="block text-xs mb-1">Provider Label</label>
                        <input
                          type="text"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={(node.data.label as string) || 'Anthropic Claude'}
                          onChange={(e) => updateData('label', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">Anthropic API Endpoint</label>
                        <input
                          type="text"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm font-mono text-xs"
                          value={(node.data.endpoint as string) || 'https://api.anthropic.com/v1'}
                          onChange={(e) => updateData('endpoint', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">API Key</label>
                        <input
                          type="password"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm font-mono text-xs"
                          value={(node.data.apiKey as string) || ''}
                          onChange={(e) => updateData('apiKey', e.target.value)}
                          placeholder="sk-ant-api03-..."
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">Priority (Higher = preferred in same tier)</label>
                        <input
                          type="number"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm"
                          value={Number(node.data.priority ?? 10)}
                          onChange={(e) => updateData('priority', parseInt(e.target.value, 10))}
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">Cost Rate ($ / 1k Tokens)</label>
                        <input
                          type="number"
                          step="0.0001"
                          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white text-sm font-mono"
                          value={Number(node.data.costPer1kTokens ?? 0.003)}
                          onChange={(e) => updateData('costPer1kTokens', parseFloat(e.target.value))}
                        />
                      </div>
                      <div>
                        <label className="flex items-center text-xs gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            className="rounded bg-gray-900 border-gray-700 text-amber-500"
                            checked={(node.data.visionCapable as boolean) !== false}
                            onChange={(e) => updateData('visionCapable', e.target.checked)}
                          />
                          <span>Vision Capable (Multimodal)</span>
                        </label>
                      </div>
                    </>
                  )}

                  {node.type === 'privacyGuardNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Enforcement Action</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-emerald-500"
                          value={(node.data.action as string) || 'anonymize'}
                          onChange={(e) => updateData('action', e.target.value)}
                        >
                          <option value="anonymize">🔒 Anonymize (Mask In-Flight PII)</option>
                          <option value="block">🚫 Block Request (Reject 400)</option>
                          <option value="warn">⚠️ Warn &amp; Audit (Pass-through with log)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Redaction Format / Style</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-emerald-500"
                          value={(node.data.redactionStyle as string) || 'token'}
                          onChange={(e) => updateData('redactionStyle', e.target.value)}
                        >
                          <option value="token">🏷️ Named Token ([REDACTED_API_KEY])</option>
                          <option value="asterisk">•••• Asterisk Masking (sk-••••)</option>
                          <option value="hash">🔑 Cryptographic Hash ([HASH:e3b0...])</option>
                        </select>
                      </div>

                      <div className="pt-2 border-t border-slate-800">
                        <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                          <span>🛡️</span> Built-in Sensitive Entity Types
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs text-slate-300">
                          {[
                            { key: 'apiKey', label: 'API Keys & Secrets' },
                            { key: 'ssn', label: 'Social Security (SSN)' },
                            { key: 'creditCard', label: 'Credit Card Numbers' },
                            { key: 'email', label: 'Email Addresses' },
                            { key: 'phone', label: 'Phone Numbers' },
                            { key: 'ipAddress', label: 'IP Addresses' },
                          ].map((item) => {
                            const pii = (node.data.detectPii as Record<string, boolean>) || {};
                            const isChecked = pii[item.key] !== false;
                            return (
                              <label key={item.key} className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="rounded bg-slate-950 border-slate-700 text-emerald-500 focus:ring-0"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    updateData('detectPii', {
                                      ...pii,
                                      [item.key]: e.target.checked
                                    });
                                  }}
                                />
                                <span className="text-[11px]">{item.label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      <div className="pt-2 border-t border-slate-800">
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          Exempted Whitelist (Comma-separated)
                        </label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-emerald-500 outline-none"
                          placeholder="example.com, test@internal.org, localhost"
                          value={Array.isArray(node.data.whitelist) ? (node.data.whitelist as string[]).join(', ') : String(node.data.whitelist || '')}
                          onChange={(e) => updateData('whitelist', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                        />
                        <p className="text-[10px] text-slate-500 mt-0.5">Tokens or domains exempted from redaction.</p>
                      </div>

                      <div className="pt-2 border-t border-slate-800">
                        <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                          <input
                            type="checkbox"
                            className="rounded bg-slate-950 border-slate-700 text-emerald-500"
                            checked={Boolean(node.data.auditLogging)}
                            onChange={(e) => updateData('auditLogging', e.target.checked)}
                          />
                          <span>Record Redacted Fragments in Security Audit Log</span>
                        </label>
                      </div>
                    </div>
                  )}

                  {node.type === 'semanticGuardNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Route Name</label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs outline-none focus:border-red-500"
                          value={(node.data.routeName as string) || 'prompt-injection-defense'}
                          onChange={(e) => updateData('routeName', e.target.value)}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Embedding / Classifier Model</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-red-500"
                          value={(node.data.encoder as string) || 'deberta-v3-injection'}
                          onChange={(e) => updateData('encoder', e.target.value)}
                        >
                          <option value="deberta-v3-injection">DeBERTa-v3-Injection (Classifier Firewall)</option>
                          <option value="bge-small-en-v1.5">BGE-Small-EN-v1.5 (Semantic Similarity)</option>
                          <option value="minilm-l6-v2">MiniLM-L6-v2 (Fast Heuristic)</option>
                        </select>
                      </div>

                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <label className="text-xs font-semibold text-slate-300">Sensitivity Threshold</label>
                          <span className="text-xs font-mono text-red-400">
                            {Number(node.data.threshold ?? 0.85).toFixed(2)}
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0.50"
                          max="0.99"
                          step="0.01"
                          className="w-full accent-red-500 cursor-pointer"
                          value={Number(node.data.threshold ?? 0.85)}
                          onChange={(e) => updateData('threshold', parseFloat(e.target.value))}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Enforcement Action</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-red-500"
                          value={(node.data.enforcementAction as string) || 'block'}
                          onChange={(e) => updateData('enforcementAction', e.target.value)}
                        >
                          <option value="block">🚫 Block (Return 400 Bad Request)</option>
                          <option value="strip">✂️ Strip (Remove Attack Prefix / Token)</option>
                          <option value="divert">🔀 Divert (Route to Quarantine Sink)</option>
                          <option value="warn">⚠️ Warn &amp; Audit (Proceed with Flag)</option>
                        </select>
                      </div>

                      <div className="pt-2 border-t border-slate-800">
                        <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                          <span>🛑</span> Active Threat Vectors
                        </div>
                        <div className="space-y-1.5 text-xs text-slate-300">
                          {[
                            { key: 'instructionOverride', label: 'Instruction Override (Ignore prior...)' },
                            { key: 'danJailbreak', label: 'DAN / Jailbreak Personas' },
                            { key: 'systemPromptLeak', label: 'System Prompt Leakage Attempts' },
                            { key: 'obfuscation', label: 'Obfuscated Attacks (Base64/ROT13)' }
                          ].map((tv) => {
                            const vectors = (node.data.threatVectors as Record<string, boolean>) || {
                              instructionOverride: true,
                              danJailbreak: true,
                              systemPromptLeak: true,
                              obfuscation: true
                            };
                            return (
                              <label key={tv.key} className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="rounded bg-slate-950 border-slate-700 text-red-500"
                                  checked={vectors[tv.key] !== false}
                                  onChange={(e) => {
                                    updateData('threatVectors', {
                                      ...vectors,
                                      [tv.key]: e.target.checked
                                    });
                                  }}
                                />
                                <span className="text-[11px]">{tv.label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      <div className="pt-2 border-t border-slate-800">
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          Custom Banned Phrases (Comma-separated)
                        </label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-red-500 outline-none"
                          placeholder="e.g. root_override, secret_admin_bypass"
                          value={Array.isArray(node.data.bannedPhrases) ? (node.data.bannedPhrases as string[]).join(', ') : String(node.data.bannedPhrases || '')}
                          onChange={(e) => updateData('bannedPhrases', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                        />
                      </div>
                    </div>
                  )}

                  {node.type === 'taskRouterNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Classification Engine</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-indigo-500"
                          value={(node.data.classificationEngine as string) || 'heuristic'}
                          onChange={(e) => updateData('classificationEngine', e.target.value)}
                        >
                          <option value="heuristic">⚡ Heuristic Regex Scoring ($0, Ultra Fast)</option>
                          <option value="fastembed">🧠 FastEmbed Embedding Similarity (Local)</option>
                          <option value="micro-llm">🤖 Micro-LLM Intent Classifier (Strict)</option>
                        </select>
                      </div>

                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <label className="text-xs font-semibold text-slate-300">Confidence Threshold</label>
                          <span className="text-xs font-mono text-indigo-400">
                            {Number(node.data.confidenceThreshold ?? 0.85).toFixed(2)}
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0.50"
                          max="0.95"
                          step="0.05"
                          className="w-full accent-indigo-500 cursor-pointer"
                          value={Number(node.data.confidenceThreshold ?? 0.85)}
                          onChange={(e) => updateData('confidenceThreshold', parseFloat(e.target.value))}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Routing Preference</label>
                        <select 
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-indigo-500"
                          value={(node.data.preference as string) || 'balanced'}
                          onChange={(e) => updateData('preference', e.target.value)}
                        >
                          <option value="balanced">Balanced (Cost vs Quality)</option>
                          <option value="cost">Prioritize Lowest Cost</option>
                          <option value="latency">Prioritize Speed</option>
                          <option value="capability">Strict Capability Match</option>
                        </select>
                      </div>

                      <div className="pt-2 border-t border-slate-800">
                        <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                          <span>🔀</span> Dynamic Intent Handles
                        </div>
                        <div className="space-y-1 text-xs">
                          <div className="p-1.5 bg-slate-950 rounded border border-slate-800 flex items-center justify-between">
                            <span className="text-sky-300">💻 Code &amp; Software</span>
                            <span className="text-[10px] font-mono text-slate-500">#intent-code</span>
                          </div>
                          <div className="p-1.5 bg-slate-950 rounded border border-slate-800 flex items-center justify-between">
                            <span className="text-purple-300">🧠 Deep Reasoning</span>
                            <span className="text-[10px] font-mono text-slate-500">#intent-reasoning</span>
                          </div>
                          <div className="p-1.5 bg-slate-950 rounded border border-slate-800 flex items-center justify-between">
                            <span className="text-emerald-300">💬 Fast Chat / Summary</span>
                            <span className="text-[10px] font-mono text-slate-500">#intent-fast</span>
                          </div>
                          <div className="p-1.5 bg-slate-950 rounded border border-slate-800 flex items-center justify-between">
                            <span className="text-amber-300">🧰 Tools &amp; Actions</span>
                            <span className="text-[10px] font-mono text-slate-500">#intent-tools</span>
                          </div>
                          <div className="p-1.5 bg-slate-950 rounded border border-slate-800 flex items-center justify-between">
                            <span className="text-slate-300">🔁 Default Fallback</span>
                            <span className="text-[10px] font-mono text-slate-500">#intent-default</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {node.type === 'modelGatewayNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Primary Model</label>
                        <input 
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs focus:border-sky-500 outline-none"
                          value={(node.data.primaryModel as string) || ''}
                          onChange={(e) => updateData('primaryModel', e.target.value)}
                          placeholder="e.g. meta-llama/Llama-3-8b"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Fallback Strategy</label>
                        <select 
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs focus:border-sky-500 outline-none"
                          value={(node.data.fallbackStrategy as string) || 'cheaper'}
                          onChange={(e) => updateData('fallbackStrategy', e.target.value)}
                        >
                          <option value="cheaper">Fallback to Cheaper Model</option>
                          <option value="same-tier">Fallback to Same-Tier Alternative</option>
                          <option value="fail-fast">Fail Fast</option>
                        </select>
                      </div>

                      {/* Semantic Response Caching */}
                      <div className="pt-2 border-t border-slate-800">
                        <div className="flex items-center justify-between mb-2">
                          <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-300">
                            <input
                              type="checkbox"
                              className="rounded bg-slate-950 border-slate-700 text-sky-500"
                              checked={(node.data.cacheEnabled as boolean) !== false}
                              onChange={(e) => updateData('cacheEnabled', e.target.checked)}
                            />
                            <span>Semantic Response Cache</span>
                          </label>
                          <span className="text-[10px] text-sky-400 font-mono">0ms Hits</span>
                        </div>

                        {(node.data.cacheEnabled as boolean) !== false && (
                          <div className="space-y-2 pl-4 border-l border-sky-900/50">
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-0.5">TTL (Seconds)</label>
                                <input
                                  type="number"
                                  min={60}
                                  max={86400}
                                  step={60}
                                  className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-sky-500 outline-none"
                                  value={node.data.cacheTtlSeconds !== undefined ? Number(node.data.cacheTtlSeconds) : 3600}
                                  onChange={(e) => updateData('cacheTtlSeconds', parseInt(e.target.value, 10) || 3600)}
                                />
                              </div>
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-0.5">Similarity Threshold</label>
                                <input
                                  type="number"
                                  min={0.80}
                                  max={1.0}
                                  step={0.01}
                                  className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-sky-500 outline-none"
                                  value={node.data.cacheSimilarityThreshold !== undefined ? Number(node.data.cacheSimilarityThreshold) : 0.95}
                                  onChange={(e) => updateData('cacheSimilarityThreshold', parseFloat(e.target.value) || 0.95)}
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Rate Limiting */}
                      <div className="pt-2 border-t border-slate-800">
                        <div className="flex justify-between items-center mb-1">
                          <label className="text-xs font-semibold text-slate-300">Rate Limit (Max RPM)</label>
                          <span className="text-xs font-mono text-sky-400">
                            {node.data.rateLimitRpm ? `${node.data.rateLimitRpm} RPM` : 'Uncapped'}
                          </span>
                        </div>
                        <input
                          type="number"
                          min={0}
                          max={1000}
                          step={10}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-sky-500 outline-none"
                          placeholder="e.g. 60 (0 = uncapped)"
                          value={node.data.rateLimitRpm !== undefined ? Number(node.data.rateLimitRpm) : 60}
                          onChange={(e) => updateData('rateLimitRpm', parseInt(e.target.value, 10) || 0)}
                        />
                      </div>

                      {/* System Prompt Prepend */}
                      <div className="pt-2 border-t border-slate-800">
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Global System Prompt Prepend</label>
                        <textarea
                          rows={3}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-[11px] focus:border-sky-500 outline-none"
                          placeholder="Prepend enterprise identity or guardrails to all requests routed through this gateway..."
                          value={(node.data.systemPromptPrepend as string) || ''}
                          onChange={(e) => updateData('systemPromptPrepend', e.target.value)}
                        />
                      </div>
                    </div>
                  )}

                  {node.type === 'agentGatewayNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Access Policy</label>
                        <select 
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-cyan-500"
                          value={(node.data.accessPolicy as string) || 'restrictive'}
                          onChange={(e) => updateData('accessPolicy', e.target.value)}
                        >
                          <option value="restrictive">🛡️ Restrictive (Whitelist Only)</option>
                          <option value="permissive">🏢 Permissive (Internal VPC Tools)</option>
                          <option value="open">🌐 Open (Public MCP Registry)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Tool Filter Mode</label>
                        <select 
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-cyan-500"
                          value={(node.data.toolFilterMode as string) || 'all'}
                          onChange={(e) => updateData('toolFilterMode', e.target.value)}
                        >
                          <option value="all">Allow All Attached Tools</option>
                          <option value="whitelist">Strict Tool Whitelist</option>
                          <option value="blacklist">Blacklist Risky Tools</option>
                        </select>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Tool Timeout (ms)</label>
                          <input
                            type="number"
                            min={1000}
                            max={60000}
                            step={1000}
                            className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-cyan-500 outline-none"
                            value={node.data.toolTimeoutMs !== undefined ? Number(node.data.toolTimeoutMs) : 10000}
                            onChange={(e) => updateData('toolTimeoutMs', parseInt(e.target.value, 10) || 10000)}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Native Host Tools</label>
                          <div className="pt-2">
                            <label className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-300">
                              <input
                                type="checkbox"
                                className="rounded bg-slate-950 border-slate-700 text-cyan-500"
                                checked={(node.data.enableNativeTools as boolean) !== false}
                                onChange={(e) => updateData('enableNativeTools', e.target.checked)}
                              />
                              <span className="text-[11px]">Allow Native</span>
                            </label>
                          </div>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-slate-800">
                        <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                          <input
                            type="checkbox"
                            className="rounded bg-slate-950 border-slate-700 text-cyan-500"
                            checked={(node.data.sanitizeToolOutput as boolean) !== false}
                            onChange={(e) => updateData('sanitizeToolOutput', e.target.checked)}
                          />
                          <span>Scrub PII from Tool Outputs</span>
                        </label>
                        <p className="text-[10px] text-slate-500 mt-0.5">Applies Privacy Guard masking before feeding tool output to models.</p>
                      </div>
                      
                      <div className="pt-2 border-t border-slate-800">
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Mapped OpenBao Secret</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-cyan-500"
                          value={(node.data.vaultSecret as string) || ''}
                          onChange={(e) => updateData('vaultSecret', e.target.value)}
                        >
                          <option value="">-- None --</option>
                          {availableSecrets.map(s => (
                            <option key={s.key} value={`${s.path}#${s.key}`}>{s.key}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  {node.type === 'mcpToolNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Tool Name</label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs focus:border-amber-500 outline-none"
                          value={(node.data.toolName as string) || ''}
                          onChange={(e) => updateData('toolName', e.target.value)}
                          placeholder="e.g. read_resource"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">MCP Server Endpoint</label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs focus:border-amber-500 outline-none"
                          value={(node.data.mcpEndpoint as string) || ''}
                          onChange={(e) => updateData('mcpEndpoint', e.target.value)}
                          placeholder="http://localhost:3588/sse"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Execution Mode</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-amber-500"
                          value={(node.data.executionMode as string) || 'auto'}
                          onChange={(e) => updateData('executionMode', e.target.value)}
                        >
                          <option value="auto">⚡ Automatic (Immediate Execution)</option>
                          <option value="confirm">✋ Human-in-the-Loop Confirmation</option>
                          <option value="dry-run">🔍 Dry Run (Simulation Only)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Execution Timeout (ms)</label>
                        <input
                          type="number"
                          min={1000}
                          max={600000}
                          step={1000}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-amber-500 outline-none"
                          value={node.data.timeoutMs !== undefined ? Number(node.data.timeoutMs) : 60000}
                          onChange={(e) => updateData('timeoutMs', parseInt(e.target.value, 10) || 60000)}
                        />
                      </div>
                    </div>
                  )}

                  {node.type === 'observabilityNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Telemetry Exporter</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-indigo-500"
                          value={(node.data.exporter as string) || 'sqlite'}
                          onChange={(e) => updateData('exporter', e.target.value)}
                        >
                          <option value="sqlite">💾 Embedded SQLite (Default Local DB)</option>
                          <option value="otlp">📡 OpenTelemetry Collector (OTLP/gRPC)</option>
                          <option value="langfuse">🔬 Langfuse Platform (LLM Tracing)</option>
                          <option value="prometheus">📊 Prometheus Metrics Endpoint</option>
                        </select>
                      </div>

                      {Boolean(node.data.exporter && node.data.exporter !== 'sqlite') && (
                        <div>
                          <label className="block text-xs font-semibold text-slate-300 mb-1">Remote Collector URL</label>
                          <input
                            type="text"
                            className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs focus:border-indigo-500 outline-none"
                            value={(node.data.endpointUrl as string) || ''}
                            onChange={(e) => updateData('endpointUrl', e.target.value)}
                            placeholder="http://otel-collector:4318/v1/traces"
                          />
                        </div>
                      )}

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Project / Service Name</label>
                        <input 
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs focus:border-indigo-500 outline-none"
                          value={(node.data.projectName as string) || 'eluvix-production'}
                          onChange={(e) => updateData('projectName', e.target.value)}
                          placeholder="eluvix-production"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <label className="text-xs font-semibold text-slate-300">Trace Sampling Rate</label>
                          <span className="text-xs font-mono text-indigo-400">
                            {Number(node.data.samplingRate ?? 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="100"
                          step="1"
                          className="w-full accent-indigo-500 cursor-pointer"
                          value={Number(node.data.samplingRate ?? 100)}
                          onChange={(e) => updateData('samplingRate', parseInt(e.target.value, 10))}
                        />
                      </div>

                      <div className="pt-2 border-t border-slate-800 space-y-2">
                        <label className="flex items-center text-xs gap-2 cursor-pointer text-slate-300">
                          <input 
                            type="checkbox" 
                            className="bg-slate-950 border-slate-700 rounded text-indigo-500"
                            checked={(node.data.scrubPii as boolean) !== false}
                            onChange={(e) => updateData('scrubPii', e.target.checked)}
                          />
                          <span>Scrub PII from Recorded Traces</span>
                        </label>

                        <label className="flex items-center text-xs gap-2 cursor-pointer text-slate-300">
                          <input 
                            type="checkbox" 
                            className="bg-slate-950 border-slate-700 rounded text-indigo-500"
                            checked={(node.data.captureInputs as boolean) !== false}
                            onChange={(e) => updateData('captureInputs', e.target.checked)}
                          />
                          <span>Capture Full Request Inputs &amp; Outputs</span>
                        </label>
                      </div>

                      <div className="pt-2 border-t border-slate-800">
                        <label className="block text-[10px] text-slate-400 mb-1">Latency Alert Threshold (ms)</label>
                        <input
                          type="number"
                          min={500}
                          max={60000}
                          step={500}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-indigo-500 outline-none"
                          value={node.data.latencyAlertMs !== undefined ? Number(node.data.latencyAlertMs) : 5000}
                          onChange={(e) => updateData('latencyAlertMs', parseInt(e.target.value, 10) || 5000)}
                        />
                      </div>
                    </div>
                  )}

                  {node.type === 'agentNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Persona Name</label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-semibold text-xs focus:border-purple-500 outline-none"
                          value={(node.data.persona as string) || (node.data.label as string) || 'Lead Architect'}
                          onChange={(e) => {
                            updateData('persona', e.target.value);
                            updateData('label', e.target.value);
                          }}
                          placeholder="e.g. Lead Software Architect"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Primary Capability</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-purple-500"
                          value={(node.data.capability as string) || 'general'}
                          onChange={(e) => updateData('capability', e.target.value)}
                        >
                          <option value="general">🌐 General Purpose Assistant</option>
                          <option value="coding">💻 Software Engineering &amp; Refactor</option>
                          <option value="research">🔬 Research &amp; Deep Analysis</option>
                          <option value="orchestration">🔀 Multi-Agent Coordinator</option>
                        </select>
                      </div>

                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <label className="text-xs font-semibold text-slate-300">Temperature</label>
                          <span className="text-xs font-mono text-purple-400">
                            {Number(node.data.temperature ?? 0.7).toFixed(1)}
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0.0"
                          max="1.0"
                          step="0.05"
                          className="w-full accent-purple-500 cursor-pointer"
                          value={Number(node.data.temperature ?? 0.7)}
                          onChange={(e) => updateData('temperature', parseFloat(e.target.value))}
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1">Max Output Tokens</label>
                        <input
                          type="number"
                          min={256}
                          max={16384}
                          step={256}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-purple-500 outline-none"
                          value={node.data.maxTokens !== undefined ? Number(node.data.maxTokens) : 4096}
                          onChange={(e) => updateData('maxTokens', parseInt(e.target.value, 10) || 4096)}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">System Instructions / Prompt</label>
                        <textarea
                          rows={4}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-[11px] focus:border-purple-500 outline-none"
                          placeholder="Define role, boundaries, tool usage guidelines, and output formatting..."
                          value={(node.data.systemInstructions as string) || ''}
                          onChange={(e) => updateData('systemInstructions', e.target.value)}
                        />
                      </div>

                      <div className="pt-2 border-t border-slate-800">
                        <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                          <input
                            type="checkbox"
                            className="rounded bg-slate-950 border-slate-700 text-purple-500"
                            checked={(node.data.memory as boolean) !== false}
                            onChange={(e) => updateData('memory', e.target.checked)}
                          />
                          <span>Persistent Multi-Turn Memory</span>
                        </label>
                      </div>
                    </div>
                  )}

                  {(node.type === 'lemonadeNode' || node.type === 'vllmNode' || node.type === 'sglangNode' || node.type === 'ollamaNode') && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Local Server Endpoint</label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs focus:border-yellow-500 outline-none"
                          value={(node.data.endpoint as string) || ''}
                          onChange={(e) => updateData('endpoint', e.target.value)}
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Router Priority</label>
                          <input
                            type="number"
                            min={1}
                            max={50}
                            className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-yellow-500 outline-none"
                            value={node.data.priority !== undefined ? Number(node.data.priority) : 20}
                            onChange={(e) => updateData('priority', parseInt(e.target.value, 10) || 1)}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Max Concurrency</label>
                          <input
                            type="number"
                            min={1}
                            max={64}
                            className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-yellow-500 outline-none"
                            value={node.data.maxParallelRequests !== undefined ? Number(node.data.maxParallelRequests) : 4}
                            onChange={(e) => updateData('maxParallelRequests', parseInt(e.target.value, 10) || 1)}
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1">Context Window Ceiling (Tokens)</label>
                        <input
                          type="number"
                          min={1024}
                          max={131072}
                          step={1024}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-yellow-500 outline-none"
                          value={node.data.maxContextTokens !== undefined ? Number(node.data.maxContextTokens) : 32768}
                          onChange={(e) => updateData('maxContextTokens', parseInt(e.target.value, 10) || 32768)}
                        />
                      </div>
                    </div>
                  )}

                  {node.type === 'switchyardNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Execution Strategy</label>
                        <select 
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs outline-none focus:border-blue-500"
                          value={(node.data.strategy as string) || 'cost-complexity'}
                          onChange={(e) => updateData('strategy', e.target.value)}
                        >
                          <option value="cost-complexity">💰 Cost & Complexity Matrix (Default)</option>
                          <option value="cascade-cost">📉 Strict Cost Escalation ($0 ➔ Cloud)</option>
                          <option value="lowest-cost">🪙 Lowest Cost First ($0 Local First)</option>
                          <option value="lowest-latency">⚡ Lowest Latency</option>
                          <option value="round-robin">🔄 Round Robin Multi-Provider</option>
                          <option value="priority">🎯 Priority / Manual Weighting</option>
                        </select>
                      </div>

                      {/* Latency & Resiliency */}
                      <div className="pt-2 border-t border-slate-800">
                        <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                          <span>⚡</span> Latency &amp; Resiliency
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[10px] text-slate-400 mb-1">Timeout (ms)</label>
                            <input
                              type="number"
                              min={1000}
                              max={600000}
                              step={1000}
                              className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-blue-500 outline-none"
                              value={node.data.timeoutMs !== undefined ? Number(node.data.timeoutMs) : 60000}
                              onChange={(e) => updateData('timeoutMs', parseInt(e.target.value, 10) || 60000)}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-400 mb-1">Max Retries</label>
                            <input
                              type="number"
                              min={0}
                              max={5}
                              className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-blue-500 outline-none"
                              value={node.data.retryCount !== undefined ? Number(node.data.retryCount) : 1}
                              onChange={(e) => updateData('retryCount', parseInt(e.target.value, 10) || 0)}
                            />
                          </div>
                        </div>
                        <div className="mt-2">
                          <label className="block text-[10px] text-slate-400 mb-1">
                            Spillover Circuit Breaker (ms)
                          </label>
                          <input
                            type="number"
                            min={500}
                            max={120000}
                            step={500}
                            className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-blue-500 outline-none"
                            value={node.data.spilloverThresholdMs !== undefined ? Number(node.data.spilloverThresholdMs) : 30000}
                            onChange={(e) => updateData('spilloverThresholdMs', parseInt(e.target.value, 10) || 30000)}
                          />
                          <p className="text-[10px] text-slate-500 mt-0.5">
                            Spills over to cloud/higher tier if local engine exceeds this latency.
                          </p>
                        </div>
                      </div>

                      {/* Token Complexity Bounds */}
                      <div className="pt-2 border-t border-slate-800">
                        <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                          <span>📊</span> Token Complexity Thresholds
                        </div>
                        <div className="space-y-2">
                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Moderate (Tokens)</span>
                              <span className="font-mono text-slate-300">
                                {(node.data.complexityThresholds as any)?.moderate ?? 300}
                              </span>
                            </div>
                            <input
                              type="number"
                              min={50}
                              max={2000}
                              step={50}
                              className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-blue-500 outline-none"
                              value={(node.data.complexityThresholds as any)?.moderate ?? 300}
                              onChange={(e) => {
                                const current = (node.data.complexityThresholds as any) || { moderate: 300, heavy: 1500, frontier: 6000 };
                                updateData('complexityThresholds', { ...current, moderate: parseInt(e.target.value, 10) || 300 });
                              }}
                            />
                          </div>
                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Heavy (Tokens)</span>
                              <span className="font-mono text-slate-300">
                                {(node.data.complexityThresholds as any)?.heavy ?? 1500}
                              </span>
                            </div>
                            <input
                              type="number"
                              min={500}
                              max={8000}
                              step={100}
                              className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-blue-500 outline-none"
                              value={(node.data.complexityThresholds as any)?.heavy ?? 1500}
                              onChange={(e) => {
                                const current = (node.data.complexityThresholds as any) || { moderate: 300, heavy: 1500, frontier: 6000 };
                                updateData('complexityThresholds', { ...current, heavy: parseInt(e.target.value, 10) || 1500 });
                              }}
                            />
                          </div>
                          <div>
                            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                              <span>Frontier (Tokens)</span>
                              <span className="font-mono text-slate-300">
                                {(node.data.complexityThresholds as any)?.frontier ?? 6000}
                              </span>
                            </div>
                            <input
                              type="number"
                              min={2000}
                              max={32000}
                              step={500}
                              className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-blue-500 outline-none"
                              value={(node.data.complexityThresholds as any)?.frontier ?? 6000}
                              onChange={(e) => {
                                const current = (node.data.complexityThresholds as any) || { moderate: 300, heavy: 1500, frontier: 6000 };
                                updateData('complexityThresholds', { ...current, frontier: parseInt(e.target.value, 10) || 6000 });
                              }}
                            />
                          </div>

                          <div className="pt-1">
                            <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                              <input
                                type="checkbox"
                                className="rounded bg-slate-950 border-slate-700 text-blue-500"
                                checked={(node.data.codeEscalation as boolean) !== false}
                                onChange={(e) => updateData('codeEscalation', e.target.checked)}
                              />
                              <span>Auto-Escalate on Code Blocks (```)</span>
                            </label>
                          </div>
                        </div>
                      </div>

                      {/* Budget Ceiling */}
                      <div className="pt-2 border-t border-slate-800">
                        <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                          <span>💰</span> Budget Ceiling
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Max Cost per Request ($)</label>
                          <input
                            type="number"
                            min={0}
                            max={10}
                            step={0.01}
                            className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-white font-mono text-xs focus:border-blue-500 outline-none"
                            value={node.data.maxCostPerRequest !== undefined ? Number(node.data.maxCostPerRequest) : 0.05}
                            onChange={(e) => updateData('maxCostPerRequest', parseFloat(e.target.value) || 0)}
                          />
                          <p className="text-[10px] text-slate-500 mt-0.5">
                            Requests exceeding this cost cap are routed to local engines or rejected.
                          </p>
                        </div>
                      </div>

                      {/* Architecture Boundary Note */}
                      <div className="p-2.5 rounded bg-blue-950/30 border border-blue-900/40 text-[10px] text-blue-300/80 leading-relaxed">
                        <p className="font-semibold text-blue-200 mb-0.5">ℹ️ L7 Proxy vs Host Boundary</p>
                        <p>
                          Routing rules, timeouts, retries, spillover, and complexity thresholds are applied dynamically by the L7 proxy. Host-level hardware options (GPU allocation, host listening port) are set at container launch.
                        </p>
                      </div>
                    </div>
                  )}

                  {node.type === 'memoryNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-fuchsia-300 mb-1">Memory Provider</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.provider || 'openviking')}
                          onChange={(e) => {
                            const next = e.target.value;
                            updateData('provider', next);
                            if (next === 'openviking') updateData('endpoint', 'http://localhost:1933');
                            else if (next === 'mem0') updateData('endpoint', 'http://localhost:8888');
                            else if (next === 'graphiti') updateData('endpoint', 'http://localhost:8004');
                            else if (next === 'lightrag') updateData('endpoint', 'http://localhost:9621');
                            else if (next === 'cognee') updateData('endpoint', 'http://localhost:8005');
                            else if (next === 'supermemory') updateData('endpoint', 'https://api.supermemory.ai');
                          }}
                        >
                          <option value="openviking">OpenViking (:1933)</option>
                          <option value="builtin">Built-in SQLite FTS5</option>
                          <option value="mem0">Mem0 (:8888)</option>
                          <option value="graphiti">Graphiti Temporal KG (:8004)</option>
                          <option value="lightrag">LightRAG Hybrid Graph (:9621)</option>
                          <option value="cognee">Cognee ECL Graph (:8005)</option>
                          <option value="supermemory">Supermemory Cloud</option>
                        </select>
                      </div>
                      {String(node.data.provider || 'openviking') !== 'builtin' && (
                        <div>
                          <label className="block text-xs font-semibold text-slate-300 mb-1">Memory Server Endpoint</label>
                          <input
                            type="text"
                            className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                            value={String(node.data.endpoint || 'http://localhost:1933')}
                            onChange={(e) => updateData('endpoint', e.target.value)}
                          />
                        </div>
                      )}
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">OpenViking Reading Level</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.readingLevel || 'L1')}
                          onChange={(e) => updateData('readingLevel', e.target.value)}
                        >
                          <option value="L0">L0 (Abstract ~100 tokens)</option>
                          <option value="L1">L1 (Overview ~500 tokens)</option>
                          <option value="L2">L2 (Full Detail)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Recall Token Budget</label>
                        <input
                          type="number"
                          min={100}
                          max={8000}
                          step={100}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={Number(node.data.recallBudgetTokens ?? 600)}
                          onChange={(e) => updateData('recallBudgetTokens', parseInt(e.target.value, 10) || 600)}
                        />
                      </div>
                    </div>
                  )}

                  {node.type === 'harnessNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-amber-300 mb-1">Harness Runtime</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.kind || 'trueforge')}
                          onChange={(e) => {
                            const next = e.target.value;
                            updateData('kind', next);
                            if (next === 'trueforge') updateData('endpoint', 'http://localhost:8790');
                            else if (next === 'opencode') updateData('endpoint', 'http://localhost:4096');
                            else if (next === 'acp') updateData('endpoint', 'acp://goose');
                            else if (next === 'openhands') updateData('endpoint', 'http://localhost:3000');
                            else if (next === 'mastra') updateData('endpoint', 'http://localhost:4111');
                            else if (next === 'letta') updateData('endpoint', 'http://localhost:8283');
                            else if (next === 'a2a') updateData('endpoint', 'http://localhost:8900');
                            else updateData('endpoint', 'http://localhost:8642/v1');
                          }}
                        >
                          <option value="trueforge">TrueForge (:8790)</option>
                          <option value="opencode">OpenCode Server (:4096)</option>
                          <option value="acp">ACP Agent (stdio)</option>
                          <option value="hermes">Hermes Agent (:8642)</option>
                          <option value="openhands">OpenHands SWE Agent (:3000)</option>
                          <option value="mastra">Mastra TS Agent (:4111)</option>
                          <option value="letta">Letta Stateful Agent (:8283)</option>
                          <option value="a2a">A2A Remote Peer (:8900)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Harness Endpoint</label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={String(node.data.endpoint || 'http://localhost:8790')}
                          onChange={(e) => updateData('endpoint', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Agent Profile ID</label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={String(node.data.agentId || 'default')}
                          onChange={(e) => updateData('agentId', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Tool Approval Policy</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.approvals || 'auto-approve-readonly')}
                          onChange={(e) => updateData('approvals', e.target.value)}
                        >
                          <option value="auto-approve-readonly">Auto-Approve Read-Only</option>
                          <option value="read-only">Read-Only Tools</option>
                          <option value="surface">Surface to Client</option>
                          <option value="auto-deny">Auto-Deny Mutating</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {node.type === 'sandboxNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-rose-300 mb-1">Sandbox Runtime</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.runtime || 'docker')}
                          onChange={(e) => updateData('runtime', e.target.value)}
                        >
                          <option value="docker">Docker Container</option>
                          <option value="gvisor">gVisor Sandbox (runsc)</option>
                          <option value="wasm">WebAssembly (WasmEdge)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Execution Mode</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.sandboxType || 'docker-exec')}
                          onChange={(e) => updateData('sandboxType', e.target.value)}
                        >
                          <option value="docker-exec">Docker Ephemeral Exec (:3986)</option>
                          <option value="opensandbox">OpenSandbox MicroVM</option>
                          <option value="e2b">E2B Firecracker Cloud</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Sandbox Endpoint</label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={String(node.data.endpoint || 'http://localhost:3986')}
                          onChange={(e) => updateData('endpoint', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Timeout (Seconds)</label>
                        <input
                          type="number"
                          min={1}
                          max={300}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={Number(node.data.timeoutSec ?? 30)}
                          onChange={(e) => updateData('timeoutSec', parseInt(e.target.value, 10) || 30)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Network Policy</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.networkPolicy || 'none')}
                          onChange={(e) => updateData('networkPolicy', e.target.value)}
                        >
                          <option value="none">None (Airgapped)</option>
                          <option value="allowlist">Allowlist Only</option>
                          <option value="bridge">Full Bridge</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {node.type === 'knowledgeBaseNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-indigo-300 mb-1">Knowledge Backend</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.backend || 'lightrag')}
                          onChange={(e) => updateData('backend', e.target.value)}
                        >
                          <option value="lightrag">LightRAG (:9621)</option>
                          <option value="openviking-resources">OpenViking Resources (:1933)</option>
                          <option value="qdrant">Qdrant Vector DB (:6333)</option>
                          <option value="sqlite-fts">Built-in SQLite FTS5</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Collection / Corpus URI</label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={String(node.data.collectionUri || 'viking://resources/docs')}
                          onChange={(e) => updateData('collectionUri', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Retrieval Mode</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.retrievalMode || 'hybrid')}
                          onChange={(e) => updateData('retrievalMode', e.target.value)}
                        >
                          <option value="hybrid">Hybrid (BM25 + Graph + Vector)</option>
                          <option value="vector">Dense Vector Only</option>
                          <option value="graph-global">Global Graph Community</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {node.type === 'semanticCacheNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-teal-300 mb-1">Cache Mode</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.mode || 'exact')}
                          onChange={(e) => updateData('mode', e.target.value)}
                        >
                          <option value="exact">Exact Hash Matching</option>
                          <option value="semantic">Semantic Jaccard / Embedding Similarity</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Cache Backend</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.backend || 'sqlite-fts')}
                          onChange={(e) => updateData('backend', e.target.value)}
                        >
                          <option value="sqlite-fts">SQLite FTS5 + Memory</option>
                          <option value="qdrant">Qdrant Vector Cache (:6333)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Scope Isolation</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.scopeIsolation || 'user')}
                          onChange={(e) => updateData('scopeIsolation', e.target.value)}
                        >
                          <option value="user">Per-User (Default)</option>
                          <option value="session">Per-Session</option>
                          <option value="global">Global Shared</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Similarity Threshold</label>
                        <input
                          type="number"
                          min={0.7}
                          max={1.0}
                          step={0.01}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={Number(node.data.similarityThreshold ?? 0.94)}
                          onChange={(e) => updateData('similarityThreshold', parseFloat(e.target.value) || 0.94)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">TTL (Seconds)</label>
                        <input
                          type="number"
                          min={60}
                          max={604800}
                          step={60}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={Number(node.data.ttlSeconds ?? 3600)}
                          onChange={(e) => updateData('ttlSeconds', parseInt(e.target.value, 10) || 3600)}
                        />
                      </div>
                    </div>
                  )}

                  {node.type === 'consensusNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-violet-300 mb-1">Aggregation Mode</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.strategy || (node.data.mode === 'judge' ? 'parallel-judge' : node.data.mode || 'parallel-judge'))}
                          onChange={(e) => {
                            updateData('strategy', e.target.value);
                            updateData('mode', e.target.value === 'parallel-judge' ? 'judge' : e.target.value);
                          }}
                        >
                          <option value="parallel-judge">LLM-as-a-Judge Synthesis</option>
                          <option value="mixture-of-agents">Mixture-of-Agents (MoA)</option>
                          <option value="fastest-first">Speculative Race (First Valid Wins)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Minimum Quorum</label>
                        <input
                          type="number"
                          min={1}
                          max={5}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={Number(node.data.minQuorum ?? 2)}
                          onChange={(e) => updateData('minQuorum', parseInt(e.target.value, 10) || 1)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Candidate Count (N)</label>
                        <input
                          type="number"
                          min={2}
                          max={5}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={Number(node.data.candidateCount ?? 3)}
                          onChange={(e) => updateData('candidateCount', parseInt(e.target.value, 10) || 3)}
                        />
                      </div>
                    </div>
                  )}

                  {node.type === 'fallbackChainNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-sky-300 mb-1">Failure Threshold (Trips)</label>
                        <input
                          type="number"
                          min={1}
                          max={20}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={Number(node.data.failureThreshold ?? 3)}
                          onChange={(e) => updateData('failureThreshold', parseInt(e.target.value, 10) || 3)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Cooldown (Seconds)</label>
                        <input
                          type="number"
                          min={5}
                          max={600}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={Number(node.data.cooldownSeconds ?? 30)}
                          onChange={(e) => updateData('cooldownSeconds', parseInt(e.target.value, 10) || 30)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Speculative Hedge Delay (ms)</label>
                        <input
                          type="number"
                          min={0}
                          max={30000}
                          step={250}
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={Number(node.data.hedgeDelayMs ?? 0)}
                          onChange={(e) => updateData('hedgeDelayMs', parseInt(e.target.value, 10) || 0)}
                        />
                      </div>
                    </div>
                  )}

                  {node.type === 'confidentialEnclaveNode' && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-emerald-300 mb-1">Architecture</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.architecture || 'sev-snp-h100-cc')}
                          onChange={(e) => updateData('architecture', e.target.value)}
                        >
                          <option value="sev-snp-h100-cc">Dual AMD SEV-SNP + NVIDIA H100 CC</option>
                          <option value="tdx-b200-tee-io">Dual Intel TDX + NVIDIA B200 TEE-I/O</option>
                          <option value="sev-snp-only">AMD SEV-SNP CPU Only (Genoa/Turin)</option>
                          <option value="intel-tdx-only">Intel TDX CPU Only (Emerald/Granite)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Confidential Policy</label>
                        <select
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                          value={String(node.data.confidentialPolicy || 'require-dual-attestation')}
                          onChange={(e) => updateData('confidentialPolicy', e.target.value)}
                        >
                          <option value="require-dual-attestation">Require Dual Attestation (CPU + GPU)</option>
                          <option value="require-tee">Require TEE (Fail Closed)</option>
                          <option value="prefer-tee">Prefer TEE (Attested First, Cloud Fallback)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">KBS / Attestation Broker Endpoint</label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={String(node.data.kbsEndpoint || 'https://kbs.internal.corp:8080')}
                          onChange={(e) => updateData('kbsEndpoint', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Golden Launch Measurement</label>
                        <input
                          type="text"
                          className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white font-mono text-xs"
                          value={String(node.data.expectedMeasurement || '')}
                          onChange={(e) => updateData('expectedMeasurement', e.target.value)}
                        />
                      </div>
                      <div className="flex items-center justify-between pt-2">
                        <label className="text-xs text-slate-300">SPDM 1.2 PCIe Link Verified</label>
                        <input
                          type="checkbox"
                          className="w-4 h-4 rounded bg-slate-950 border-slate-700"
                          checked={node.data.spdmAttested !== false}
                          onChange={(e) => updateData('spdmAttested', e.target.checked)}
                        />
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <label className="text-xs text-slate-300">Restricted Memory Injection (VMPL0)</label>
                        <input
                          type="checkbox"
                          className="w-4 h-4 rounded bg-slate-950 border-slate-700"
                          checked={node.data.restrictedInjection !== false}
                          onChange={(e) => updateData('restrictedInjection', e.target.checked)}
                        />
                      </div>
                    </div>
                  )}
                  
                  <div className="pt-4 border-t border-gray-700 mt-6">
                    <button
                      type="button"
                      onClick={() => deleteSelectedNode(node.id)}
                      className="w-full py-2 px-3 bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/50 rounded text-xs font-semibold flex items-center justify-center gap-2 transition"
                    >
                      <span>🗑️</span>
                      <span>Delete Selected Node ({String(node.data?.label || node.id)})</span>
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {applyDiff && confirmAction && (pendingApply || pendingDeploy) && (
          <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-[60] p-4">
            <div className="bg-gray-800 rounded-xl border border-gray-600 shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
              <div className="flex justify-between items-center p-4 border-b border-gray-700 bg-gray-900">
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <span>⚠️</span> {confirmAction === 'deploy'
                    ? 'Deploy to LOCAL — this rewrites the live router config'
                    : 'Apply changes to the live router?'}
                </h3>
                <button
                  onClick={cancelApplyToRouter}
                  className="text-gray-400 hover:text-white"
                >
                  ✕
                </button>
              </div>
              <div className="p-4 overflow-y-auto flex flex-col gap-4 text-sm">
                <p className="text-gray-300">
                  {confirmAction === 'deploy'
                    ? 'Deploying to the LOCAL tier writes this configuration to the live router config file and reloads the router — the same authoritative write as Apply. The live configuration becomes exactly what is in this deployment.'
                    : 'Applying is authoritative: the live router configuration becomes exactly what is on this canvas.'}
                  {applyDiff.removed.length > 0 && (
                    <span className="text-red-300 font-semibold"> {applyDiff.removed.length} upstream(s) will be removed.</span>
                  )}
                </p>
                {!applyDiffKnown && (
                  <div className="bg-amber-900/40 border border-amber-600/50 text-amber-200 rounded-lg p-3">
                    The current live config could not be loaded, so removals cannot be shown. The list below only reflects what will be written.
                  </div>
                )}
                {applyDiff.isEmpty && applyDiffKnown && (
                  <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3 text-gray-300">
                    No changes — the live config already matches this canvas.
                  </div>
                )}
                {applyDiff.removed.length > 0 && (
                  <div>
                    <h4 className="text-red-300 font-semibold mb-1.5">🗑️ Will be removed</h4>
                    <ul className="flex flex-col gap-1">
                      {applyDiff.removed.map(u => (
                        <li key={u.id} className="bg-red-950/40 border border-red-800/50 rounded px-2.5 py-1.5 font-mono text-xs text-red-200">
                          {u.name} <span className="text-red-400">({u.id} · {u.endpoint})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {applyDiff.added.length > 0 && (
                  <div>
                    <h4 className="text-emerald-300 font-semibold mb-1.5">➕ Will be added</h4>
                    <ul className="flex flex-col gap-1">
                      {applyDiff.added.map(u => (
                        <li key={u.id} className="bg-emerald-950/40 border border-emerald-800/50 rounded px-2.5 py-1.5 font-mono text-xs text-emerald-200">
                          {u.name} <span className="text-emerald-400">({u.id} · {u.endpoint})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {applyDiff.changed.length > 0 && (
                  <div>
                    <h4 className="text-amber-300 font-semibold mb-1.5">✏️ Will be changed</h4>
                    <ul className="flex flex-col gap-1">
                      {applyDiff.changed.map(c => (
                        <li key={c.id} className="bg-amber-950/40 border border-amber-800/50 rounded px-2.5 py-1.5 font-mono text-xs text-amber-200">
                          {c.name} <span className="text-amber-400">({c.id}: {c.fields.join(', ')})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {applyDiff.egressPolicy && (
                  <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3 text-gray-300 font-mono text-xs">
                    Egress policy: {applyDiff.egressPolicy.from ?? '(legacy default)'} → {applyDiff.egressPolicy.to ?? '(legacy default)'}
                  </div>
                )}
                {applyDiff.memory && (
                  <div>
                    <h4 className="text-sky-300 font-semibold mb-1.5">
                      🧠 Memory settings{' '}
                      {applyDiff.memory.kind === 'added'
                        ? 'will be added'
                        : applyDiff.memory.kind === 'removed'
                        ? 'will be removed'
                        : 'will change'}
                    </h4>
                    <div className="bg-sky-950/40 border border-sky-800/50 rounded px-2.5 py-1.5 font-mono text-xs text-sky-200">
                      Fields: {applyDiff.memory.fields.join(', ')}
                      {applyDiff.memory.fields.includes('allowCloudEgress') && (
                        <span className="text-amber-300">
                          {' '}— includes allowCloudEgress: review whether recalled memories may leave this machine.
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Policy & Feature Changes */}
                {(applyDiff.knowledgeChanged ||
                  applyDiff.cacheChanged ||
                  applyDiff.sandboxChanged ||
                  applyDiff.consensusChanged ||
                  applyDiff.fallbackChainsChanged ||
                  applyDiff.confidentialPolicyChanged ||
                  applyDiff.quantizationPolicyChanged ||
                  applyDiff.fabricPolicyChanged ||
                  applyDiff.strategyChanged ||
                  applyDiff.fallbackStrategyChanged ||
                  applyDiff.promptGuardChanged ||
                  applyDiff.privacyGuardChanged ||
                  applyDiff.switchyardChanged ||
                  applyDiff.modelGatewayChanged) && (
                  <div>
                    <h4 className="text-purple-300 font-semibold mb-1.5">⚙️ Policies &amp; Topologies Updated</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {applyDiff.confidentialPolicyChanged && (
                        <span className="bg-purple-950/60 border border-purple-500/50 text-purple-200 text-xs px-2 py-0.5 rounded font-mono">
                          🛡️ Confidential Enclaves
                        </span>
                      )}
                      {applyDiff.quantizationPolicyChanged && (
                        <span className="bg-cyan-950/60 border border-cyan-500/50 text-cyan-200 text-xs px-2 py-0.5 rounded font-mono">
                          💎 Microscaling Quantization
                        </span>
                      )}
                      {applyDiff.fabricPolicyChanged && (
                        <span className="bg-blue-950/60 border border-blue-500/50 text-blue-200 text-xs px-2 py-0.5 rounded font-mono">
                          🌐 Clos Rail Fabric
                        </span>
                      )}
                      {applyDiff.knowledgeChanged && (
                        <span className="bg-emerald-950/60 border border-emerald-500/50 text-emerald-200 text-xs px-2 py-0.5 rounded font-mono">
                          📚 Knowledge Base (RAG)
                        </span>
                      )}
                      {applyDiff.cacheChanged && (
                        <span className="bg-teal-950/60 border border-teal-500/50 text-teal-200 text-xs px-2 py-0.5 rounded font-mono">
                          ⚡ Semantic Cache
                        </span>
                      )}
                      {applyDiff.sandboxChanged && (
                        <span className="bg-rose-950/60 border border-rose-500/50 text-rose-200 text-xs px-2 py-0.5 rounded font-mono">
                          📦 Execution Sandbox
                        </span>
                      )}
                      {applyDiff.consensusChanged && (
                        <span className="bg-amber-950/60 border border-amber-500/50 text-amber-200 text-xs px-2 py-0.5 rounded font-mono">
                          ⚖️ Multi-LLM Consensus
                        </span>
                      )}
                      {applyDiff.fallbackChainsChanged && (
                        <span className="bg-indigo-950/60 border border-indigo-500/50 text-indigo-200 text-xs px-2 py-0.5 rounded font-mono">
                          🔄 Fallback Chains
                        </span>
                      )}
                      {applyDiff.strategyChanged && (
                        <span className="bg-sky-950/60 border border-sky-500/50 text-sky-200 text-xs px-2 py-0.5 rounded font-mono">
                          🎯 Routing Strategy
                        </span>
                      )}
                      {applyDiff.promptGuardChanged && (
                        <span className="bg-orange-950/60 border border-orange-500/50 text-orange-200 text-xs px-2 py-0.5 rounded font-mono">
                          🛑 Prompt Injection Guard
                        </span>
                      )}
                      {applyDiff.privacyGuardChanged && (
                        <span className="bg-fuchsia-950/60 border border-fuchsia-500/50 text-fuchsia-200 text-xs px-2 py-0.5 rounded font-mono">
                          🔒 Privacy / PII Masking
                        </span>
                      )}
                      {applyDiff.switchyardChanged && (
                        <span className="bg-indigo-950/60 border border-indigo-500/50 text-indigo-200 text-xs px-2 py-0.5 rounded font-mono">
                          🔀 Switchyard Balancer
                        </span>
                      )}
                      {applyDiff.modelGatewayChanged && (
                        <span className="bg-slate-800 border border-slate-600 text-slate-200 text-xs px-2 py-0.5 rounded font-mono">
                          🚪 Model Gateways
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="p-4 border-t border-gray-700 bg-gray-900 flex justify-end gap-2">
                <button
                  onClick={cancelApplyToRouter}
                  className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded font-medium transition"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmAction === 'deploy' ? confirmDeploy : confirmApplyToRouter}
                  className={`px-4 py-2 text-sm text-white rounded font-medium transition ${applyDiff.removed.length > 0 ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}
                >
                  {confirmAction === 'deploy' ? 'Deploy to local' : 'Apply to live router'}
                </button>
              </div>
            </div>
          </div>
        )}

        {isExportModalOpen && compiledConfigs && (
          <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 rounded-xl border border-gray-600 shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
              <div className="flex justify-between items-center p-4 border-b border-gray-700 bg-gray-900">
                <div className="flex items-center gap-3">
                  <h3 className="text-xl font-bold text-white flex items-center gap-2">
                    <span>🚀</span> Deployment &amp; Cluster Orchestrator
                  </h3>
                  <span className="text-xs bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full font-mono border border-emerald-500/30">
                    Tier: {selectedTier.toUpperCase()}
                  </span>
                </div>
                <button 
                  onClick={() => setIsExportModalOpen(false)}
                  className="text-gray-400 hover:text-white"
                >
                  ✕
                </button>
              </div>

              {/* Deployment Tier Selector */}
              <div className="p-4 bg-gray-900/80 border-b border-gray-700 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Select Deployment Target:</span>
                  {selectedTier === 'k3d' && orchestratorStatus?.k3d && !orchestratorStatus.k3d.running && (
                    <button
                      onClick={handleCreateCluster}
                      disabled={isCreatingCluster}
                      className="px-2.5 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded font-medium flex items-center gap-1.5 transition disabled:opacity-50"
                    >
                      <span>{isCreatingCluster ? '⏳' : '⚡'}</span>
                      <span>{isCreatingCluster ? 'Creating Cluster...' : 'Create k3d Cluster'}</span>
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedTier('k3d')}
                    className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between ${
                      selectedTier === 'k3d'
                        ? 'bg-cyan-950/60 border-cyan-500 shadow-md shadow-cyan-950/50'
                        : 'bg-gray-800/60 border-gray-700 hover:bg-gray-800'
                    }`}
                  >
                    <div className="font-semibold text-sm text-cyan-300 flex items-center gap-1.5">
                      <span>☸️</span> k3d / Helm Cluster
                    </div>
                    <div className="text-[11px] text-gray-400 mt-1">
                      {orchestratorStatus?.k3d?.running
                        ? `🟢 Active (${orchestratorStatus.k3d.nodesCount} nodes)`
                        : orchestratorStatus?.k3d?.exists
                        ? '🟡 Stopped'
                        : '⚪ Not created'}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setSelectedTier('compose')}
                    className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between ${
                      selectedTier === 'compose'
                        ? 'bg-blue-950/60 border-blue-500 shadow-md shadow-blue-950/50'
                        : 'bg-gray-800/60 border-gray-700 hover:bg-gray-800'
                    }`}
                  >
                    <div className="font-semibold text-sm text-blue-300 flex items-center gap-1.5">
                      <span>🐳</span> Docker Compose
                    </div>
                    <div className="text-[11px] text-gray-400 mt-1">
                      {orchestratorStatus?.compose?.running
                        ? `🟢 ${orchestratorStatus.compose.activeServices}/6 running`
                        : '⚪ Stack stopped'}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setSelectedTier('docker')}
                    className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between ${
                      selectedTier === 'docker'
                        ? 'bg-indigo-950/60 border-indigo-500 shadow-md shadow-indigo-950/50'
                        : 'bg-gray-800/60 border-gray-700 hover:bg-gray-800'
                    }`}
                  >
                    <div className="font-semibold text-sm text-indigo-300 flex items-center gap-1.5">
                      <span>📦</span> Standalone Docker
                    </div>
                    <div className="text-[11px] text-gray-400 mt-1">
                      {orchestratorStatus?.tools?.docker ? '🟢 Daemon active' : '⚪ Daemon stopped'}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setSelectedTier('local')}
                    className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between ${
                      selectedTier === 'local'
                        ? 'bg-emerald-950/60 border-emerald-500 shadow-md shadow-emerald-950/50'
                        : 'bg-gray-800/60 border-gray-700 hover:bg-gray-800'
                    }`}
                  >
                    <div className="font-semibold text-sm text-emerald-300 flex items-center gap-1.5">
                      <span>⚡</span> Local Native Host
                    </div>
                    <div className="text-[11px] text-gray-400 mt-1">
                      ~/.config/eluvix
                    </div>
                  </button>
                </div>
              </div>

              <div className="p-6 overflow-y-auto flex-1 space-y-6">

                {/* Live Deployment Logs Pane */}
                {deployLogs.length > 0 && (
                  <div className="p-3 bg-black/80 rounded-lg border border-gray-700 font-mono text-xs">
                    <div className="text-gray-400 border-b border-gray-800 pb-1 mb-2 font-semibold flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <span className="animate-pulse">●</span> Orchestrator Execution Log
                      </span>
                      <span className="text-[10px] text-gray-500">{deployLogs.length} events</span>
                    </div>
                    <div className="max-h-40 overflow-y-auto space-y-1 text-gray-300 select-text">
                      {deployLogs.map((log, idx) => (
                        <div key={idx} className="whitespace-pre-wrap">{log}</div>
                      ))}
                    </div>
                  </div>
                )}
                
                {compiledConfigs.eluvixJson && (
                  <div>
                    <h4 className="text-yellow-400 font-bold mb-2 flex items-center justify-between">
                      <span>Eluvix Live Config (~/.config/eluvix/config.json)</span>
                      <span className="text-[10px] bg-yellow-500/20 text-yellow-300 px-2 py-0.5 rounded font-mono">Synced to Runtime</span>
                    </h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-gray-300 overflow-x-auto border border-gray-700 font-mono text-xs">
                      {compiledConfigs.eluvixJson}
                    </pre>
                  </div>
                )}

                {compiledConfigs.bifrostYaml && (
                  <div>
                    <h4 className="text-emerald-400 font-bold mb-2">Bifrost / LiteLLM Gateway (bifrost.yaml)</h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-gray-300 overflow-x-auto border border-gray-700">
                      {compiledConfigs.bifrostYaml}
                    </pre>
                  </div>
                )}

                {compiledConfigs.agentRouterJson && compiledConfigs.agentRouterJson !== '{}' && (
                  <div>
                    <h4 className="text-yellow-400 font-bold mb-2">Agent Router (routing.json)</h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-gray-300 overflow-x-auto border border-gray-700">
                      {compiledConfigs.agentRouterJson}
                    </pre>
                  </div>
                )}

                {compiledConfigs.agentGatewayJson && compiledConfigs.agentGatewayJson !== '{}' && (
                  <div>
                    <h4 className="text-green-400 font-bold mb-2">Agent Gateway (gateway.json)</h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-gray-300 overflow-x-auto border border-gray-700">
                      {compiledConfigs.agentGatewayJson}
                    </pre>
                  </div>
                )}

                {compiledConfigs.privacyGuardSetup && (
                  <div>
                    <h4 className="text-emerald-400 font-bold mb-2">Privacy &amp; PII Guard (privacy.ts)</h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-gray-300 overflow-x-auto border border-gray-700">
                      {compiledConfigs.privacyGuardSetup}
                    </pre>
                  </div>
                )}

                {compiledConfigs.semanticRouterSetup && (
                  <div>
                    <h4 className="text-orange-400 font-bold mb-2">Semantic Router Setup (index.ts)</h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-gray-300 overflow-x-auto border border-gray-700">
                      {compiledConfigs.semanticRouterSetup}
                    </pre>
                  </div>
                )}

                {compiledConfigs.observabilitySetup && (
                  <div>
                    <h4 className="text-indigo-400 font-bold mb-2">Braintrust Observability (logger.ts)</h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-gray-300 overflow-x-auto border border-gray-700">
                      {compiledConfigs.observabilitySetup}
                    </pre>
                  </div>
                )}

                {compiledConfigs.antigravityConfig && (
                  <div>
                    <h4 className="text-cyan-400 font-bold mb-2 flex items-center justify-between">
                      <span>Google Antigravity Agent (Python SDK &amp; agy CLI Config)</span>
                      <span className="text-[10px] bg-cyan-500/20 text-cyan-300 px-2 py-0.5 rounded font-mono">Agent Spec</span>
                    </h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-gray-300 overflow-x-auto border border-gray-700 font-mono text-xs">
                      {compiledConfigs.antigravityConfig}
                    </pre>
                  </div>
                )}

                {compiledConfigs.codexConfig && (
                  <div>
                    <h4 className="text-emerald-400 font-bold mb-2 flex items-center justify-between">
                      <span>OpenAI Codex Agent (Python SDK &amp; codex-config.json)</span>
                      <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded font-mono">Codex Spec</span>
                    </h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-gray-300 overflow-x-auto border border-gray-700 font-mono text-xs">
                      {compiledConfigs.codexConfig}
                    </pre>
                  </div>
                )}

                {compiledConfigs.claudeCodeConfig && (
                  <div>
                    <h4 className="text-amber-400 font-bold mb-2 flex items-center justify-between">
                      <span>Claude Code CLI &amp; Agent (config.json &amp; Command Line)</span>
                      <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded font-mono">Claude Code Spec</span>
                    </h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-gray-300 overflow-x-auto border border-gray-700 font-mono text-xs">
                      {compiledConfigs.claudeCodeConfig}
                    </pre>
                  </div>
                )}

                {compiledConfigs.disaggregatedSetup && (
                  <div>
                    <h4 className="text-emerald-400 font-bold mb-2 flex items-center justify-between">
                      <span>Disaggregated Serving RDMA Launch Scripts (vLLM NIXL &amp; SGLang Mooncake)</span>
                      <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded font-mono">RDMA Manifest</span>
                    </h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-emerald-200 overflow-x-auto border border-emerald-900/60 font-mono text-xs whitespace-pre-wrap">
                      {compiledConfigs.disaggregatedSetup}
                    </pre>
                  </div>
                )}

                {compiledConfigs.confidentialSetup && (
                  <div>
                    <h4 className="text-purple-400 font-bold mb-2 flex items-center justify-between">
                      <span>Confidential Computing &amp; KBS Attestation (confidential.ts)</span>
                      <span className="text-[10px] bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded font-mono">TEE / RATS Spec</span>
                    </h4>
                    <pre className="bg-gray-950 p-4 rounded text-sm text-purple-200 overflow-x-auto border border-purple-900/60 font-mono text-xs whitespace-pre-wrap">
                      {compiledConfigs.confidentialSetup}
                    </pre>
                  </div>
                )}

              </div>
              <div className="p-4 border-t border-gray-700 bg-gray-900 flex items-center justify-between">
                <div>
                  {deployResult && (
                    <span className={deployResult.success ? "text-green-400 text-sm" : "text-red-400 text-sm"}>
                      {deployResult.message}
                    </span>
                  )}
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setIsExportModalOpen(false)}
                    className="px-4 py-2 border border-gray-600 hover:bg-gray-800 text-white rounded font-medium"
                    disabled={isDeploying}
                  >
                    Close
                  </button>
                  <button
                    onClick={handleDeploy}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-medium disabled:opacity-50 text-sm flex items-center gap-1.5 shadow-lg shadow-emerald-950/50"
                    title={`Submit and deploy configuration to ${selectedTier.toUpperCase()}`}
                    disabled={isDeploying || isCreatingCluster}
                  >
                    <span>{isDeploying ? '⏳' : '🚀'}</span>
                    <span>
                      {isDeploying
                        ? 'Deploying...'
                        : `Deploy to ${
                            selectedTier === 'k3d'
                              ? 'k3d Cluster (Helm)'
                              : selectedTier === 'compose'
                              ? 'Docker Compose'
                              : selectedTier === 'docker'
                              ? 'Docker Container'
                              : 'Local Host (~/.config)'
                          }`}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {isSaveAsOpen && (
          <SaveAsModal
            isOpen={isSaveAsOpen}
            onClose={() => setIsSaveAsOpen(false)}
            onSave={handleSaveAs}
            initialName={currentName}
            initialSlug={currentSlug}
            initialDescription={currentDescription}
            initialCategory={currentCategory}
            initialTags={currentTags}
            existingSlugs={layoutsList.map((l) => l.id)}
          />
        )}

        {isLayoutBrowserOpen && (
          <LayoutBrowserModal
            isOpen={isLayoutBrowserOpen}
            onClose={() => setIsLayoutBrowserOpen(false)}
            layouts={layoutsList}
            activeSlug={currentSlug}
            layoutsDir={layoutsDir}
            onSelectLayout={loadLayoutBySlug}
            onDeleteLayout={handleDeleteLayout}
            onDuplicateLayout={handleDuplicateLayout}
            onRestoreExamples={handleRestoreExamples}
          />
        )}

      </ReactFlowProvider>
    </div>
  );
}
