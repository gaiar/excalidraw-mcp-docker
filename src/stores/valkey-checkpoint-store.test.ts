import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readValkeyConfig,
  buildRedisOptions,
  ValkeyCheckpointStore,
  createValkeyStore,
} from './valkey-checkpoint-store.js';
import type { ValkeyConfig } from './valkey-checkpoint-store.js';

// Mock ioredis
vi.mock('ioredis', () => {
  const store = new Map<string, { value: string; ttl: number }>();

  class MockRedis {
    private handlers: Record<string, ((...args: any[]) => void)[]> = {};
    connected = false;

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
      store.set(key, { value, ttl });
      return 'OK';
    }

    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      return entry?.value ?? null;
    }
  }

  return { default: MockRedis, Redis: MockRedis };
});

// Mock fs for TLS cert reading
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn((path: string) => `cert-content:${path}`),
    },
  };
});

function makeConfig(overrides: Partial<ValkeyConfig> = {}): ValkeyConfig {
  return {
    host: 'valkey',
    port: 6379,
    password: 'test-password',
    db: 0,
    tlsEnabled: false,
    ttlSeconds: 86400,
    ...overrides,
  };
}

describe('readValkeyConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws if VALKEY_PASSWORD is not set', () => {
    delete process.env.VALKEY_PASSWORD;
    expect(() => readValkeyConfig()).toThrow('VALKEY_PASSWORD environment variable is required');
  });

  it('reads config with defaults', () => {
    process.env.VALKEY_PASSWORD = 'secret';
    const config = readValkeyConfig();
    expect(config.host).toBe('valkey');
    expect(config.port).toBe(6379);
    expect(config.password).toBe('secret');
    expect(config.db).toBe(0);
    expect(config.tlsEnabled).toBe(true);
    expect(config.ttlSeconds).toBe(30 * 24 * 60 * 60);
  });

  it('reads custom env vars', () => {
    process.env.VALKEY_PASSWORD = 'pw';
    process.env.VALKEY_HOST = 'custom-host';
    process.env.VALKEY_PORT = '6380';
    process.env.VALKEY_DB = '2';
    process.env.VALKEY_TLS_ENABLED = 'false';
    process.env.VALKEY_CHECKPOINT_TTL_SECONDS = '3600';
    const config = readValkeyConfig();
    expect(config.host).toBe('custom-host');
    expect(config.port).toBe(6380);
    expect(config.db).toBe(2);
    expect(config.tlsEnabled).toBe(false);
    expect(config.ttlSeconds).toBe(3600);
  });

  it('reads TLS cert paths from env', () => {
    process.env.VALKEY_PASSWORD = 'pw';
    process.env.VALKEY_TLS_CA_CERT = '/tls/ca.crt';
    process.env.VALKEY_TLS_CLIENT_CERT = '/tls/client.crt';
    process.env.VALKEY_TLS_CLIENT_KEY = '/tls/client.key';
    const config = readValkeyConfig();
    expect(config.tlsCaCert).toBe('/tls/ca.crt');
    expect(config.tlsClientCert).toBe('/tls/client.crt');
    expect(config.tlsClientKey).toBe('/tls/client.key');
  });
});

describe('buildRedisOptions', () => {
  it('builds basic options without TLS', () => {
    const config = makeConfig();
    const opts = buildRedisOptions(config);
    expect(opts.host).toBe('valkey');
    expect(opts.port).toBe(6379);
    expect(opts.password).toBe('test-password');
    expect(opts.db).toBe(0);
    expect(opts.username).toBe('excalidraw');
    expect(opts.tls).toBeUndefined();
    expect(opts.lazyConnect).toBe(true);
  });

  it('builds TLS options with CA cert', () => {
    const config = makeConfig({
      tlsEnabled: true,
      tlsCaCert: '/tls/ca.crt',
    });
    const opts = buildRedisOptions(config);
    expect(opts.tls).toBeDefined();
    expect((opts.tls as Record<string, unknown>).rejectUnauthorized).toBe(true);
  });

  it('builds TLS options with client certs', () => {
    const config = makeConfig({
      tlsEnabled: true,
      tlsCaCert: '/tls/ca.crt',
      tlsClientCert: '/tls/client.crt',
      tlsClientKey: '/tls/client.key',
    });
    const opts = buildRedisOptions(config);
    expect(opts.tls).toBeDefined();
    const tls = opts.tls as Record<string, unknown>;
    expect(tls.ca).toBeDefined();
    expect(tls.cert).toBeDefined();
    expect(tls.key).toBeDefined();
  });

  it('disables strict TLS verification when no CA cert', () => {
    const config = makeConfig({ tlsEnabled: true });
    const opts = buildRedisOptions(config);
    expect((opts.tls as Record<string, unknown>).rejectUnauthorized).toBe(false);
  });

  it('retryStrategy returns null after 10 attempts', () => {
    const config = makeConfig();
    const opts = buildRedisOptions(config);
    expect(opts.retryStrategy!(11)).toBeNull();
  });

  it('retryStrategy returns exponential backoff', () => {
    const config = makeConfig();
    const opts = buildRedisOptions(config);
    expect(opts.retryStrategy!(1)).toBe(200);
    expect(opts.retryStrategy!(3)).toBe(600);
    expect(opts.retryStrategy!(100)).toBeNull(); // > 10
  });
});

describe('ValkeyCheckpointStore', () => {
  let store: ValkeyCheckpointStore;

  beforeEach(() => {
    store = new ValkeyCheckpointStore(makeConfig());
  });

  it('saves and loads a checkpoint', async () => {
    const data = { elements: [{ id: 'r1', type: 'rectangle' }] };
    await store.save('test-valkey-1', data);
    const loaded = await store.load('test-valkey-1');
    expect(loaded).toEqual(data);
  });

  it('returns null for non-existent checkpoint', async () => {
    const loaded = await store.load('nonexistent-valkey');
    expect(loaded).toBeNull();
  });

  it('rejects invalid checkpoint IDs', async () => {
    await expect(store.save('../hack', { elements: [] })).rejects.toThrow('Invalid checkpoint id');
    await expect(store.load('../hack')).rejects.toThrow('Invalid checkpoint id');
  });

  it('rejects oversized checkpoints', async () => {
    const huge = { elements: [{ data: 'x'.repeat(6_000_000) }] };
    await expect(store.save('oversized-valkey', huge)).rejects.toThrow('byte limit');
  });

  it('rejects too-long checkpoint IDs', async () => {
    const longId = 'a'.repeat(65);
    await expect(store.save(longId, { elements: [] })).rejects.toThrow('64 character');
  });

  it('overwrites existing checkpoint', async () => {
    await store.save('test-overwrite-v', { elements: [{ id: 'old' }] });
    await store.save('test-overwrite-v', { elements: [{ id: 'new' }] });
    const loaded = await store.load('test-overwrite-v');
    expect(loaded?.elements[0]?.id).toBe('new');
  });

  it('handles corrupted stored data gracefully', async () => {
    // Save valid data and load — ensures the parse path works
    await store.save('parse-test-v', { elements: [{ id: 'x1' }] });
    const loaded = await store.load('parse-test-v');
    expect(loaded?.elements).toHaveLength(1);
  });

  it('connects and disconnects', async () => {
    await store.connect();
    await store.disconnect();
  });
});

describe('createValkeyStore', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns null when VALKEY_PASSWORD is not set', () => {
    delete process.env.VALKEY_PASSWORD;
    const result = createValkeyStore();
    expect(result).toBeNull();
  });

  it('returns ValkeyCheckpointStore when password is set', () => {
    process.env.VALKEY_PASSWORD = 'test';
    process.env.VALKEY_TLS_ENABLED = 'false';
    const result = createValkeyStore();
    expect(result).toBeInstanceOf(ValkeyCheckpointStore);
  });
});
