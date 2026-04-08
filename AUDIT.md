# Audit: Excalidraw MCP Vercel-to-Docker Conversion

## Vercel-Specific Code

| File                                         | What                                              | Docker Action                                            |
| -------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `api/mcp.ts`                                 | Vercel serverless handler using `mcp-handler` lib | Keep for reference, not used in Docker                   |
| `vercel.json`                                | Rewrites `/mcp`, `/sse`, `/message` -> `/api/mcp` | Not needed; Express handles routing directly             |
| `mcp-handler` (dep)                          | Vercel-specific MCP protocol wrapper              | Not needed; use `StreamableHTTPServerTransport` directly |
| `checkpoint-store.ts` `RedisCheckpointStore` | Uses Vercel KV (Upstash Redis)                    | Keep optional; works standalone with env vars            |
| `checkpoint-store.ts` `createVercelStore()`  | Factory for Vercel deployment                     | Keep; rename or add Docker factory                       |

## Reusable Code (no changes needed)

| File                      | Purpose                                                   |
| ------------------------- | --------------------------------------------------------- |
| `src/server.ts`           | Core MCP tools + resources registration (`registerTools`) |
| `src/main.ts`             | Express + stdio server entry point (already has Express!) |
| `src/checkpoint-store.ts` | `FileCheckpointStore` + `MemoryCheckpointStore`           |
| `src/mcp-app.tsx`         | React widget (streaming SVG renderer)                     |
| `src/mcp-entry.tsx`       | Production widget entry point                             |
| `src/edit-context.ts`     | Widget state management                                   |
| `src/global.css`          | CSS animations                                            |
| `vite.config.ts`          | Widget bundling to singlefile HTML                        |
| `scripts/build.mjs`       | Build orchestrator (tsc -> vite -> bun)                   |

## MCP Transport

- **Protocol**: Streamable HTTP (JSON-RPC over HTTP POST, SSE responses)
- **Implementation**: `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`
- **Stateless**: New `McpServer` instance per request (`sessionIdGenerator: undefined`)
- **Endpoints**: POST `/mcp` (requests), GET `/mcp` (SSE), DELETE `/mcp` (cleanup)
- **Existing**: `src/main.ts` already implements this with Express + cors

## Environment Variables

| Variable                                         | Default   | Purpose                                                |
| ------------------------------------------------ | --------- | ------------------------------------------------------ |
| `PORT`                                           | `3001`    | HTTP server port (change default to `3000` for Docker) |
| `HOST`                                           | `0.0.0.0` | Bind address (already set in main.ts)                  |
| `KV_REST_API_URL` / `UPSTASH_REDIS_REST_URL`     | -         | Optional Redis for persistent checkpoints              |
| `KV_REST_API_TOKEN` / `UPSTASH_REDIS_REST_TOKEN` | -         | Optional Redis auth token                              |
| `NODE_ENV`                                       | -         | Build mode (development = sourcemaps)                  |

## Entry Point Chain

```
HTTP POST /mcp
  -> src/main.ts (Express app)
  -> StreamableHTTPServerTransport.handleRequest()
  -> McpServer (created per request)
  -> registerTools(server, distDir, store) [src/server.ts]
     -> read_me, create_view, export_to_excalidraw, save_checkpoint, read_checkpoint
  -> SSE response back to client
```

## Key Insight

`src/main.ts` already IS an Express server with Streamable HTTP transport. The Docker conversion primarily needs:

1. Add health endpoint to existing Express app
2. Add input validation middleware
3. Add request logging
4. Create Docker build config (tsconfig for server output)
5. Dockerfile + docker-compose.yml
6. Tests
