/**
 * Valkey integration tests — mocked ioredis, no Docker required.
 *
 * Covers flows not exercised by the unit tests in src/stores/valkey-checkpoint-store.test.ts:
 * - Full save → load → verify round-trip with per-test store isolation
 * - Simulated restart: data saved by one store instance is readable by a new instance
 *   backed by the same underlying storage (proves the key scheme is stable)
 * - TTL is written on every save
 * - createStore() factory selects ValkeyCheckpointStore when VALKEY_PASSWORD is set
 * - createStore() falls back to FileCheckpointStore when VALKEY_PASSWORD is absent
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ValkeyCheckpointStore } from '../src/stores/valkey-checkpoint-store.js';
import { FileCheckpointStore, MemoryCheckpointStore } from '../src/checkpoint-store.js';
import type { ValkeyConfig } from '../src/stores/valkey-checkpoint-store.js';

// ---------------------------------------------------------------------------
// Shared in-memory backing store — simulates a real Valkey instance that
// persists across multiple store instances (i.e. server restarts).
// ---------------------------------------------------------------------------
type StoredEntry = { value: string; ttl: number };
let sharedStorage: Map<string, StoredEntry>;

vi.mock('ioredis', () => {
  class MockRedis {
    private handlers: Record<string, ((...args: any[]) => void)[]> = {};
    connected = false;

    // Reference the module-level sharedStorage so instances share the same data
    private get storage(): Map<string, StoredEntry> {
      return sharedStorage;
    }

    on(event: string, handler: (...args: any[]) => void): this {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event]!.push(handler);
      return this;
    }

    private emit(event: string, ...args: any[]): void {
      for (const h of this.handlers[event] ?? []) h(...args);
    }

    async connect(): Promise<void> {
      this.connected = true;
      this.emit('connect');
    }

    async quit(): Promise<void> {
      this.connected = false;
      this.emit('close');
    }

    async set(key: string, value: string, _flag: string, ttl: number): Promise<'OK'> {
      this.storage.set(key, { value, ttl });
      return 'OK';
    }

    async get(key: string): Promise<string | null> {
      const entry = this.storage.get(key);
      return entry?.value ?? null;
    }
  }

  return { default: MockRedis, Redis: MockRedis };
});

// Mock fs so TLS cert paths don't cause real filesystem reads
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn((p: string) => `mock-cert:${p}`),
    },
  };
});

function makeConfig(overrides: Partial<ValkeyConfig> = {}): ValkeyConfig {
  return {
    host: 'valkey',
    port: 6379,
    password: 'integration-test-password',
    db: 0,
    tlsEnabled: false,
    ttlSeconds: 86400,
    ...overrides,
  };
}

// Reset shared storage before each test for isolation
beforeEach(() => {
  sharedStorage = new Map<string, StoredEntry>();
});

// ---------------------------------------------------------------------------
// Full round-trip
// ---------------------------------------------------------------------------
describe('Valkey integration — full round-trip', () => {
  it('saves and loads a simple checkpoint', async () => {
    const store = new ValkeyCheckpointStore(makeConfig());
    const data = {
      elements: [
        { id: 'rect1', type: 'rectangle', x: 10, y: 10, width: 200, height: 100 },
        { id: 'text1', type: 'text', x: 60, y: 50, text: 'Hello' },
      ],
    };

    await store.save('integration-round-trip', data);
    const loaded = await store.load('integration-round-trip');

    expect(loaded).toEqual(data);
    expect(loaded?.elements).toHaveLength(2);
    expect(loaded?.elements[0]?.id).toBe('rect1');
    expect(loaded?.elements[1]?.id).toBe('text1');
  });

  it('returns null for a checkpoint that was never saved', async () => {
    const store = new ValkeyCheckpointStore(makeConfig());
    const result = await store.load('never-saved-id');
    expect(result).toBeNull();
  });

  it('overwrites a checkpoint and loads the latest version', async () => {
    const store = new ValkeyCheckpointStore(makeConfig());
    const v1 = { elements: [{ id: 'v1', type: 'rectangle' }] };
    const v2 = {
      elements: [
        { id: 'v2', type: 'ellipse' },
        { id: 'v2b', type: 'text' },
      ],
    };

    await store.save('integration-overwrite', v1);
    await store.save('integration-overwrite', v2);

    const loaded = await store.load('integration-overwrite');
    expect(loaded?.elements).toHaveLength(2);
    expect(loaded?.elements[0]?.id).toBe('v2');
  });

  it('stores elements with complex nested data faithfully', async () => {
    const store = new ValkeyCheckpointStore(makeConfig());
    const data = {
      elements: [
        {
          id: 'arrow1',
          type: 'arrow',
          x: 0,
          y: 0,
          width: 100,
          height: 0,
          points: [
            [0, 0],
            [100, 0],
          ],
          startArrowhead: 'arrow',
          endArrowhead: 'arrow',
          strokeColor: '#1e1e2e',
          strokeWidth: 2,
          roughness: 1,
          seed: 99999,
        },
      ],
    };

    await store.save('integration-complex', data);
    const loaded = await store.load('integration-complex');
    expect(loaded?.elements[0]?.points).toEqual([
      [0, 0],
      [100, 0],
    ]);
    expect(loaded?.elements[0]?.startArrowhead).toBe('arrow');
  });
});

// ---------------------------------------------------------------------------
// Simulated restart: a new store instance shares the same backing storage
// ---------------------------------------------------------------------------
describe('Valkey integration — simulated server restart', () => {
  it('checkpoint saved by first store is loadable by second store (same backing storage)', async () => {
    const store1 = new ValkeyCheckpointStore(makeConfig());
    const data = {
      elements: [{ id: 'persist1', type: 'rectangle', x: 0, y: 0, width: 50, height: 50 }],
    };

    await store1.save('integration-restart-test', data);

    // Simulate restart: disconnect first instance, create a fresh one
    await store1.disconnect();

    const store2 = new ValkeyCheckpointStore(makeConfig());
    const loaded = await store2.load('integration-restart-test');

    expect(loaded).toEqual(data);
    expect(loaded?.elements[0]?.id).toBe('persist1');
  });

  it('multiple checkpoints survive store recreation', async () => {
    const store1 = new ValkeyCheckpointStore(makeConfig());
    await store1.save('restart-cp-a', { elements: [{ id: 'a' }] });
    await store1.save('restart-cp-b', { elements: [{ id: 'b' }, { id: 'b2' }] });
    await store1.disconnect();

    const store2 = new ValkeyCheckpointStore(makeConfig());
    const cpA = await store2.load('restart-cp-a');
    const cpB = await store2.load('restart-cp-b');

    expect(cpA?.elements[0]?.id).toBe('a');
    expect(cpB?.elements).toHaveLength(2);
    expect(cpB?.elements[1]?.id).toBe('b2');
  });

  it('checkpoint updated before restart loads the latest version after restart', async () => {
    const store1 = new ValkeyCheckpointStore(makeConfig());
    await store1.save('restart-update', { elements: [{ id: 'before' }] });
    await store1.save('restart-update', { elements: [{ id: 'after' }] });
    await store1.disconnect();

    const store2 = new ValkeyCheckpointStore(makeConfig());
    const loaded = await store2.load('restart-update');
    expect(loaded?.elements[0]?.id).toBe('after');
  });
});

// ---------------------------------------------------------------------------
// TTL is applied on every save
// ---------------------------------------------------------------------------
describe('Valkey integration — TTL behaviour', () => {
  it('saves with the configured TTL value', async () => {
    const ttlSeconds = 3600; // 1 hour
    const store = new ValkeyCheckpointStore(makeConfig({ ttlSeconds }));

    await store.save('integration-ttl-test', { elements: [{ id: 'el1' }] });

    // Inspect underlying mock storage to verify TTL was recorded
    const entry = sharedStorage.get('cp:integration-ttl-test');
    expect(entry).toBeDefined();
    expect(entry!.ttl).toBe(ttlSeconds);
  });

  it('updates TTL on overwrite', async () => {
    const store = new ValkeyCheckpointStore(makeConfig({ ttlSeconds: 7200 }));

    await store.save('integration-ttl-overwrite', { elements: [{ id: 'v1' }] });
    await store.save('integration-ttl-overwrite', { elements: [{ id: 'v2' }] });

    const entry = sharedStorage.get('cp:integration-ttl-overwrite');
    expect(entry!.ttl).toBe(7200);
    // The updated value should be v2
    const parsed = JSON.parse(entry!.value);
    expect(parsed.elements[0].id).toBe('v2');
  });

  it('key prefix is always cp:', async () => {
    const store = new ValkeyCheckpointStore(makeConfig());
    await store.save('prefix-check', { elements: [] });

    // Must be stored under the cp: prefix — not the raw ID
    expect(sharedStorage.has('cp:prefix-check')).toBe(true);
    expect(sharedStorage.has('prefix-check')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createStore() factory integration
// ---------------------------------------------------------------------------
describe('createStore() factory', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VALKEY_PASSWORD;
    delete process.env.KV_REST_API_URL;
    delete process.env.UPSTASH_REDIS_REST_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns ValkeyCheckpointStore when VALKEY_PASSWORD is set', async () => {
    process.env.VALKEY_PASSWORD = 'integration-factory-test';
    process.env.VALKEY_TLS_ENABLED = 'false';

    // Dynamic import so env vars are read fresh after mutation
    const { createStore } = await import('../src/checkpoint-store.js');
    const store = createStore();

    // Must not be a FileCheckpointStore or MemoryCheckpointStore
    expect(store).not.toBeInstanceOf(FileCheckpointStore);
    expect(store).not.toBeInstanceOf(MemoryCheckpointStore);

    // The store must satisfy the CheckpointStore interface
    await store.save('factory-smoke', { elements: [{ id: 'smoke' }] });
    const loaded = await store.load('factory-smoke');
    expect(loaded?.elements[0]?.id).toBe('smoke');
  });

  it('returns FileCheckpointStore when no env vars are set', async () => {
    const { createStore } = await import('../src/checkpoint-store.js');
    const store = createStore();
    expect(store).toBeInstanceOf(FileCheckpointStore);
  });
});
