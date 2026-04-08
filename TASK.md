# Task: Excalidraw MCP — Valkey Migration & GitHub Deployment

## ⚠️ CRITICAL: Research Before You Code

Today is April 8, 2026. Your training cutoff is mid-2025 — over 10 months stale. DO NOT assume anything about APIs, package versions, or configurations.

**Before writing ANY code, you MUST:**
1. `cat` every relevant source file. Understand what's actually there.
2. Use **Context7** (`context7:resolve-library-id` → `context7:query-docs`) to look up: `@upstash/redis`, `ioredis`/`redis` npm client, Valkey docs, Docker Compose spec, GitHub Actions.
3. Use **web search** for: Valkey Docker image tags, Valkey ACL configuration, Valkey TLS setup, `@upstash/redis` API surface (to know what to replace).
4. Cross-reference source code with live docs. If code uses patterns you don't recognize — research, don't guess.

---

# PART 1: Migrate from Upstash Redis to Valkey

## Context

The official `excalidraw/excalidraw-mcp` uses `@upstash/redis` for checkpoint storage on Vercel. The checkpoint system has three stores:
- `FileCheckpointStore` — local dev, writes JSON to `$TMPDIR/excalidraw-mcp-checkpoints/`
- `MemoryCheckpointStore` — Vercel fallback (in-memory, lost on cold start)
- `RedisCheckpointStore` — Vercel with Upstash KV (persistent, 30-day TTL)

Factory `createVercelStore()` picks Redis if env vars exist, else Memory.

We are replacing `@upstash/redis` (Upstash HTTP-based Redis client, proprietary SaaS) with **Valkey** (Linux Foundation's open-source Redis fork, BSD-licensed, fully Redis-protocol compatible) running as a local Docker container.

## Goal

A Docker Compose stack where:
- `excalidraw-mcp` app container talks to `valkey` container
- Valkey is **invisible** to the outside world — zero exposed ports
- Communication is authenticated (ACL + password) and encrypted (TLS)
- Data persists across container restarts via Docker volumes
- Ready for on-premise deployment with no data leaks

## Quality Gate (MANDATORY after every phase)

Before marking ANY phase done, run ALL checks. Fix failures before proceeding.

1. **Typecheck**: `npx tsc --noEmit --strict` — zero errors
2. **Lint**: `npx eslint . --ext .ts,.tsx --max-warnings 0`
3. **Format**: `npx prettier --check '**/*.{ts,tsx,json,md,yml,yaml}'`
4. **Security**: `pnpm audit --audit-level=moderate` — no moderate+ vulns; no hardcoded secrets in code (all secrets via env vars or Docker secrets)
5. **Tests**: `npx vitest run --coverage` — all pass, ≥80% line coverage
6. **Build**: `pnpm run build:docker` — produces dist/server.js
7. **Docker**: `docker compose up --build` — both containers start, healthchecks pass

Log results in PROGRESS.md under each phase.

## Phases

### Phase 1: Audit Upstash Redis Usage

- **Research**: Use Context7 to look up `@upstash/redis` API. Use web search to understand Upstash REST API vs standard Redis protocol — they are DIFFERENT (Upstash uses HTTP, standard Redis uses TCP/RESP protocol).
- `cat` and read every file that imports `@upstash/redis` or references Redis/checkpoint
- Map the complete API surface used: which methods (`get`, `set`, `del`, `expire`, `scan`, etc.)
- Document in AUDIT-VALKEY.md:
  - Every file touching Redis, with line numbers
  - Every Redis method called and its arguments
  - How `createVercelStore()` factory works
  - Env vars used: `KV_REST_API_URL`, `KV_REST_API_TOKEN`, or whatever Upstash expects
  - The checkpoint data model: what keys are stored, what format (JSON?), TTL values
  - Differences between Upstash HTTP client and standard Redis client (ioredis/redis)
- RUN QUALITY GATE → mark done

### Phase 2: Create ValkeyCheckpointStore

- **Research**: Use Context7 to look up `ioredis` or `redis` npm package (whichever is more current). Use web search for Valkey compatibility notes with Node.js Redis clients.
- Create `src/stores/valkey-checkpoint-store.ts`:
  - Implements the same interface as `RedisCheckpointStore` (read the existing code to identify the interface/contract)
  - Uses `ioredis` (or `redis`) npm package — standard Redis protocol over TCP, NOT HTTP
  - Connection config via env vars:
    - `VALKEY_HOST` (default: `valkey` — Docker service name)
    - `VALKEY_PORT` (default: `6379`)
    - `VALKEY_PASSWORD` (required, no default — must be explicitly set)
    - `VALKEY_TLS_ENABLED` (default: `true`)
    - `VALKEY_DB` (default: `0`)
  - TLS support: when `VALKEY_TLS_ENABLED=true`, configure TLS connection with CA cert path from `VALKEY_TLS_CA_CERT` env var
  - Connection retry with exponential backoff
  - Graceful disconnect on SIGTERM/SIGINT
  - All the same operations as Upstash store: get/set/delete checkpoints, TTL (30 days default, configurable via `VALKEY_CHECKPOINT_TTL_SECONDS`)
  - Proper error handling: connection failures should not crash the server, fall back to MemoryCheckpointStore with a warning log
- Write comprehensive tests:
  - Unit tests with mocked Redis client
  - Test all checkpoint CRUD operations
  - Test TTL is set correctly
  - Test connection failure fallback
  - Test TLS configuration
  - Test env var parsing and defaults
- RUN QUALITY GATE → mark done

### Phase 3: Update Store Factory

- Modify the store factory (wherever `createVercelStore()` lives):
  - New priority order:
    1. If `VALKEY_HOST` is set → use `ValkeyCheckpointStore`
    2. If Upstash env vars are set → use existing `RedisCheckpointStore` (keep for backward compatibility)
    3. If neither → use `FileCheckpointStore` (local) or `MemoryCheckpointStore` (fallback)
  - Log which store was selected at startup: `[checkpoint-store] Using ValkeyCheckpointStore (valkey:6379)`
- Remove `@upstash/redis` from `dependencies` in package.json (move to `optionalDependencies` if backward compat needed, or remove entirely)
- Add `ioredis` (or `redis`) to `dependencies`
- Write tests for the factory: test each branch (Valkey, Upstash, File, Memory)
- RUN QUALITY GATE → mark done

### Phase 4: Generate TLS Certificates for Valkey

- Create `docker/valkey/` directory with:
  - `generate-certs.sh` — script that generates:
    - Self-signed CA certificate (`ca.crt`, `ca.key`)
    - Server certificate signed by CA (`valkey-server.crt`, `valkey-server.key`)
    - Client certificate signed by CA (`valkey-client.crt`, `valkey-client.key`)
    - All certs with 365-day validity
    - SAN (Subject Alternative Name) includes `valkey` (Docker service name) and `localhost`
  - Script must be idempotent: skip generation if certs already exist (check before overwrite)
  - Script outputs certs to `docker/valkey/tls/`
  - Add `docker/valkey/tls/` to `.gitignore` — NEVER commit certificates to git
  - Add `docker/valkey/tls/.gitkeep` so the directory structure exists in git
- Create `docker/valkey/valkey.conf`:
  - `bind 0.0.0.0` (safe because no ports exposed to host)
  - `protected-mode yes`
  - `requirepass` loaded from env or Docker secret
  - TLS configuration:
    - `tls-port 6379`
    - `port 0` (disable non-TLS port entirely)
    - `tls-cert-file /tls/valkey-server.crt`
    - `tls-key-file /tls/valkey-server.key`
    - `tls-ca-cert-file /tls/ca.crt`
    - `tls-auth-clients optional` (or `yes` if requiring client certs)
  - ACL: create a dedicated user for the app:
    - `user default off` (disable default user)
    - `user excalidraw on >PASSWORD_FROM_ENV ~checkpoint:* +get +set +del +expire +scan +ping +info` (least-privilege: only checkpoint keys, only needed commands)
  - Persistence:
    - `save 60 1` (snapshot every 60s if ≥1 write)
    - `appendonly yes` (AOF for durability)
    - `appendfsync everysec`
  - Memory:
    - `maxmemory 128mb`
    - `maxmemory-policy noeviction`
- Document all security decisions in SECURITY.md
- RUN QUALITY GATE → mark done

### Phase 5: Docker Compose — Secure Stack

- Update `docker-compose.yml`:
  ```yaml
  services:
    excalidraw-mcp:
      build: .
      ports:
        - "${PORT:-3000}:3000"    # Only the MCP HTTP port is exposed
      environment:
        - VALKEY_HOST=valkey
        - VALKEY_PORT=6379
        - VALKEY_PASSWORD=${VALKEY_PASSWORD}
        - VALKEY_TLS_ENABLED=true
        - VALKEY_TLS_CA_CERT=/tls/ca.crt
        - VALKEY_TLS_CLIENT_CERT=/tls/valkey-client.crt
        - VALKEY_TLS_CLIENT_KEY=/tls/valkey-client.key
      volumes:
        - ./docker/valkey/tls:/tls:ro
      depends_on:
        valkey:
          condition: service_healthy
      networks:
        - internal
      restart: unless-stopped
      read_only: true
      tmpfs:
        - /tmp
      security_opt:
        - no-new-privileges:true

    valkey:
      image: valkey/valkey:8-alpine
      command: valkey-server /etc/valkey/valkey.conf
      volumes:
        - valkey-data:/data
        - ./docker/valkey/valkey.conf:/etc/valkey/valkey.conf:ro
        - ./docker/valkey/tls:/tls:ro
      # NO ports: section — Valkey is NOT exposed to host
      networks:
        - internal
      restart: unless-stopped
      read_only: true
      tmpfs:
        - /tmp
      security_opt:
        - no-new-privileges:true
      healthcheck:
        test: ["CMD", "valkey-cli", "--tls", "--cert", "/tls/valkey-client.crt", "--key", "/tls/valkey-client.key", "--cacert", "/tls/ca.crt", "-a", "$$VALKEY_PASSWORD", "ping"]
        interval: 10s
        timeout: 5s
        retries: 5

  volumes:
    valkey-data:
      driver: local

  networks:
    internal:
      driver: bridge
      internal: true    # No external connectivity for this network
  ```
- Key security properties:
  - `networks.internal.internal: true` — Docker will NOT attach this network to any external gateway. Containers on this network cannot reach the internet and nothing outside can reach them (except the explicitly published MCP port on the app container).
  - Valkey has NO `ports:` section — completely unreachable from host
  - `read_only: true` + `tmpfs` — filesystem is immutable except /tmp and /data volume
  - `no-new-privileges` — prevents privilege escalation
  - TLS between app and Valkey — encrypted even within Docker network (defense in depth)
  - ACL with least-privilege user — even if compromised, attacker can only touch `checkpoint:*` keys
- Create `.env.example`:
  ```
  PORT=3000
  VALKEY_PASSWORD=CHANGE_ME_TO_A_STRONG_RANDOM_PASSWORD
  ```
- Create `docker/setup.sh` — first-time setup script:
  1. Check if TLS certs exist, if not → run `generate-certs.sh`
  2. Check if `.env` exists, if not → copy `.env.example` and generate random password via `openssl rand -base64 32`
  3. `docker compose up --build -d`
  4. Wait for healthchecks
  5. Print status and connection instructions
- Verify: `bash docker/setup.sh` → both containers running, healthchecks pass, MCP endpoint responds
- RUN QUALITY GATE → mark done

### Phase 6: Integration Test — Checkpoint via Valkey

- Create `scripts/test-valkey-integration.sh`:
  - Start Docker Compose stack
  - Wait for healthchecks
  - Send MCP request to create a diagram (via POST /mcp)
  - Verify checkpoint was stored (check server logs or send another request that reads the checkpoint)
  - Stop stack
  - Start stack again (simulating restart)
  - Verify checkpoint survived restart (persistence test)
  - Cleanup
- Create `scripts/test-valkey-integration.test.ts` — vitest version against locally started server + Valkey
- Verify: both tests pass
- RUN QUALITY GATE → mark done

---

# PART 2: GitHub Project Setup & Deployment Prep

### Phase 7: Fork & Repository Structure

- This phase is about preparing the git repository structure. Do NOT push to GitHub — just prepare the files.
- Ensure git remote `origin` points to our fork (document in README that this is a fork of `excalidraw/excalidraw-mcp`)
- Create/update the following files:
  - `LICENSE` — MIT (same as upstream)
  - `.github/CODEOWNERS` — set to repository owner
  - `.github/PULL_REQUEST_TEMPLATE.md` — basic checklist (tests pass, lint clean, docs updated)
  - `.github/ISSUE_TEMPLATE/bug_report.md`
  - `.github/ISSUE_TEMPLATE/feature_request.md`
- Directory structure should look like:
  ```
  excalidraw-mcp/
  ├── .github/
  │   ├── workflows/
  │   │   ├── ci.yml
  │   │   ├── docker-build.yml
  │   │   └── release.yml
  │   ├── CODEOWNERS
  │   ├── PULL_REQUEST_TEMPLATE.md
  │   └── ISSUE_TEMPLATE/
  ├── docker/
  │   ├── valkey/
  │   │   ├── valkey.conf
  │   │   ├── generate-certs.sh
  │   │   └── tls/.gitkeep
  │   └── setup.sh
  ├── src/
  │   ├── stores/
  │   │   └── valkey-checkpoint-store.ts
  │   ├── server.ts
  │   └── ... (existing source)
  ├── scripts/
  │   ├── test-mcp.sh
  │   ├── test-valkey-integration.sh
  │   └── test-valkey-integration.test.ts
  ├── Dockerfile
  ├── docker-compose.yml
  ├── .env.example
  ├── SECURITY.md
  ├── AUDIT-VALKEY.md
  ├── README.md
  └── ...
  ```
- RUN QUALITY GATE → mark done

### Phase 8: GitHub Actions — CI Pipeline

- Create `.github/workflows/ci.yml`:
  - Trigger: push to `main`, pull requests to `main`
  - Jobs:
    - **quality**: runs on `ubuntu-latest`
      - Checkout, setup Node 20, pnpm install
      - `pnpm run typecheck`
      - `pnpm run lint`
      - `pnpm run format`
      - `pnpm run test:coverage`
      - Upload coverage report as artifact
    - **docker-build-test**: runs on `ubuntu-latest`, needs `quality`
      - Checkout
      - Generate TLS certs (`bash docker/valkey/generate-certs.sh`)
      - Create `.env` with test password
      - `docker compose build`
      - `docker compose up -d`
      - Wait for healthchecks
      - Run `bash scripts/test-mcp.sh`
      - Run `bash scripts/test-valkey-integration.sh`
      - `docker compose down -v`
- Create `.github/workflows/docker-build.yml`:
  - Trigger: push to `main` (only on merge, not PRs)
  - Job: **build-and-push**
    - Checkout
    - Set up Docker Buildx
    - Login to GitHub Container Registry (ghcr.io) using `GITHUB_TOKEN`
    - Build multi-platform: `linux/amd64`, `linux/arm64`
    - Tag: `ghcr.io/OWNER/excalidraw-mcp:latest`, `ghcr.io/OWNER/excalidraw-mcp:sha-COMMIT`
    - Push to GHCR
    - No secrets in image — all config via env vars at runtime
- Create `.github/workflows/release.yml`:
  - Trigger: push tag `v*`
  - Job: same as docker-build but also tags with version: `ghcr.io/OWNER/excalidraw-mcp:v1.0.0`
- Verify: all workflow YAML files pass `actionlint` (install and run locally if available, or validate syntax manually)
- RUN QUALITY GATE → mark done

### Phase 9: README with Architecture Diagrams

- Rewrite `README.md` with the following sections:
  1. **Header**: project name, one-line description, badges (CI status, license, Docker image size)
  2. **What is this?**: Brief explanation. This is a fork of `excalidraw/excalidraw-mcp` with self-hosted Docker support and Valkey persistence. Link to upstream. Explain: use upstream for Vercel/cloud, use this fork for on-premise/self-hosted.
  3. **Architecture** — Mermaid diagram:
     ```mermaid
     graph LR
       subgraph "Your Machine / Server"
         subgraph "Docker Network (internal, isolated)"
           MCP["excalidraw-mcp<br/>:3000"]
           VK["Valkey<br/>:6379<br/>(TLS + ACL)"]
           MCP -->|"TLS encrypted<br/>checkpoint read/write"| VK
         end
         VOL[("valkey-data<br/>Docker Volume")]
         VK ---|persistence| VOL
       end
       CLIENT["Claude Desktop<br/>VS Code<br/>Claude Code"] -->|"MCP Protocol<br/>HTTP :3000"| MCP
       style VK fill:#e8f5e9,stroke:#2e7d32
       style MCP fill:#e3f2fd,stroke:#1565c0
       style CLIENT fill:#fff3e0,stroke:#e65100
     ```
  4. **How MCP Apps Work** — Mermaid sequence diagram:
     ```mermaid
     sequenceDiagram
       participant User as User (VS Code / Claude Desktop)
       participant MCP as excalidraw-mcp
       participant VK as Valkey
       User->>MCP: "Draw an architecture diagram"
       MCP->>MCP: Generate Excalidraw elements
       MCP->>VK: SET checkpoint:<id> (TLS)
       VK-->>MCP: OK
       MCP-->>User: HTML widget with interactive Excalidraw
       User->>User: Edit diagram in fullscreen
       User->>MCP: save_checkpoint (debounced)
       MCP->>VK: SET checkpoint:<id> (updated)
       Note over User,VK: Later, user asks "add a database to the diagram"
       User->>MCP: "Add database to this diagram"
       MCP->>VK: GET checkpoint:<id>
       VK-->>MCP: Previous elements
       MCP->>MCP: Add new elements to existing
       MCP->>VK: SET checkpoint:<id> (merged)
       MCP-->>User: Updated HTML widget
     ```
  5. **Quick Start**:
     ```bash
     git clone https://github.com/OWNER/excalidraw-mcp.git
     cd excalidraw-mcp
     bash docker/setup.sh
     ```
  6. **Connect Your Client** — table with Claude Desktop, VS Code, Claude Code config examples
  7. **Security**: summary of security measures (internal network, TLS, ACL, no-new-privileges, read-only fs). Link to SECURITY.md for details.
  8. **Configuration**: table of all env vars with descriptions, defaults, and whether required
  9. **Development**: how to run locally, run tests, run quality checks
  10. **Deployment to Production Server**: section left with placeholder:
      ```
      ## Production Deployment
      > Deployment instructions for your specific server will be configured separately.
      > See DEPLOYMENT.md (to be created during deployment setup).
      ```
  11. **Upstream**: explain fork relationship, how to sync with upstream, what we changed and why
  12. **License**: MIT

- RUN QUALITY GATE → mark done

### Phase 10: Security Documentation

- Create/update `SECURITY.md`:
  - **Threat Model**: what we protect against (unauthorized access to checkpoints, data exfiltration, man-in-the-middle between containers, privilege escalation)
  - **Network Isolation**: explain Docker `internal: true` network — no external gateway, no internet access from containers on this network
  - **Encryption in Transit**: TLS between app and Valkey, self-signed CA (acceptable for internal Docker network), certificate rotation procedure
  - **Authentication & Authorization**: Valkey ACL with dedicated `excalidraw` user, least-privilege command set, disabled default user
  - **Encryption at Rest**: Docker volume on host filesystem — recommend host-level disk encryption (LUKS/dm-crypt for Linux) since Valkey itself doesn't encrypt data at rest
  - **Secrets Management**: passwords via `.env` file (not committed to git) or Docker secrets. `.env` in `.gitignore`. In production: use Docker secrets or external secret manager.
  - **Container Hardening**: read-only filesystem, no-new-privileges, non-root user, tmpfs for temporary files
  - **Certificate Management**: how to regenerate certs, rotation procedure, where certs are stored
  - **What is NOT covered**: no RBAC for MCP endpoint itself (anyone who can reach port 3000 can use it), no rate limiting on MCP endpoint. Recommend: put behind reverse proxy with auth for production.
- RUN QUALITY GATE → mark done

---

## Final Verification

After ALL phases done:
1. `pnpm run quality` → all green
2. `pnpm run test:coverage` → ≥80% lines
3. `bash docker/setup.sh` → both containers running, healthy
4. `curl -sf http://localhost:3000/health | grep ok`
5. `bash scripts/test-mcp.sh` → MCP protocol works
6. `bash scripts/test-valkey-integration.sh` → checkpoints persist across restart
7. `docker exec excalidraw-mcp ping valkey` → resolves (internal network works)
8. `docker exec excalidraw-mcp curl -sf https://google.com` → FAILS (no external access from internal network — this is expected and correct)
9. Verify from host: `valkey-cli -h localhost -p 6379 ping` → connection refused (Valkey port not exposed — this is expected and correct)
10. All GitHub Actions workflow YAML files have valid syntax
11. README.md renders correctly with Mermaid diagrams (check in GitHub preview or `grip`)

ALL pass → output `<promise>COMPLETE</promise>`

If stuck 5 attempts on same issue → document blocker in PROGRESS.md, move on.
