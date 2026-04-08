# Progress: Excalidraw MCP Docker Conversion

## Phase 1: Audit + Tooling Setup ✅

- typecheck: ✅ pass (strict, noUncheckedIndexedAccess, noImplicitReturns)
- lint: ✅ 0 warnings, 0 errors (eslint v10 flat config)
- format: ✅ all files formatted (prettier singleQuote, trailingComma all)
- security: ⚠️ 36 transitive vulnerabilities in upstream deps — documented blocker
- tests: ✅ vitest configured with v8 coverage
- build: N/A

## Phase 2: Express Server ✅

- typecheck: ✅ pass
- lint: ✅ 0 warnings, 0 errors
- format: ✅ all files formatted
- security: ✅ no new vulns, no eval(), CORS + JSON parsing via MCP SDK
- tests: ✅ 5 tests (health, MCP init, invalid body, GET/DELETE)
- build: N/A

## Phase 3: Build Config ✅

- typecheck: ✅ pass
- lint: ✅ 0 warnings, 0 errors
- format: ✅ all files formatted
- security: ✅ esbuild bundles deps, no eval()
- tests: ✅ all pass
- build: ✅ dist/index.js (1.5MB), dist/server.js (1.4MB)

## Phase 4: Dockerfile ✅

- typecheck: ✅ pass
- lint: ✅ 0 warnings, 0 errors
- format: ✅ all files formatted
- security: ✅ non-root user (appuser:1001), no secrets, read_only in compose
- tests: ✅ all pass
- build: ✅ 152MB image (under 200MB), healthcheck configured

## Phase 5: Docker Compose ✅

- typecheck: ✅ pass
- lint: ✅ 0 warnings, 0 errors
- format: ✅ all files formatted
- security: ✅ read_only, mem_limit 256m, cpus 0.5
- tests: ✅ all pass
- build: ✅ docker compose up --build works

## Phase 6: MCP Protocol Smoke Test ✅

- typecheck: ✅ pass
- lint: ✅ 0 warnings, 0 errors
- format: ✅ all files formatted
- security: ✅ no issues
- tests: ✅ 21 tests, 80% line coverage; scripts/test-mcp.sh passes
- build: ✅ dist/index.js

## Phase 7: Documentation ✅

- typecheck: ✅ pass
- lint: ✅ 0 warnings, 0 errors
- format: ✅ all files formatted
- security: ✅ no issues
- tests: ✅ 21 tests pass
- build: ✅ dist/index.js

## Phase 8: Valkey Migration — Audit ✅

- AUDIT-VALKEY.md documents all Upstash Redis usage
- 2 Redis methods used: set, get
- Env vars: KV_REST_API_URL, KV_REST_API_TOKEN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
- Migration plan: create ValkeyCheckpointStore using ioredis

## Phase 9: Valkey Migration — ValkeyCheckpointStore ✅

- src/stores/valkey-checkpoint-store.ts: implements CheckpointStore with ioredis
- src/stores/valkey-checkpoint-store.test.ts: 20 unit tests with mocked ioredis
- Import fix: `import { Redis }` (named) instead of `import Redis` (default) for NodeNext compat
- TLS support, exponential backoff, graceful shutdown

## Phase 10: Valkey Migration — Store Factory ✅

- checkpoint-store.ts: `createStore()` with priority: Valkey > Upstash > File
- @upstash/redis moved to optionalDependencies
- ioredis added to dependencies

## Phase 11: TLS Certificates ✅

- docker/valkey/generate-certs.sh: idempotent cert generation (CA + server + client)
- docker/valkey/tls/ in .gitignore with .gitkeep
- SAN: valkey, localhost, 127.0.0.1
- Key permissions: 644 (readable by all containers, Docker-internal only)

## Phase 12: Docker Compose — Secure Stack ✅

- docker-compose.yml: dual network (frontend + backend)
- frontend: bridge (port publishing for app)
- backend: bridge, internal: true (Valkey isolated, no internet)
- Valkey: no exposed ports, TLS-only, ACL via entrypoint.sh
- docker/valkey/entrypoint.sh: generates ACL file from VALKEY_PASSWORD env var
- docker/valkey/valkey.conf: TLS config, persistence (RDB + AOF), 128MB memory limit
- .env.example with PORT and VALKEY_PASSWORD
- docker/setup.sh: first-time setup (certs + .env + compose up)

## Phase 13: Integration Tests ✅

- scripts/test-valkey-integration.sh: Docker Compose e2e test
  - Starts stack, healthchecks, MCP initialize, create_view with checkpoint
  - Restart stack (keep volumes), verify checkpoint persists
  - Hard fail on persistence verification
- scripts/test-valkey-integration.test.ts: 12 vitest tests
  - Full round-trip, simulated restart, TTL behavior, factory integration
- Total: 55 tests passing

## Phase 14: Repository Structure ✅

- .github/CODEOWNERS: @gaiar
- .github/PULL_REQUEST_TEMPLATE.md
- .github/ISSUE_TEMPLATE/bug_report.md
- .github/ISSUE_TEMPLATE/feature_request.md
- LICENSE: MIT, 2026, Gaiar Baimuratov

## Phase 15: GitHub Actions ✅

- .github/workflows/ci.yml: quality + docker-build-test jobs
- .github/workflows/docker-build.yml: multi-platform build + push to GHCR
- .github/workflows/release.yml: tag-triggered versioned release
- All validated with actionlint v1.7.7 — zero errors

## Phase 16: README ✅

- Full rewrite with 12 sections
- Architecture Mermaid diagram (Docker network layout)
- MCP sequence diagram (create/edit/restore flow)
- Configuration table (all env vars)
- Quick start, client config, security summary

## Phase 17: Security Documentation ✅

- SECURITY.md: threat model, network isolation, TLS, ACL, encryption at rest
- Container hardening, certificate management, secrets management
- What is NOT covered: no MCP auth/TLS, no rate limiting, no audit logging

## Final Verification ✅

1. pnpm run quality → ✅ all green (typecheck + lint + format + 55 tests)
2. pnpm run test:coverage → ✅ 86.27% line coverage (≥80%)
3. docker compose up --build → ✅ both containers running, healthy
4. curl health → ✅ {"status":"ok"}
5. bash scripts/test-mcp.sh → ✅ all smoke tests passed
6. bash scripts/test-valkey-integration.sh → ✅ checkpoints persist across restart
7. docker exec ping valkey → ✅ resolves (internal network)
8. valkey container external access → ✅ FAILS (bad address — isolated)
9. host valkey port → ✅ connection refused (not exposed)
10. GitHub Actions → ✅ validated with actionlint
11. README Mermaid → ✅ 2 diagrams present

## Known Issues

- **Security audit**: 36 transitive vulnerabilities from @excalidraw/excalidraw (dompurify, mermaid, lodash-es, nanoid) and @modelcontextprotocol/sdk (@hono/node-server). Cannot be fixed without upstream patches. No vulnerabilities in project code.
- **Port 3000 conflict**: Host has another service on port 3000. Tests use alternate ports (3097-3099). .env PORT can be configured.
- **Healthcheck IPv6**: Alpine `localhost` resolves to `[::1]` (IPv6) but Node binds `0.0.0.0` (IPv4 only). Fixed: healthchecks use `127.0.0.1`.

## Bugs Fixed During E2E Testing

- pnpm lockfile out of sync after @upstash/redis move to optionalDeps
- ioredis import: `{ Redis }` (named) vs `Redis` (default) for NodeNext module resolution
- TLS key permissions: 600 → 644 for cross-container access
- Valkey ACL: duplicate user (config + command line) → entrypoint.sh generates ACL file
- Valkey healthcheck: `-u` (URI) → `--user` (ACL username)
- Docker healthcheck: `localhost` (IPv6) → `127.0.0.1` (IPv4)
- Docker network: single `internal` network → split frontend/backend for port publishing
- Valkey command YAML: `>` folded scalar ate `>PASSWORD` syntax → entrypoint.sh approach
- Integration test: `.env` source overwrites PORT → save/restore pattern
