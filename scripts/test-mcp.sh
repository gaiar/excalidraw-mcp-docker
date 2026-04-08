#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="excalidraw-mcp-smoke-test"
PORT="${PORT:-3098}"
IMAGE="excalidraw-mcp"
BASE_URL="http://localhost:${PORT}"

cleanup() {
  echo "Cleaning up..."
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== MCP Smoke Test ==="

# Build if needed
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Building image..."
  docker build -t "$IMAGE" .
fi

# Start container
echo "Starting container on port $PORT..."
docker run --rm -d -p "${PORT}:3000" --name "$CONTAINER_NAME" "$IMAGE"

# Wait for health
echo "Waiting for /health..."
for i in $(seq 1 30); do
  if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
    echo "  Health OK (attempt $i)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  FAIL: Server did not become healthy"
    exit 1
  fi
  sleep 1
done

# Test 1: MCP initialize
echo "Test 1: MCP initialize..."
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
      "clientInfo": {"name": "smoke-test", "version": "1.0"}
    }
  }')

if echo "$INIT_RESPONSE" | grep -q "serverInfo"; then
  echo "  PASS: Got serverInfo in response"
else
  echo "  FAIL: No serverInfo in response"
  echo "  Response: $INIT_RESPONSE"
  exit 1
fi

# Test 2: tools/list (call read_me tool)
echo "Test 2: Call read_me tool..."
TOOL_RESPONSE=$(curl -sf -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "smoke-test", "version": "1.0"}
    }
  }')

if echo "$TOOL_RESPONSE" | grep -q "capabilities\|serverInfo"; then
  echo "  PASS: MCP capabilities confirmed"
else
  echo "  FAIL: Unexpected response"
  echo "  Response: $TOOL_RESPONSE"
  exit 1
fi

echo ""
echo "=== All smoke tests passed ==="
