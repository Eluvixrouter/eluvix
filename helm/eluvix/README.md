# Eluvix Helm Chart

Deploys the Eluvix dashboard stack to Kubernetes. Local development uses
`values-local.yaml` via `scripts/k3d-cluster.sh`; production-shaped installs
start from `values-prod.yaml` — read that file's header first.

## What the chart actually deploys

Only five components, and three of them are canned-response simulators,
not the real services:

| Component | Image (default) | Real or simulator |
|---|---|---|
| switchyard | `eluvix-switchyard` | SIMULATOR (`docker/switchyard`) |
| nextjs | `eluvix-nextjs` | REAL dashboard (`apps/nextjs`) |
| ollama | `ollama/ollama` | REAL upstream image |
| agentRouter | `eluvix-agent-router` | SIMULATOR (`docker/agent-router`) |
| agentGateway | `eluvix-agentgateway` | SIMULATOR (`docker/agentgateway`) |

Default image tags are `latest` with `pullPolicy: IfNotPresent`, and the
image names are local-only: they exist in no registry. Only
`scripts/k3d-cluster.sh`'s local `docker build` + `k3d image import` makes
them resolvable. A plain `helm install` outside that script will leave
pods in ImagePullBackOff, and a "production" install with defaults serves
fixture responses from the sims. See `values-prod.yaml` for the production
starting point and the operator steps it requires (registry images, TLS,
`switchyard.authToken`).

## Services the chart does NOT cover

The compose stack defines 13 services; the chart covers 5. These have no
in-cluster equivalent — do not add them to the routing ConfigMap expecting
a backend, or the dashboard will show connection failures with no
explanation:

- Memory: `openviking`, `lightrag`, `graphiti`
- Harnesses: `trueforge`, `opencode`, `sandbox`
- Inference: `vllm`, `vllm-sr`, `sglang`

The chart's routing ConfigMap (`templates/configmap-routing.yaml`) lists
only the ollama upstream, so a Helm dashboard silently lacks the memory
and harness features the compose dashboard exposes. The `nextjs` service
is chart-only (it is not a compose service).

## Auth notes

- The switchyard sim's `/v1/config` endpoint is fail-closed: with
  `switchyard.authToken` empty it refuses all requests (503), and when
  set it requires the Bearer token on GET and POST. The ingress routes
  `/v1` to the switchyard service, so set the token (via `--set`, never
  committed) before expecting config reads/writes to work.
- The chart ships no TLS configuration (`ingress.tls: []`, traefik `web`
  entrypoint = plain HTTP). Production installs must add a TLS secret;
  see `values-prod.yaml`.

## Values files

- `values.yaml` — defaults (local-dev oriented despite the
  `global.environment: production` label).
- `values-local.yaml` — k3d local-dev overrides (NodePort services so the
  `k3d-config.yaml` host-port mappings land on real listeners; the
  low nodePorts here are only valid because `k3d-config.yaml` widens the
  apiserver NodePort range — see the comment in that file).
- `values-prod.yaml` — production starting point; read its header before
  using it.
