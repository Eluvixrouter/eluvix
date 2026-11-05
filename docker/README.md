# Docker service stand-ins

Most services defined in this directory are **simulators**: small Node
HTTP servers (`server.mjs`) that mimic the shape of a real service's API
with canned, hardcoded, or heuristic responses. No model is loaded and no
real inference, routing, or gatewaying happens in the simulators.

They exist so the Eluvix dashboard and orchestration flows can be
developed and exercised locally without the real stack. Treat simulator
responses as fixtures, never as evidence of how the real services behave.

| Directory      | Mimics                | Default port | Notes                                                        |
| -------------- | --------------------- | ------------ | ------------------------------------------------------------ |
| `switchyard/`  | Switchyard            | 8080         | Complexity scores come from keyword/length regex heuristics. |
| `vllm-sr/`     | vLLM Semantic Router  | 8001         | Prompt-guard verdicts are regex pattern matches.             |
| `vllm/`        | vLLM                  | 8000         | Chat completions are canned strings.                         |
| `agent-router/`| Agent router          | 8002         | Canned responses only.                                       |
| `agentgateway/`| Agentgateway          | 8003         | Canned responses only.                                       |
| `openviking/`  | OpenViking Memory     | 1933         | Hierarchical L0/L1/L2 memory recall and session commit.      |
| `trueforge/`   | TrueForge Harness     | 8790         | Turn-based SSE agent loop and tool approval events.          |
| `graphiti/`    | Graphiti Memory       | 8004         | In-memory graph store; state does not survive restarts.      |
| `lightrag/`    | LightRAG              | 9621         | In-memory retrieval index; state does not survive restarts.  |
| `opencode/`    | OpenCode Harness      | 4096         | Harness API stand-in with a `/health` endpoint.              |
| `sandbox/`     | Code Sandbox          | 3986         | Executes code via `node:vm` (not a security boundary per     |
|                |                       |              | Node's docs); the one sim that drops to the `node` user.     |

Not simulators — the exceptions to "everything here is canned":

- **Ollama** (root `docker-compose.yml`) uses the real
  `ollama/ollama` image.
- **SGLang** (`docker/compose/inference.yml`) uses the real
  `lmsysorg/sglang:latest` image.
- **Graphiti / LightRAG / Sandbox** (rows above) are stateful sidecars,
  not canned-response simulators: they hold real (in-memory) state or, for
  the sandbox, execute real code.

## Running them

Every service is profile-gated (`core`, `inference`, `memory`,
`harnesses`, `all`), so a bare `docker compose up` starts nothing. Use
the root compose with a profile, which also supplies the shared
`eluvix-net` network:

```bash
docker compose --profile core up -d
docker compose --profile memory --profile harnesses up -d
docker compose --profile all up -d
```

To run against real services instead, point the router config's upstream
endpoints at them (or run the real stacks) and don't start these
containers — the dashboard defaults to the same localhost ports the
simulators bind.
