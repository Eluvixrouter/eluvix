# Docker service stand-ins

Every service defined in this directory is a **simulator**: a small Node
HTTP server (`server.mjs`) that mimics the shape of a real service's API
with canned, hardcoded, or heuristic responses. No model is loaded and no
real inference, routing, or gatewaying happens in any of them.

They exist so the Eluvix dashboard and orchestration flows can be
developed and exercised locally (`docker compose up`) without the real
stack. Treat their responses as fixtures, never as evidence of how the
real services behave — in particular:

| Directory      | Mimics                | Default port | Notes                                                        |
| -------------- | --------------------- | ------------ | ------------------------------------------------------------ |
| `switchyard/`  | Switchyard            | 8080         | Complexity scores come from keyword/length regex heuristics. |
| `vllm-sr/`     | vLLM Semantic Router  | 8001         | Prompt-guard verdicts are regex pattern matches.             |
| `vllm/`        | vLLM                  | 8000         | Chat completions are canned strings.                         |
| `agent-router/`| Agent router          | 8002         | Canned responses only.                                       |
| `agentgateway/`| Agentgateway          | 8003         | Canned responses only.                                       |

(Ollama in `docker-compose.yml` is the exception: it uses the real
`ollama/ollama` image.)

To run against real services instead, point the router config's upstream
endpoints at them (or run the real stacks) and don't start these
containers — the dashboard defaults to the same localhost ports the
simulators bind.
