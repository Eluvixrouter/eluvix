# Modular Docker Compose Architecture

As Eluvix expanded from a lightweight routing gateway to a multi-agent orchestration platform, packing every engine, harness, memory database, and sandbox into a single monolithic `docker-compose.yml` became unwieldy and resource-intensive.

Eluvix provides a **split, pick-and-choose Docker Compose architecture** located in [`docker/compose/`](file:///mnt/unreal/git/eluvix/docker/compose).

---

## 1. Directory Structure

```
docker/
├── compose/
│   ├── core.yml          # Switchyard, vLLM-SR, agent-router & agentgateway sims
│   ├── inference.yml     # vLLM, SGLang, and Ollama inference engines
│   ├── harnesses.yml     # TrueForge, OpenCode & sandbox agent runners
│   └── memory.yml        # Graphiti, LightRAG, and OpenViking databases
├── README.md             # Quick reference for compose commands
└── ...
```

---

## 2. Compose Subsystems

### 1. Core Gateway (`core.yml`)
The minimal standalone footprint — the four canned-response simulator
services the dashboard talks to locally (no Next.js app, no SQLite
volume in this file):
- **Services**:
  - `switchyard`: Switchyard routing-engine sim (`:8080`).
  - `vllm-sr`: vLLM semantic-router sim (`:8001`).
  - `agent-router`: agent-router sim (`:8002`).
  - `agentgateway`: agent-gateway (MCP tool server) sim (`:8003`).
- **Volumes**: none — `switchyard`, `agent-router`, and `agentgateway`
  mount `docker/runtime-config` read-only for their config. There is no
  `eluvix-data` volume and no `eluvix` service in any compose file; the
  Next.js dashboard (`:3588`, HTTP redirect `:3580`) runs from
  `apps/nextjs` (local `pnpm dev` or `docker-compose.prod.yml`), not
  from `core.yml`.

### 2. Local Inference Pool (`inference.yml`)
GPU-accelerated local inference containers:
- **Services**:
  - `vllm`: vLLM high-throughput engine with PagedAttention (`:8000`).
  - `sglang`: SGLang engine with RadixAttention and Mooncake connector (`:30000`).
  - `ollama`: Ollama desktop model runner (`:11434`).
- **Profile**: `--profile inference`.
- **GPU Passthrough**: Configured for NVIDIA Container Toolkit (`all` GPUs or specific device IDs).

### 3. Agent & SWE Harnesses (`harnesses.yml`)
Autonomous coding agent runtimes:
- **Services**:
  - `trueforge`: Native sovereign coding agent container (`:8790`).
  - `opencode`: Eluvix-forked OpenCode coding agent server (`:4096`).
  - `sandbox`: Execution sandbox server (`:3986`).
- **Profile**: `--profile harness`.

### 4. Memory & Context Retrieval (`memory.yml`)
Context augmentation databases:
- **Services**:
  - `graphiti`: Temporal knowledge graph service (`:8004`).
  - `lightrag`: Dual-level graph-based RAG service (`:9621`).
  - `openviking`: Context database for episodic memory (`:1933`).
- **Profile**: `--profile memory`.

---

## 3. Usage & Deployment Recipes

### Minimal Core Only (Gateway + UI)
```bash
docker compose --profile core up -d
```

### Core + Local Inference (vLLM & SGLang)
```bash
docker compose --profile core --profile inference up -d
```

### Core + Memory & Knowledge Graphs
```bash
docker compose --profile core --profile memory up -d
```

### Full Production Mesh (All Subsystems)
```bash
docker compose --profile core --profile inference --profile harnesses --profile memory up -d
```

### Inspecting Logs by Subsystem
```bash
# View only core gateway logs
docker compose logs -f switchyard

# View inference engine logs
docker compose logs -f sglang vllm
```

### Tearing Down Subsystems Independently
```bash
# Stop inference without stopping the gateway
docker compose --profile inference down

# Stop entire stack
docker compose --profile core --profile inference --profile harnesses --profile memory down
```
