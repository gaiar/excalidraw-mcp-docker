/**
 * MCP protocol integration test (runs against locally started server, no Docker).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/main.js';
import { FileCheckpointStore } from '../src/checkpoint-store.js';
import { createServer } from '../src/server.js';

let server: Server;
let port: number;

function makeFactory() {
  const store = new FileCheckpointStore();
  return () => createServer(store);
}

/** Parse SSE response to extract JSON-RPC data messages */
function parseSseData(text: string): any[] {
  const results: any[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        results.push(JSON.parse(line.slice(6)));
      } catch {
        /* skip */
      }
    }
  }
  return results;
}

/** Send an MCP JSON-RPC request and return parsed response */
async function mcpRequest(body: object): Promise<{ status: number; text: string; data: any[] }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const isSSE = text.startsWith('event:') || text.startsWith('data:');
  const data = isSSE ? parseSseData(text) : [JSON.parse(text)];
  return { status: res.status, text, data };
}

beforeAll(async () => {
  const app = createApp(makeFactory());
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('Bad address'));
      port = addr.port;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

describe('MCP protocol smoke tests', () => {
  it('initialize returns serverInfo with capabilities', async () => {
    const { status, data } = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '1.0' },
      },
    });

    expect(status).toBe(200);
    const initMsg = data.find((m: any) => m.result?.serverInfo);
    expect(initMsg).toBeDefined();
    expect(initMsg.result.capabilities).toBeDefined();
  });

  it('invalid JSON-RPC returns error', async () => {
    const { status } = await mcpRequest({ invalid: true });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('health endpoint returns ok', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
