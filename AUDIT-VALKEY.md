# Audit: Upstash Redis Usage — Migration to Valkey

## Files Touching Redis/Checkpoint

| File                           | Lines                              | Role                                                          |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------------- |
| `src/checkpoint-store.ts`      | 1-157                              | Interface + 3 implementations (File, Memory, Redis) + factory |
| `src/server.ts`                | 13, 405, 475-519, 654-681, 733-738 | Consumes `CheckpointStore` via dependency injection           |
| `src/main.ts`                  | 14, 115-116                        | Instantiates `FileCheckpointStore` for HTTP/stdio             |
| `api/mcp.ts`                   | 3, 6, 11                           | Instantiates via `createVercelStore()` for Vercel serverless  |
| `src/checkpoint-store.test.ts` | 1-86                               | Tests for File, Memory stores and factory                     |
| `package.json`                 | 44                                 | `@upstash/redis: ^1.34.0` dependency                          |

## Redis Methods Used

Only **two** Redis methods are called:

| Method | Signature                            | File:Line               | Purpose                         |
| ------ | ------------------------------------ | ----------------------- | ------------------------------- |
| `set`  | `redis.set(key, value, { ex: TTL })` | checkpoint-store.ts:135 | Save checkpoint with 30-day TTL |
| `get`  | `redis.get(key)`                     | checkpoint-store.ts:140 | Load checkpoint by key          |

### Upstash Client Instantiation (line 119-124)

```typescript
const { Redis } = await import('@upstash/redis');
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
this.redis = new Redis({ url, token });
```

## Environment Variables

| Variable                   | Purpose                            | Used In                      |
| -------------------------- | ---------------------------------- | ---------------------------- |
| `KV_REST_API_URL`          | Upstash REST API URL (Vercel KV)   | checkpoint-store.ts:120, 151 |
| `KV_REST_API_TOKEN`        | Upstash REST API token (Vercel KV) | checkpoint-store.ts:121      |
| `UPSTASH_REDIS_REST_URL`   | Upstash REST API URL (direct)      | checkpoint-store.ts:120, 151 |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST API token (direct)    | checkpoint-store.ts:121      |

## Checkpoint Data Model

- **Key format**: `cp:${id}` where `id` is alphanumeric + hyphens/underscores, max 64 chars
- **ID generation**: `crypto.randomUUID().replace(/-/g, '').slice(0, 18)` (server.ts:518)
- **Value format**: JSON string of `{ elements: any[] }`
- **Max size**: 5 MB (MAX_CHECKPOINT_BYTES)
- **TTL**: 30 days = 2,592,000 seconds (REDIS_TTL_SECONDS)
- **Validation**: `validateCheckpointId()` rejects path traversal and non-alphanumeric chars

## createVercelStore() Factory (lines 150-156)

```typescript
export function createVercelStore(): CheckpointStore {
  if (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) {
    return new RedisCheckpointStore();
  }
  return new MemoryCheckpointStore();
}
```

Priority: Redis (if env vars present) > Memory (fallback).  
Only used in `api/mcp.ts` (Vercel deployment). `main.ts` hardcodes `FileCheckpointStore`.

## Upstash HTTP vs Standard Redis Protocol

| Aspect         | Upstash (`@upstash/redis`)          | Standard (`ioredis`)              |
| -------------- | ----------------------------------- | --------------------------------- |
| Protocol       | HTTP/REST                           | TCP/RESP                          |
| Auth           | URL + Bearer token                  | Password (AUTH command)           |
| TLS            | Built-in (HTTPS)                    | Explicit TLS config               |
| Connection     | Stateless per-request               | Persistent TCP connection         |
| `set` with TTL | `redis.set(key, val, { ex: N })`    | `redis.set(key, val, 'EX', N)`    |
| `get`          | `redis.get(key)` → string or parsed | `redis.get(key)` → string or null |

Key difference for migration: ioredis `set` uses positional args for TTL (`'EX', seconds`) instead of options object.

## Migration Plan

1. Create `ValkeyCheckpointStore` using `ioredis` with standard Redis protocol
2. Update factory to prefer Valkey, fall back to Upstash, then Memory/File
3. Keep `RedisCheckpointStore` for backward compatibility (Vercel users)
4. Move `@upstash/redis` to `optionalDependencies`
