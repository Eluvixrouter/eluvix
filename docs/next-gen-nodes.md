# Next-Gen Visual Routing Nodes & Agent Harness Mesh

The Eluvix visual node studio ([`/editor`](file:///mnt/unreal/git/eluvix/apps/nextjs/src/app/editor)) provides drag-and-drop orchestration for modern AI inference pipelines. This document details the next-generation nodes available in Eluvix.

---

## 1. Engine & Disaggregation Nodes

### `SglangNode` (`sglangNode`)
High-throughput LLM serving node supporting the [SGLang](https://github.com/sgl-project/sglang) runtime with RadixAttention and Mooncake RDMA disaggregation.
- **Port**: Default `:30000`.
- **RadixAttention**: Automatic prefix caching across multi-turn prompts and branch trees.
- **Disaggregation Modes**:
  - `colocated`: Standard unified inference.
  - `prefill`: Dedicated high-batch prompt ingestion worker.
  - `decode`: Low-latency token generation worker.
  - `pd-router`: Mooncake cluster gateway managing distributed KV pools.
- **Connectors**: `mooncake`, `nixl`.

### `VllmNode` (`vllmNode`)
Production-grade inference engine node powered by [vLLM](https://github.com/vllm-project/vllm).
- **Disaggregation Panel**:
  - `mode`: `colocated | prefill | decode | pd-pair`.
  - `transferProtocol`: `NixlConnector` (GPUDirect RDMA) or `LMCacheConnectorV1`.
  - `kvPrecision`: `fp8_e4m3` (1 byte/elem) or `bf16` (2 bytes/elem).
  - `tensorParallelSize`: Multi-GPU partitioning (TP2, TP4, TP8).
  - `rdmaDevice`: ConnectX adapter (e.g. `mlx5_0`).

### `SwitchyardNode` (`switchyardNode`)
The central intelligent traffic balancer and cost-complexity router.
- **Strategies**:
  - `cost-complexity`: Grades prompt complexity (1 to 4) and routes to the cheapest adequate tier.
  - `prefill-isolation`: Evaluates token length and routes prompts $\ge$ threshold to dedicated prefill workers.
  - `lowest-latency`: Routes to the fastest responsive upstream based on rolling SQLite ping metrics.
  - `round-robin`: Distributes load evenly across all healthy target upstreams.
  - `priority`: Evaluates upstreams in descending priority order.
- **KV Prefix Affinity**: Hashes static system prompts and routes matching prefixes to the worker holding warm GPU cache.

---

## 2. Autonomous Agent & SWE Harness Nodes

### `HarnessNode` (`harnessNode`)
Connects the routing graph to autonomous software engineering (SWE) harnesses and coding agents:
- **Supported Frameworks**:
  - `openhands`: [OpenHands](https://github.com/All-Hands-AI/OpenHands) autonomous SWE agent runtime.
  - `devin`: Devin-compatible agent harness API.
  - `swebench`: Benchmark execution container.
  - `trueforge`: Native sovereign coding agent runner.
- **Session Modes**: `per-request`, `per-eluvix-session`, `persistent-workspace`.
- **Approval Policy**: `auto-approve-readonly`, `strict-interactive`, `headless-autonomous`.

### `SandboxNode` (`sandboxNode`)
Provides safe, isolated execution environments for tool calling, bash execution, and Python scripting:
- **Sandbox Backends**:
  - `docker-exec`: Ephemeral Docker container isolation with CPU and memory limits.
  - `gvisor`: User-space kernel sandbox (runsc) blocking unauthorized syscalls.
  - `firecracker`: MicroVM hardware-virtualized isolation for untrusted third-party code.
- **Network Policies**: `none` (air-gapped), `egress-allowlist`, `full-access`.

---

## 3. Memory & Context Augmentation Nodes

### `MemoryNode` (`memoryNode`)
Stateful memory retention system bridging agent interactions across sessions:
- **Engines**:
  - `graphiti`: Temporal knowledge graph extracting entities, episodic events, and relationships.
  - `mem0`: User preference and facts storage with semantic similarity lookup.
  - `letta`: Self-editing memory manager with working context and archival storage.
- **User Scoping**: Multi-tenant memory partition enforced by `userId` or authentication token.

### `KnowledgeBaseNode` (`knowledgeBaseNode`)
High-dimensional retrieval-augmented generation (RAG) node:
- **Engines**:
  - `lightrag`: Dual-level graph-based RAG indexing entities, high-level themes, and text chunks.
  - `vector`: Dense vector similarity via Qdrant, Milvus, or Pinecone.
- **Embedding Models**: Local (e.g., `bge-m3`, `nomic-embed`) or cloud endpoints.

### `SemanticCacheNode` (`semanticCacheNode`)
Zero-latency prompt and response deduplication cache:
- **Similarity Matching**: Computes cosine similarity of prompt embeddings against previous queries.
- **Threshold**: When similarity $\ge$ threshold (e.g. `0.92`), returns cached response in $< 2\text{ms}$.
- **Backends**: Embedded SQLite, Redis, or Milvus.

---

## 4. Governance, Consensus & Resilience Nodes

### `ConsensusNode` (`consensusNode`)
Multi-model tournament and arbitration arena:
- **Modes**:
  - `majority-vote`: Executes $N$ candidate models in parallel and returns the dominant output.
  - `judge`: A frontier judge model (e.g., Claude 3.7 Sonnet or GPT-4o) evaluates candidate answers against a rubric (`accuracy`, `conciseness`, `security`) and synthesizes the winning response.

### `FallbackChainNode` (`fallbackChainNode`)
Guarantees $100\%$ pipeline uptime with structured cascading fallbacks:
- **Tier 1 (Primary)**: Ultra-fast local engine (vLLM / SGLang / Ollama).
- **Tier 2 (Secondary)**: Large local checkpoint or high-throughput pool.
- **Tier 3 (Cloud Fallback)**: Frontier commercial API (OpenAI / Anthropic).
- Automatically triggers failover on timeout, GPU out-of-memory (OOM), or HTTP 5xx errors.
