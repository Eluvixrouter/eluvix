#!/usr/bin/env bash
#
# Eluvix Docker Detection & Orchestration Script
# Detects Docker CLI & daemon, and manages the Eluvix service stack:
# switchyard, vllm-sr, ollama, vllm, agent-router, agentgateway
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ACTION="${1:-up}"

check_docker() {
  if ! command -v docker &>/dev/null; then
    echo "{\"installed\": false, \"running\": false, \"error\": \"Docker executable not found in PATH.\"}"
    return 1
  fi

  local version
  version="$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',' || echo 'unknown')"

  if ! docker info &>/dev/null; then
    echo "{\"installed\": true, \"running\": false, \"version\": \"${version}\", \"error\": \"Docker daemon is not running or accessible.\"}"
    return 1
  fi

  return 0
}

get_status() {
  if ! check_docker &>/dev/null; then
    check_docker || true
    return 0
  fi

  local version
  version="$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',' || echo 'unknown')"

  local services=("switchyard" "vllm-sr" "ollama" "vllm" "agent-router" "agentgateway")
  local ports=("8080" "8001" "11434" "8000" "8002" "8003")
  local json_services="["

  cd "${ROOT_DIR}"
  for i in "${!services[@]}"; do
    local s="${services[$i]}"
    local p="${ports[$i]}"
    local container_name="eluvix-${s}"
    local running=false
    local status="stopped"

    if docker ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
      running=true
      status="running"
    elif docker ps -a --format '{{.Names}}' | grep -q "^${container_name}$"; then
      status="exited"
    fi

    if [ "$i" -gt 0 ]; then json_services+=","; fi
    json_services+="{\"name\":\"${s}\",\"container\":\"${container_name}\",\"port\":${p},\"running\":${running},\"status\":\"${status}\"}"
  done
  json_services+="]"

  echo "{\"installed\": true, \"running\": true, \"version\": \"${version}\", \"services\": ${json_services}}"
}

spin_up() {
  echo "🔍 [Eluvix] Detecting Docker installation..."
  if ! check_docker &>/dev/null; then
    echo "❌ Docker is not installed or the daemon is not running."
    echo "Please install Docker (https://docs.docker.com/get-docker/) and start the service."
    exit 1
  fi

  echo "✅ Docker detected! ($(docker --version))"
  cd "${ROOT_DIR}"

  echo "🔍 [Eluvix] Checking for GPU acceleration..."
  if command -v nvidia-smi &>/dev/null; then
    echo "✅ NVIDIA GPU detected! Configuring hardware acceleration for vLLM and Ollama."
    cat <<EOF > docker-compose.override.yml
services:
  vllm:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
  ollama:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
EOF
  else
    echo "⚠️ No NVIDIA GPU detected. Proceeding with CPU-only inference."
    rm -f docker-compose.override.yml
  fi

  echo "🚀 [Eluvix] Spinning up containers (switchyard, vllm-sr, ollama, vllm, agent-router, agentgateway)..."
  docker compose up -d --build

  echo "📦 [Eluvix] Checking Ollama models..."
  # Wait briefly for Ollama to become responsive
  sleep 3
  if curl -s http://localhost:11434/api/tags | grep -q '\[\]' || ! curl -s http://localhost:11434/api/tags | grep -q 'smollm'; then
    echo "🚀 Pulling default model 'smollm:135m' into Ollama..."
    curl -s -X POST http://localhost:11434/api/pull -d '{"name": "smollm:135m"}' > /dev/null
    echo "✅ Model pulled."
  else
    echo "✅ Models already present in Ollama."
  fi

  echo "✨ Container stack successfully launched!"
  echo "--------------------------------------------------------"
  echo "  - Switchyard Balancer:    http://localhost:8080"
  echo "  - vLLM-sr Semantic Guard: http://localhost:8001"
  echo "  - Ollama Engine:          http://localhost:11434"
  echo "  - vLLM Inference Engine:  http://localhost:8000"
  echo "  - Agent Router:           http://localhost:8002"
  echo "  - Agent Gateway (MCP):    http://localhost:8003"
  echo "--------------------------------------------------------"
}

spin_down() {
  echo "🛑 [Eluvix] Stopping container stack..."
  cd "${ROOT_DIR}"
  docker compose down
  echo "✓ Containers stopped."
}

case "${ACTION}" in
  status)
    get_status
    ;;
  up|start)
    spin_up
    ;;
  down|stop)
    spin_down
    ;;
  restart)
    spin_down
    spin_up
    ;;
  *)
    echo "Usage: $0 {status|up|down|restart}"
    exit 1
    ;;
esac
