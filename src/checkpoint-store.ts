import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createValkeyStore } from './stores/valkey-checkpoint-store.js';

/** Maximum serialized checkpoint size (5 MB). */
const MAX_CHECKPOINT_BYTES = 5 * 1024 * 1024;

/** Maximum number of checkpoints kept on disk before pruning oldest. */
const MAX_FILE_CHECKPOINTS = 100;

/**
 * Validates that a checkpoint ID is safe to use as a filename.
 * Rejects path traversal attempts and other filesystem-unsafe characters.
 */
export function validateCheckpointId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid checkpoint id: must be alphanumeric, hyphens, or underscores`);
  }
  if (id.length > 64) {
    throw new Error(`Invalid checkpoint id: exceeds 64 character limit`);
  }
}

export interface CheckpointStore {
  save(id: string, data: { elements: any[] }): Promise<void>;
  load(id: string): Promise<{ elements: any[] } | null>;
}

export class FileCheckpointStore implements CheckpointStore {
  private dir: string;
  constructor() {
    this.dir = path.join(os.tmpdir(), 'excalidraw-mcp-checkpoints');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  async save(id: string, data: { elements: any[] }): Promise<void> {
    validateCheckpointId(id);
    const serialized = JSON.stringify(data);
    if (serialized.length > MAX_CHECKPOINT_BYTES) {
      throw new Error(`Checkpoint data exceeds ${MAX_CHECKPOINT_BYTES} byte limit`);
    }
    const filePath = path.join(this.dir, `${id}.json`);
    // Verify resolved path stays within checkpoint directory
    if (!path.resolve(filePath).startsWith(path.resolve(this.dir) + path.sep)) {
      throw new Error('Invalid checkpoint path');
    }
    await fs.promises.writeFile(filePath, serialized);
    await this.pruneOldCheckpoints();
  }
  async load(id: string): Promise<{ elements: any[] } | null> {
    validateCheckpointId(id);
    const filePath = path.join(this.dir, `${id}.json`);
    if (!path.resolve(filePath).startsWith(path.resolve(this.dir) + path.sep)) {
      throw new Error('Invalid checkpoint path');
    }
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  /** Remove oldest checkpoints when count exceeds the limit. */
  private async pruneOldCheckpoints(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(this.dir);
      const jsonFiles = entries.filter((f) => f.endsWith('.json'));
      if (jsonFiles.length <= MAX_FILE_CHECKPOINTS) return;

      const stats = await Promise.all(
        jsonFiles.map(async (f) => ({
          name: f,
          mtime: (await fs.promises.stat(path.join(this.dir, f))).mtimeMs,
        })),
      );
      stats.sort((a, b) => a.mtime - b.mtime);
      const toRemove = stats.slice(0, stats.length - MAX_FILE_CHECKPOINTS);
      await Promise.all(
        toRemove.map((f) => fs.promises.unlink(path.join(this.dir, f.name)).catch(() => {})),
      );
    } catch {
      // Best-effort cleanup; don't fail the save
    }
  }
}

const memoryStore = new Map<string, string>();
export class MemoryCheckpointStore implements CheckpointStore {
  async save(id: string, data: { elements: any[] }): Promise<void> {
    validateCheckpointId(id);
    const serialized = JSON.stringify(data);
    if (serialized.length > MAX_CHECKPOINT_BYTES) {
      throw new Error(`Checkpoint data exceeds ${MAX_CHECKPOINT_BYTES} byte limit`);
    }
    memoryStore.set(id, serialized);
    // Evict oldest entries if over limit
    if (memoryStore.size > MAX_FILE_CHECKPOINTS) {
      const oldest = memoryStore.keys().next().value;
      if (oldest !== undefined) memoryStore.delete(oldest);
    }
  }
  async load(id: string): Promise<{ elements: any[] } | null> {
    validateCheckpointId(id);
    const raw = memoryStore.get(id);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

/* v8 ignore start -- Requires Upstash Redis infrastructure */
const REDIS_TTL_SECONDS = 30 * 24 * 60 * 60;
export class RedisCheckpointStore implements CheckpointStore {
  private redis: any = null;
  private async getRedis() {
    if (!this.redis) {
      const { Redis } = await import('@upstash/redis');
      const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!url || !token)
        throw new Error('Missing Redis env vars (KV_REST_API_* or UPSTASH_REDIS_REST_*)');
      this.redis = new Redis({ url, token });
    }
    return this.redis;
  }
  async save(id: string, data: { elements: any[] }): Promise<void> {
    validateCheckpointId(id);
    const serialized = JSON.stringify(data);
    if (serialized.length > MAX_CHECKPOINT_BYTES) {
      throw new Error(`Checkpoint data exceeds ${MAX_CHECKPOINT_BYTES} byte limit`);
    }
    const redis = await this.getRedis();
    await redis.set(`cp:${id}`, serialized, { ex: REDIS_TTL_SECONDS });
  }
  async load(id: string): Promise<{ elements: any[] } | null> {
    validateCheckpointId(id);
    const redis = await this.getRedis();
    const raw = await redis.get(`cp:${id}`);
    if (!raw) return null;
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }
}

export function createVercelStore(): CheckpointStore {
  if (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) {
    return new RedisCheckpointStore();
  }
  return new MemoryCheckpointStore();
}
/* v8 ignore stop */

/**
 * Creates the best available checkpoint store based on environment:
 * 1. Valkey (if VALKEY_PASSWORD is set)
 * 2. Upstash Redis (if KV_REST_API_URL or UPSTASH_REDIS_REST_URL is set)
 * 3. FileCheckpointStore (local filesystem fallback)
 */
export function createStore(): CheckpointStore {
  // Valkey (self-hosted, standard Redis protocol)
  if (process.env.VALKEY_PASSWORD) {
    try {
      const store = createValkeyStore();
      if (store) {
        const host = process.env.VALKEY_HOST ?? 'valkey';
        const port = process.env.VALKEY_PORT ?? '6379';
        console.log(`[checkpoint-store] Using ValkeyCheckpointStore (${host}:${port})`);
        return store;
      }
    } catch (err) {
      console.warn('[checkpoint-store] Failed to create ValkeyCheckpointStore, falling back:', err);
    }
  }

  /* v8 ignore start -- Upstash path requires cloud infrastructure */
  // Upstash Redis (cloud, HTTP-based)
  if (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) {
    console.log('[checkpoint-store] Using RedisCheckpointStore (Upstash)');
    return new RedisCheckpointStore();
  }
  /* v8 ignore stop */

  // Local filesystem
  console.log('[checkpoint-store] Using FileCheckpointStore');
  return new FileCheckpointStore();
}
