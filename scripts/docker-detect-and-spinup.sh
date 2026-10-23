#!/usr/bin/env bash
#
# Eluvix Docker Detection & Orchestration Script
# Detects Docker CLI & daemon, GPU acceleration (NVIDIA CUDA / AMD ROCm / CPU),
# and manages the Eluvix service stack:
# switchyard, vllm-sr, ollama, vllm, agent-router, agentgateway
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ACTION="${1:-up}"
ARG2="${2:-}"

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

detect_and_configure_gpu() {
  local silent="${1:-false}"
  cd "${ROOT_DIR}"

  local gpu_vendor="cpu"
  local gfx_version="11.0.0"
  local model="CPU Fallback"

  # 1. Test NVIDIA GPU
  # Must satisfy: nvidia-smi executable exists and executes successfully (exit 0)
  # AND docker daemon has NVIDIA container support
  if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
    if docker info 2>/dev/null | grep -qi nvidia || docker run --rm --gpus all alpine true 2>/dev/null; then
      gpu_vendor="nvidia"
      model="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1 | tr -d '\r' || echo 'NVIDIA GPU')"
    elif [ "$silent" != "true" ]; then
      echo "⚠️ NVIDIA GPU hardware found, but Docker does not have NVIDIA Container Toolkit enabled. Falling back to AMD/CPU."
    fi
  fi

  # 2. Test AMD ROCm GPU (if NVIDIA was not selected)
  if [ "$gpu_vendor" = "cpu" ]; then
    local has_amd=false
    if [ -e /dev/kfd ] && [ -d /dev/dri ]; then
      has_amd=true
    elif [ -d /sys/module/amdgpu ]; then
      has_amd=true
    elif command -v rocminfo &>/dev/null && rocminfo 2>/dev/null | grep -qi amd; then
      has_amd=true
    elif [ -x /opt/rocm/bin/rocminfo ] && /opt/rocm/bin/rocminfo 2>/dev/null | grep -qi amd; then
      has_amd=true
    fi

    if [ "$has_amd" = true ]; then
      gpu_vendor="amd"
      local gfx_target=""
      if command -v rocminfo &>/dev/null; then
        gfx_target="$(rocminfo 2>/dev/null | grep -o 'gfx[0-9]*' | head -n1 || true)"
      elif [ -x /opt/rocm/bin/rocminfo ]; then
        gfx_target="$(/opt/rocm/bin/rocminfo 2>/dev/null | grep -o 'gfx[0-9]*' | head -n1 || true)"
      fi

      case "$gfx_target" in
        gfx11*) gfx_version="11.0.0" ;;
        gfx103*) gfx_version="10.3.0" ;;
        gfx101*) gfx_version="10.1.0" ;;
        gfx9*) gfx_version="9.0.0" ;;
        *) gfx_version="11.0.0" ;;
      esac

      # Extract marketing name or lspci description
      if [ -x /opt/rocm/bin/rocminfo ]; then
        model="$(/opt/rocm/bin/rocminfo 2>/dev/null | grep 'Marketing Name:' | grep -iE 'Graphics|Instinct|Radeon' | tail -n1 | sed 's/.*Marketing Name:[[:space:]]*//' | awk '{$1=$1};1' || true)"
      elif command -v rocminfo &>/dev/null; then
        model="$(rocminfo 2>/dev/null | grep 'Marketing Name:' | grep -iE 'Graphics|Instinct|Radeon' | tail -n1 | sed 's/.*Marketing Name:[[:space:]]*//' | awk '{$1=$1};1' || true)"
      fi

      if [ -z "$model" ]; then
        model="$(lspci 2>/dev/null | grep -iE 'vga|3d|display' | grep -i amd | head -n1 | sed 's/.*: //' | awk '{$1=$1};1' || true)"
      fi

      if [ -z "$model" ]; then
        model="AMD Radeon / Instinct (ROCm)"
      fi
    fi
  fi

  # Apply Docker Compose Override configuration
  if [ "$gpu_vendor" = "nvidia" ]; then
    cat <<EOF > docker-compose.override.yml
# Eluvix Hardware Override - NVIDIA CUDA Acceleration
services:
  ollama:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
EOF
    if [ "$silent" != "true" ]; then
      echo "✅ NVIDIA GPU detected ($model). Configured NVIDIA CUDA container acceleration."
    fi
  elif [ "$gpu_vendor" = "amd" ]; then
    cat <<EOF > docker-compose.override.yml
# Eluvix Hardware Override - AMD ROCm Acceleration
services:
  ollama:
    image: ollama/ollama:rocm
    devices:
      - /dev/kfd:/dev/kfd
      - /dev/dri:/dev/dri
    environment:
      - OLLAMA_IGPU_ENABLE=1
      - HSA_OVERRIDE_GFX_VERSION=${gfx_version}
EOF
    if [ "$silent" != "true" ]; then
      echo "✅ AMD GPU detected ($model, gfx target: ${gfx_version}). Configured AMD ROCm container acceleration."
    fi
  else
    rm -f docker-compose.override.yml
    if [ "$silent" != "true" ]; then
      echo "ℹ️ No dedicated NVIDIA or AMD ROCm GPU configured. Using CPU-only inference."
    fi
  fi

  if [ "$silent" = "true" ]; then
    echo "{\"vendor\":\"${gpu_vendor}\",\"model\":\"${model}\",\"gfxVersion\":\"${gfx_version}\"}"
  fi
}

get_status() {
  if ! check_docker &>/dev/null; then
    check_docker || true
    return 0
  fi

  local version
  version="$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',' || echo 'unknown')"

  local services=("switchyard" "vllm-sr" "ollama" "vllm" "agent-router" "agentgateway" "openviking" "trueforge")
  local ports=("8080" "8001" "11434" "8000" "8002" "8003" "1933" "8790")
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

  echo "🔍 [Eluvix] Detecting hardware acceleration (NVIDIA CUDA / AMD ROCm / CPU)..."
  detect_and_configure_gpu "false" > /dev/null

  echo "🚀 [Eluvix] Spinning up containers (switchyard, vllm-sr, ollama, vllm, agent-router, agentgateway, openviking, trueforge)..."
  docker compose up -d --build

  echo "📦 [Eluvix] Waiting for Ollama to become ready..."
  # Poll the Ollama API until it actually answers (bounded: 30 x 2s = 60s).
  # A fixed sleep + `curl || true` reported success with Ollama down and no
  # model pulled; success lines below print only after the checks pass.
  local ollama_ready=false
  local attempt
  for attempt in $(seq 1 30); do
    if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
      ollama_ready=true
      break
    fi
    sleep 2
  done
  if [ "$ollama_ready" != "true" ]; then
    echo "❌ Ollama did not become ready at http://localhost:11434 within 60s."
    echo "   Inspect 'docker compose logs ollama', fix the cause, and re-run."
    exit 1
  fi

  echo "📦 [Eluvix] Checking Ollama models..."
  if curl -s http://localhost:11434/api/tags | grep -q 'smollm'; then
    echo "✅ Models already present in Ollama."
  else
    echo "🚀 Pulling default model 'smollm:135m' into Ollama..."
    if ! curl -sf -X POST http://localhost:11434/api/pull -d '{"name": "smollm:135m"}' > /dev/null; then
      echo "❌ Failed to pull model 'smollm:135m' from Ollama."
      exit 1
    fi
    echo "✅ Model check complete."
  fi

  echo "✨ Container stack successfully launched!"
  echo "--------------------------------------------------------"
  echo "  - Switchyard Balancer:    http://localhost:8080"
  echo "  - vLLM-sr Semantic Guard: http://localhost:8001"
  echo "  - Ollama Engine:          http://localhost:11434"
  echo "  - vLLM Inference Engine:  http://localhost:8000"
  echo "  - Agent Router:           http://localhost:8002"
  echo "  - Agent Gateway (MCP):    http://localhost:8003"
  echo "  - OpenViking Context DB:  http://localhost:1933"
  echo "  - TrueForge Agent Harness:http://localhost:8790"
  echo "--------------------------------------------------------"
}

spin_down() {
  echo "🛑 [Eluvix] Stopping container stack..."
  cd "${ROOT_DIR}"
  docker compose down
  echo "✓ Containers stopped."
}

case "${ACTION}" in
  detect)
    if [ "${ARG2}" = "--json" ]; then
      detect_and_configure_gpu "true"
    else
      detect_and_configure_gpu "false"
    fi
    ;;
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
    echo "Usage: $0 {detect|status|up|down|restart} [--json]"
    exit 1
    ;;
esac
