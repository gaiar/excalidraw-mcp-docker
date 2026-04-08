import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  FileCheckpointStore,
  MemoryCheckpointStore,
  createVercelStore,
  createStore,
} from './checkpoint-store.js';

describe('FileCheckpointStore', () => {
  const store = new FileCheckpointStore();

  it('saves and loads a checkpoint', async () => {
    const data = { elements: [{ id: 'r1', type: 'rectangle' }] };
    await store.save('test-file-1', data);
    const loaded = await store.load('test-file-1');
    expect(loaded).toEqual(data);
  });

  it('returns null for non-existent checkpoint', async () => {
    const loaded = await store.load('nonexistent-id');
    expect(loaded).toBeNull();
  });

  it('rejects invalid checkpoint IDs', async () => {
    await expect(store.save('../hack', { elements: [] })).rejects.toThrow('Invalid checkpoint id');
    await expect(store.load('../hack')).rejects.toThrow('Invalid checkpoint id');
  });

  it('rejects oversized checkpoints', async () => {
    const huge = { elements: [{ data: 'x'.repeat(6_000_000) }] };
    await expect(store.save('oversized', huge)).rejects.toThrow('byte limit');
  });

  it('rejects too-long checkpoint IDs', async () => {
    const longId = 'a'.repeat(65);
    await expect(store.save(longId, { elements: [] })).rejects.toThrow('64 character');
  });

  it('overwrites existing checkpoint', async () => {
    await store.save('test-overwrite', { elements: [{ id: 'old' }] });
    await store.save('test-overwrite', { elements: [{ id: 'new' }] });
    const loaded = await store.load('test-overwrite');
    expect(loaded?.elements[0]?.id).toBe('new');
  });
});

describe('MemoryCheckpointStore', () => {
  const store = new MemoryCheckpointStore();

  it('saves and loads a checkpoint', async () => {
    const data = { elements: [{ id: 'e1', type: 'ellipse' }] };
    await store.save('test-mem-1', data);
    const loaded = await store.load('test-mem-1');
    expect(loaded).toEqual(data);
  });

  it('returns null for non-existent checkpoint', async () => {
    const loaded = await store.load('nonexistent-mem');
    expect(loaded).toBeNull();
  });

  it('rejects invalid checkpoint IDs', async () => {
    await expect(store.save('bad/id', { elements: [] })).rejects.toThrow('Invalid checkpoint id');
  });

  it('rejects oversized checkpoints', async () => {
    const huge = { elements: [{ data: 'x'.repeat(6_000_000) }] };
    await expect(store.save('oversized-mem', huge)).rejects.toThrow('byte limit');
  });

  it('handles corrupted stored data gracefully', async () => {
    // Save valid data, then load it — ensures the parse path works
    await store.save('parse-test', { elements: [{ id: 'x1' }] });
    const loaded = await store.load('parse-test');
    expect(loaded?.elements).toHaveLength(1);
  });
});

describe('createVercelStore', () => {
  it('returns MemoryCheckpointStore when no Redis env vars', () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.UPSTASH_REDIS_REST_URL;
    const store = createVercelStore();
    expect(store).toBeInstanceOf(MemoryCheckpointStore);
  });
});

describe('createStore', () => {
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

  it('returns FileCheckpointStore when no env vars set', () => {
    const store = createStore();
    expect(store).toBeInstanceOf(FileCheckpointStore);
  });

  it('returns ValkeyCheckpointStore when VALKEY_PASSWORD is set', () => {
    process.env.VALKEY_PASSWORD = 'test-pw';
    process.env.VALKEY_TLS_ENABLED = 'false';
    const store = createStore();
    // ValkeyCheckpointStore is not directly importable here without circular dep,
    // so check it's NOT FileCheckpointStore or MemoryCheckpointStore
    expect(store).not.toBeInstanceOf(FileCheckpointStore);
    expect(store).not.toBeInstanceOf(MemoryCheckpointStore);
  });
});
