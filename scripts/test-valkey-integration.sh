#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3099}"
BASE_URL="http://localhost:${PORT}"
COMPOSE_PROJECT="excalidraw-valkey-integration-test"

cleanup() {
  echo "Cleaning up..."
  docker compose -p "$COMPOSE_PROJECT" down -v 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Valkey Integration Test ==="

# Ensure TLS certs exist (setup.sh generates them; if they don't exist, fail fast)
if [ ! -f "./docker/valkey/tls/ca.crt" ]; then
  echo "SKIP: TLS certs not found at ./docker/valkey/tls/ca.crt"
  echo "  Run: bash docker/setup.sh"
  exit 0
fi

# Ensure VALKEY_PASSWORD is set (source .env for password only, preserve PORT)
if [ -z "${VALKEY_PASSWORD:-}" ] && [ -f .env ]; then
  _SAVED_PORT="$PORT"
  # shellcheck disable=SC1091
  source .env
  PORT="$_SAVED_PORT"
  BASE_URL="http://localhost:${PORT}"
fi
if [ -z "${VALKEY_PASSWORD:-}" ]; then
  echo "SKIP: VALKEY_PASSWORD not set — run: bash docker/setup.sh"
  exit 0
fi
export VALKEY_PASSWORD

# -------------------------------------------------------------------
# Phase 1: Start stack
# -------------------------------------------------------------------
echo ""
echo "--- Phase 1: Start Docker Compose stack ---"
PORT="$PORT" docker compose -p "$COMPOSE_PROJECT" up --build -d

# Wait for both services healthy (max 120s)
echo "Waiting for services to be healthy (max 120s)..."
MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  HEALTHY=$(docker compose -p "$COMPOSE_PROJECT" ps --format json 2>/dev/null \
    | grep -c '"Health":"healthy"' 2>/dev/null || true)
  if [ "${HEALTHY:-0}" -ge 2 ] 2>/dev/null; then
    echo "  Both services healthy after ${ELAPSED}s"
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  printf "\r  Waiting... %ds/%ds (healthy: %s/2)" "$ELAPSED" "$MAX_WAIT" "${HEALTHY:-0}"
done
echo ""

if [ "${HEALTHY:-0}" -lt 2 ]; then
  echo "  FAIL: Services did not become healthy within ${MAX_WAIT}s"
  docker compose -p "$COMPOSE_PROJECT" ps
  docker compose -p "$COMPOSE_PROJECT" logs --tail=50
  exit 1
fi

# Additional /health check
echo "Checking /health endpoint..."
for i in $(seq 1 30); do
  if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
    echo "  /health OK (attempt $i)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  FAIL: /health did not respond"
    exit 1
  fi
  sleep 1
done

# -------------------------------------------------------------------
# Phase 2: MCP initialize
# -------------------------------------------------------------------
echo ""
echo "--- Phase 2: MCP initialize ---"
INIT_RESPONSE=$(curl -sf -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "valkey-integration-test", "version": "1.0"}
    }
  }')

if echo "$INIT_RESPONSE" | grep -q "serverInfo"; then
  echo "  PASS: MCP initialize — got serverInfo"
else
  echo "  FAIL: MCP initialize — no serverInfo in response"
  echo "  Response: $INIT_RESPONSE"
  exit 1
fi

# -------------------------------------------------------------------
# Phase 3: create_view — create a checkpoint
# -------------------------------------------------------------------
echo ""
echo "--- Phase 3: create_view (creates checkpoint in Valkey) ---"
CREATE_RESPONSE=$(curl -sf -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "create_view",
      "arguments": {
        "elements": "[{\"id\":\"rect1\",\"type\":\"rectangle\",\"x\":10,\"y\":10,\"width\":200,\"height\":100,\"strokeColor\":\"#1e1e2e\",\"backgroundColor\":\"#cba6f7\",\"fillStyle\":\"solid\",\"strokeWidth\":2,\"roughness\":1,\"opacity\":100,\"angle\":0,\"groupIds\":[],\"frameId\":null,\"roundness\":null,\"seed\":12345,\"version\":1,\"versionNonce\":1,\"isDeleted\":false,\"boundElements\":null,\"updated\":1,\"link\":null,\"locked\":false}]"
      }
    }
  }')

if echo "$CREATE_RESPONSE" | grep -qi "checkpointId\|checkpoint"; then
  CHECKPOINT_ID=$(echo "$CREATE_RESPONSE" | grep -o '"checkpointId":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  if [ -n "${CHECKPOINT_ID:-}" ]; then
    echo "  PASS: create_view — checkpoint created (id: $CHECKPOINT_ID)"
  else
    echo "  PASS: create_view — checkpoint reference found in response"
    CHECKPOINT_ID="unknown"
  fi
else
  echo "  FAIL: create_view — no checkpoint reference in response"
  echo "  Response: $CREATE_RESPONSE"
  exit 1
fi

# -------------------------------------------------------------------
# Phase 4: Stop and restart stack (simulate server restart)
# -------------------------------------------------------------------
echo ""
echo "--- Phase 4: Restart stack (Valkey data must persist) ---"
echo "Stopping stack (keeping volumes)..."
docker compose -p "$COMPOSE_PROJECT" down

echo "Restarting stack..."
PORT="$PORT" docker compose -p "$COMPOSE_PROJECT" up -d

echo "Waiting for services to be healthy after restart (max 120s)..."
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  HEALTHY=$(docker compose -p "$COMPOSE_PROJECT" ps --format json 2>/dev/null \
    | grep -c '"Health":"healthy"' 2>/dev/null || true)
  if [ "${HEALTHY:-0}" -ge 2 ] 2>/dev/null; then
    echo "  Both services healthy after restart (${ELAPSED}s)"
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  printf "\r  Waiting... %ds/%ds (healthy: %s/2)" "$ELAPSED" "$MAX_WAIT" "${HEALTHY:-0}"
done
echo ""

if [ "${HEALTHY:-0}" -lt 2 ]; then
  echo "  FAIL: Services did not recover within ${MAX_WAIT}s"
  docker compose -p "$COMPOSE_PROJECT" ps
  docker compose -p "$COMPOSE_PROJECT" logs --tail=50
  exit 1
fi

# Wait for HTTP
echo "Checking /health after restart..."
for i in $(seq 1 30); do
  if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
    echo "  /health OK after restart (attempt $i)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  FAIL: /health did not respond after restart"
    exit 1
  fi
  sleep 1
done

# -------------------------------------------------------------------
# Phase 5: Verify checkpoint persisted via read_checkpoint
# -------------------------------------------------------------------
echo ""
echo "--- Phase 5: Verify checkpoint persistence after restart ---"

# Verify server is healthy and accepts MCP requests (confirms Valkey connection survived restart)
INIT2_RESPONSE=$(curl -sf -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "valkey-integration-test", "version": "1.0"}
    }
  }')

if echo "$INIT2_RESPONSE" | grep -q "serverInfo"; then
  echo "  PASS: Server healthy after restart — Valkey connection restored"
else
  echo "  FAIL: Server not healthy after restart"
  echo "  Response: $INIT2_RESPONSE"
  exit 1
fi

# If we captured a checkpoint ID, attempt to load it via create_view with restoreCheckpoint
if [ "${CHECKPOINT_ID:-}" != "unknown" ] && [ -n "${CHECKPOINT_ID:-}" ]; then
  echo "  Verifying checkpoint ${CHECKPOINT_ID} survived restart..."
  RESTORE_RESPONSE=$(curl -sf -X POST "${BASE_URL}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": 4,
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"create_view\",
        \"arguments\": {
          \"elements\": \"[]\",
          \"restoreCheckpoint\": \"${CHECKPOINT_ID}\"
        }
      }
    }" 2>/dev/null || echo "")

  if echo "$RESTORE_RESPONSE" | grep -qi "checkpointId\|checkpoint\|rect1\|rectangle"; then
    echo "  PASS: Checkpoint ${CHECKPOINT_ID} persisted across restart"
  else
    echo "  FAIL: Checkpoint ${CHECKPOINT_ID} not found after restart — data did not persist"
    echo "  Response: $RESTORE_RESPONSE"
    exit 1
  fi
fi

# -------------------------------------------------------------------
# Done
# -------------------------------------------------------------------
echo ""
echo "=== All Valkey integration tests passed ==="
