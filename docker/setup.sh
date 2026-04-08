#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"

cd "${PROJECT_DIR}"

echo "=== Excalidraw MCP Docker Setup ==="
echo ""

# Step 1: Generate TLS certificates if needed
echo "[1/4] Checking TLS certificates..."
bash "${SCRIPT_DIR}/valkey/generate-certs.sh"

# Step 2: Create .env if needed
if [ ! -f .env ]; then
  echo "[2/4] Creating .env with random password..."
  RANDOM_PW=$(openssl rand -base64 32)
  cp .env.example .env
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|CHANGE_ME_TO_A_STRONG_RANDOM_PASSWORD|${RANDOM_PW}|" .env
  else
    sed -i "s|CHANGE_ME_TO_A_STRONG_RANDOM_PASSWORD|${RANDOM_PW}|" .env
  fi
  echo "  Generated .env with random VALKEY_PASSWORD"
else
  echo "[2/4] .env already exists, skipping."
fi

# Step 3: Build and start
echo "[3/4] Building and starting containers..."
docker compose up --build -d

# Step 4: Wait for health
echo "[4/4] Waiting for services to be healthy..."
MAX_WAIT=60
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  HEALTHY=$(docker compose ps --format json 2>/dev/null | grep -c '"healthy"' || true)
  TOTAL=$(docker compose ps --format json 2>/dev/null | grep -c '"running"\|"healthy"' || true)
  if [ "$HEALTHY" -ge 2 ] 2>/dev/null; then
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  printf "\r  Waiting... %ds/%ds (healthy: %s)" "$ELAPSED" "$MAX_WAIT" "$HEALTHY"
done
echo ""

# Final status
echo ""
echo "=== Status ==="
docker compose ps
echo ""
echo "=== Connection ==="
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo "3000")
echo "  MCP endpoint: http://localhost:${PORT}/mcp"
echo "  Health check: http://localhost:${PORT}/health"
echo ""
echo "=== Claude Desktop config ==="
cat <<EOF
{
  "excalidraw": {
    "url": "http://localhost:${PORT}/mcp"
  }
}
EOF
