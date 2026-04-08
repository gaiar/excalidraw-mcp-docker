import fs from 'node:fs';
import { Redis, type RedisOptions } from 'ioredis';
import { validateCheckpointId } from '../checkpoint-store.js';
import type { CheckpointStore } from '../checkpoint-store.js';

/** Maximum serialized checkpoint size (5 MB). */
const MAX_CHECKPOINT_BYTES = 5 * 1024 * 1024;

/** Default TTL: 30 days in seconds. */
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Redis key prefix for checkpoints. */
const KEY_PREFIX = 'cp:';

export interface ValkeyConfig {
  host: string;
  port: number;
  password: string;
  db: number;
  tlsEnabled: boolean;
  tlsCaCert?: string;
  tlsClientCert?: string;
  tlsClientKey?: string;
  ttlSeconds: number;
}

/**
 * Reads Valkey configuration from environment variables.
 * Throws if VALKEY_PASSWORD is not set.
 */
export function readValkeyConfig(): ValkeyConfig {
  const password = process.env.VALKEY_PASSWORD;
  if (!password) {
    throw new Error('VALKEY_PASSWORD environment variable is required');
  }

  return {
    host: process.env.VALKEY_HOST ?? 'valkey',
    port: parseInt(process.env.VALKEY_PORT ?? '6379', 10),
    password,
    db: parseInt(process.env.VALKEY_DB ?? '0', 10),
    tlsEnabled: process.env.VALKEY_TLS_ENABLED !== 'false',
    tlsCaCert: process.env.VALKEY_TLS_CA_CERT,
    tlsClientCert: process.env.VALKEY_TLS_CLIENT_CERT,
    tlsClientKey: process.env.VALKEY_TLS_CLIENT_KEY,
    ttlSeconds: parseInt(
      process.env.VALKEY_CHECKPOINT_TTL_SECONDS ?? String(DEFAULT_TTL_SECONDS),
      10,
    ),
  };
}

/**
 * Builds ioredis connection options from ValkeyConfig.
 */
export function buildRedisOptions(config: ValkeyConfig): RedisOptions {
  const options: RedisOptions = {
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db,
    username: 'excalidraw',
    maxRetriesPerRequest: 3,
    retryStrategy(times: number): number | null {
      if (times > 10) return null; // stop retrying after 10 attempts
      return Math.min(times * 200, 5000); // exponential backoff, max 5s
    },
    lazyConnect: true,
  };

  if (config.tlsEnabled) {
    const tls: Record<string, unknown> = {};
    if (config.tlsCaCert) {
      tls.ca = fs.readFileSync(config.tlsCaCert);
    }
    if (config.tlsClientCert) {
      tls.cert = fs.readFileSync(config.tlsClientCert);
    }
    if (config.tlsClientKey) {
      tls.key = fs.readFileSync(config.tlsClientKey);
    }
    // Accept self-signed certs within Docker network
    tls.rejectUnauthorized = !!config.tlsCaCert;
    options.tls = tls;
  }

  return options;
}

export class ValkeyCheckpointStore implements CheckpointStore {
  private client: Redis;
  private ttlSeconds: number;
  private connected = false;

  constructor(config: ValkeyConfig) {
    this.ttlSeconds = config.ttlSeconds;
    this.client = new Redis(buildRedisOptions(config));

    this.client.on('error', (err: Error) => {
      console.error('[valkey] Connection error:', err.message);
    });

    this.client.on('connect', () => {
      this.connected = true;
      console.log(`[valkey] Connected to ${config.host}:${config.port}`);
    });

    this.client.on('close', () => {
      this.connected = false;
    });
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
    }
  }

  async save(id: string, data: { elements: any[] }): Promise<void> {
    validateCheckpointId(id);
    const serialized = JSON.stringify(data);
    if (serialized.length > MAX_CHECKPOINT_BYTES) {
      throw new Error(`Checkpoint data exceeds ${MAX_CHECKPOINT_BYTES} byte limit`);
    }
    await this.connect();
    await this.client.set(`${KEY_PREFIX}${id}`, serialized, 'EX', this.ttlSeconds);
  }

  async load(id: string): Promise<{ elements: any[] } | null> {
    validateCheckpointId(id);
    await this.connect();
    const raw = await this.client.get(`${KEY_PREFIX}${id}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

/**
 * Creates a ValkeyCheckpointStore with graceful shutdown handlers.
 * Returns null if VALKEY_PASSWORD is not set.
 */
export function createValkeyStore(): ValkeyCheckpointStore | null {
  if (!process.env.VALKEY_PASSWORD) {
    return null;
  }

  const config = readValkeyConfig();
  const store = new ValkeyCheckpointStore(config);

  const shutdown = () => {
    store.disconnect().catch(() => {});
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return store;
}
