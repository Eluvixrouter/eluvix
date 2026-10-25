# Modular Docker Compose Architecture

As Eluvix expanded from a lightweight routing gateway to a multi-agent orchestration platform, packing every engine, harness, memory database, and sandbox into a single monolithic `docker-compose.yml` became unwieldy and resource-intensive.

Eluvix provides a **split, pick-and-choose Docker Compose architecture** located in [`docker/compose/`](file:///mnt/unreal/git/eluvix/docker/compose).

---

## 1. Directory Structure

```
docker/
├── compose/
│   ├── core.yml          # Core Eluvix gateway, Next.js UI & SQLite volume
│   ├── inference.yml     # vLLM, SGLang, and Ollama inference engines
│   ├── harnesses.yml     # TrueForge, OpenHands SWE agent runners
│   └── memory.yml        # Graphiti, LightRAG, and OpenViking databases
├── README.md             # Quick reference for compose commands
└── ...
```

---

## 2. Compose Subsystems

### 1. Core Gateway (`core.yml`)
The minimal standalone footprint:
- **Services**:
  - `eluvix`: Next.js web application, visual node editor, and Switchyard routing engine.
- **Ports**: `3588` (HTTPS/HTTP dual-protocol auto-upgrade), `3580` (HTTP redirect).
- **Volumes**: `eluvix-data` mapped to `/app/data` (stores SQLite `request_logs`, `chat_history`, and layout definitions).

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
  - `openhands`: OpenHands software engineering harness (`:3000`).
- **Profile**: `--profile harness`.

### 4. Memory & Context Retrieval (`memory.yml`)
Context augmentation databases:
- **Services**:
  - `graphiti`: Temporal knowledge graph service (`:8000`).
  - `lightrag`: Dual-level graph-based RAG service (`:9621`).
  - `openviking`: Context database for episodic memory (`:1933`).
- **Profile**: `--profile memory`.

---

## 3. Usage & Deployment Recipes

### Minimal Core Only (Gateway + UI)
```bash
docker compose -f docker/compose/core.yml up -d
```

### Core + Local Inference (vLLM & SGLang)
```bash
docker compose -f docker/compose/core.yml -f docker/compose/inference.yml up -d
```

### Core + Memory & Knowledge Graphs
```bash
docker compose -f docker/compose/core.yml -f docker/compose/memory.yml up -d
```

### Full Production Mesh (All Subsystems)
```bash
docker compose \
  -f docker/compose/core.yml \
  -f docker/compose/inference.yml \
  -f docker/compose/harnesses.yml \
  -f docker/compose/memory.yml \
  up -d
```

### Inspecting Logs by Subsystem
```bash
# View only core gateway logs
docker compose -f docker/compose/core.yml logs -f eluvix

# View inference engine logs
docker compose -f docker/compose/inference.yml logs -f sglang vllm
```

### Tearing Down Subsystems Independently
```bash
# Stop inference without stopping the gateway
docker compose -f docker/compose/inference.yml down

# Stop entire stack
docker compose \
  -f docker/compose/core.yml \
  -f docker/compose/inference.yml \
  -f docker/compose/harnesses.yml \
  -f docker/compose/memory.yml \
  down
```
