#!/usr/bin/env bash
set -euo pipefail

# Generate TLS certificates for Valkey.
# Idempotent: skips generation if certs already exist.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TLS_DIR="${SCRIPT_DIR}/tls"
DAYS=365

mkdir -p "${TLS_DIR}"

# Check if certs already exist
if [ -f "${TLS_DIR}/ca.crt" ] && [ -f "${TLS_DIR}/valkey-server.crt" ] && [ -f "${TLS_DIR}/valkey-client.crt" ]; then
  echo "[certs] TLS certificates already exist in ${TLS_DIR}, skipping generation."
  exit 0
fi

echo "[certs] Generating TLS certificates in ${TLS_DIR}..."

# --- CA ---
openssl genrsa -out "${TLS_DIR}/ca.key" 4096
openssl req -new -x509 -days "${DAYS}" \
  -key "${TLS_DIR}/ca.key" \
  -out "${TLS_DIR}/ca.crt" \
  -subj "/CN=Excalidraw MCP CA/O=Excalidraw MCP"

# --- Server certificate ---
openssl genrsa -out "${TLS_DIR}/valkey-server.key" 2048

# Server CSR with SAN
openssl req -new \
  -key "${TLS_DIR}/valkey-server.key" \
  -out "${TLS_DIR}/valkey-server.csr" \
  -subj "/CN=valkey/O=Excalidraw MCP" \
  -addext "subjectAltName=DNS:valkey,DNS:localhost,IP:127.0.0.1"

# Sign server cert with CA
openssl x509 -req -days "${DAYS}" \
  -in "${TLS_DIR}/valkey-server.csr" \
  -CA "${TLS_DIR}/ca.crt" \
  -CAkey "${TLS_DIR}/ca.key" \
  -CAcreateserial \
  -out "${TLS_DIR}/valkey-server.crt" \
  -copy_extensions copyall

# --- Client certificate ---
openssl genrsa -out "${TLS_DIR}/valkey-client.key" 2048

openssl req -new \
  -key "${TLS_DIR}/valkey-client.key" \
  -out "${TLS_DIR}/valkey-client.csr" \
  -subj "/CN=excalidraw-mcp/O=Excalidraw MCP" \
  -addext "subjectAltName=DNS:excalidraw-mcp,DNS:localhost"

openssl x509 -req -days "${DAYS}" \
  -in "${TLS_DIR}/valkey-client.csr" \
  -CA "${TLS_DIR}/ca.crt" \
  -CAkey "${TLS_DIR}/ca.key" \
  -CAcreateserial \
  -out "${TLS_DIR}/valkey-client.crt" \
  -copy_extensions copyall

# Clean up CSR files
rm -f "${TLS_DIR}"/*.csr "${TLS_DIR}"/*.srl

# Set permissions
# 644: readable by all Docker containers (self-signed, internal network only)
chmod 644 "${TLS_DIR}"/*.key
chmod 644 "${TLS_DIR}"/*.crt

echo "[certs] TLS certificates generated successfully."
echo "  CA:     ${TLS_DIR}/ca.crt"
echo "  Server: ${TLS_DIR}/valkey-server.crt"
echo "  Client: ${TLS_DIR}/valkey-client.crt"
