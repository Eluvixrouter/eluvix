#!/usr/bin/env bash
#
# Eluvix k3d Kubernetes Cluster Orchestration Script
# Manages local multi-node k3d cluster and Helm release for Eluvix
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLUSTER_NAME="${ELUVIX_CLUSTER_NAME:-eluvix-local}"
NAMESPACE="${ELUVIX_NAMESPACE:-eluvix}"
K3D_CONFIG="${ROOT_DIR}/k3d-config.yaml"

ACTION="${1:-status}"

check_prereqs() {
  local missing=()
  for cmd in docker k3d kubectl helm; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done

  if [ ${#missing[@]} -gt 0 ]; then
    echo "{\"installed\": false, \"error\": \"Missing required tools: ${missing[*]}\"}"
    return 1
  fi

  if ! docker info &>/dev/null; then
    echo "{\"installed\": true, \"running\": false, \"error\": \"Docker daemon is not running.\"}"
    return 1
  fi

  return 0
}

get_status() {
  if ! check_prereqs &>/dev/null; then
    check_prereqs || true
    return 0
  fi

  local k3d_ver kubectl_ver helm_ver
  k3d_ver="$(k3d version 2>/dev/null | head -n 1 | awk '{print $3}' || echo 'unknown')"
  kubectl_ver="$(kubectl version --client -o json 2>/dev/null | grep -o '"gitVersion": *"[^"]*"' | head -n 1 | cut -d'"' -f4 || echo 'unknown')"
  helm_ver="$(helm version --short 2>/dev/null || echo 'unknown')"

  local cluster_exists=false
  local cluster_running=false
  local nodes="[]"
  local pods="[]"
  local release_status="not_installed"

  if k3d cluster list --no-headers 2>/dev/null | grep -q "^${CLUSTER_NAME}\b"; then
    cluster_exists=true
    if kubectl cluster-info --context "k3d-${CLUSTER_NAME}" &>/dev/null; then
      cluster_running=true
      
      # Query nodes
      nodes="$(kubectl get nodes --context "k3d-${CLUSTER_NAME}" -o json 2>/dev/null | jq -c '[.items[] | {name: .metadata.name, status: .status.conditions[-1].type, ready: (.status.conditions[-1].status == "True"), roles: (.metadata.labels | to_entries | map(select(.key | contains("node-role.kubernetes.io/"))) | map(.key | split("/") | .[1]))}]' 2>/dev/null || echo '[]')"

      # Query pods in eluvix namespace
      pods="$(kubectl get pods -n "${NAMESPACE}" --context "k3d-${CLUSTER_NAME}" -o json 2>/dev/null | jq -c '[.items[] | {name: .metadata.name, status: .status.phase, ready: (.status.containerStatuses[0].ready // false), restarts: (.status.containerStatuses[0].restartCount // 0), component: .metadata.labels["app.kubernetes.io/component"]}]' 2>/dev/null || echo '[]')"

      # Query helm release
      if helm status eluvix -n "${NAMESPACE}" --kube-context "k3d-${CLUSTER_NAME}" &>/dev/null; then
        release_status="deployed"
      fi
    fi
  fi

  cat <<EOF
{
  "installed": true,
  "dockerRunning": true,
  "tools": {
    "k3d": "${k3d_ver}",
    "kubectl": "${kubectl_ver}",
    "helm": "${helm_ver}"
  },
  "cluster": {
    "name": "${CLUSTER_NAME}",
    "context": "k3d-${CLUSTER_NAME}",
    "exists": ${cluster_exists},
    "running": ${cluster_running},
    "nodes": ${nodes}
  },
  "release": {
    "name": "eluvix",
    "namespace": "${NAMESPACE}",
    "status": "${release_status}",
    "pods": ${pods}
  }
}
EOF
}

cluster_up() {
  echo "🔍 [Eluvix k3d] Checking prerequisites..."
  check_prereqs

  cd "${ROOT_DIR}"
  if k3d cluster list --no-headers 2>/dev/null | grep -q "^${CLUSTER_NAME}\b"; then
    echo "ℹ️ Cluster '${CLUSTER_NAME}' already exists. Ensuring nodes are active..."
    k3d cluster start "${CLUSTER_NAME}" || true
  else
    echo "🚀 Creating k3d cluster '${CLUSTER_NAME}' with load balancer ports (3588, 8080, 11434)..."
    k3d cluster create --config "${K3D_CONFIG}"
  fi

  echo "⏳ Waiting for cluster nodes to become ready..."
  kubectl wait --for=condition=Ready nodes --all --context "k3d-${CLUSTER_NAME}" --timeout=90s

  echo "📦 Ensuring namespace '${NAMESPACE}' exists..."
  kubectl create namespace "${NAMESPACE}" --context "k3d-${CLUSTER_NAME}" --dry-run=client -o yaml | kubectl apply --context "k3d-${CLUSTER_NAME}" -f -

  echo "🚀 Deploying Eluvix Helm Chart..."
  helm upgrade --install eluvix "${ROOT_DIR}/helm/eluvix" \
    -f "${ROOT_DIR}/helm/eluvix/values-local.yaml" \
    --namespace "${NAMESPACE}" \
    --kube-context "k3d-${CLUSTER_NAME}"

  echo "✨ k3d Cluster and Eluvix Helm release successfully provisioned!"
  echo "--------------------------------------------------------"
  echo "  - Web Dashboard:       http://localhost:3588"
  echo "  - Switchyard Gateway:  http://localhost:8080/v1"
  echo "  - Ollama Engine:       http://localhost:11434"
  echo "  - Kubernetes Context:  k3d-${CLUSTER_NAME}"
  echo "--------------------------------------------------------"
}

cluster_down() {
  echo "🛑 [Eluvix k3d] Deleting cluster '${CLUSTER_NAME}'..."
  k3d cluster delete "${CLUSTER_NAME}" || true
  echo "✓ Cluster deleted."
}

case "${ACTION}" in
  status)
    get_status
    ;;
  up|start)
    cluster_up
    ;;
  down|delete|stop)
    cluster_down
    ;;
  restart)
    cluster_down
    cluster_up
    ;;
  deploy)
    echo "🚀 Deploying/Upgrading Eluvix Helm release..."
    helm upgrade --install eluvix "${ROOT_DIR}/helm/eluvix" \
      -f "${ROOT_DIR}/helm/eluvix/values-local.yaml" \
      --namespace "${NAMESPACE}" \
      --kube-context "k3d-${CLUSTER_NAME}"
    ;;
  *)
    echo "Usage: $0 {status|up|down|restart|deploy}"
    exit 1
    ;;
esac
