import { describe, it, expect, afterEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp, startStreamableHTTPServer } from './main.js';
import { FileCheckpointStore } from './checkpoint-store.js';
import { createServer } from './server.js';

function makeFactory() {
  const store = new FileCheckpointStore();
  return () => createServer(store);
}

const servers: Server[] = [];

function listenOnRandomPort(
  app: ReturnType<typeof createApp>,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      const addr = s.address();
      if (!addr || typeof addr === 'string') return reject(new Error('Bad address'));
      servers.push(s);
      resolve({ server: s, port: addr.port });
    });
  });
}

/** Extract JSON data from SSE response text */
function parseSseData(text: string): any[] {
  const results: any[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        results.push(JSON.parse(line.slice(6)));
      } catch {
        /* skip non-JSON lines */
      }
    }
  }
  return results;
}

afterEach(() => {
  for (const s of servers) s.close();
  servers.length = 0;
});

describe('Health endpoint', () => {
  it('GET /health returns 200 with status ok', async () => {
    const app = createApp(makeFactory());
    const { port } = await listenOnRandomPort(app);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });
});

describe('MCP endpoint', () => {
  it('POST /mcp with valid JSON-RPC initialize returns 200', async () => {
    const app = createApp(makeFactory());
    const { port } = await listenOnRandomPort(app);

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      }),
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    // Response may be JSON or SSE depending on SDK version
    const isSSE = text.startsWith('event:') || text.startsWith('data:');
    if (isSSE) {
      const messages = parseSseData(text);
      const initResult = messages.find((m: any) => m.result?.serverInfo);
      expect(initResult).toBeDefined();
    } else {
      const body = JSON.parse(text);
      expect(body.result?.serverInfo).toBeDefined();
    }
  });

  it('POST /mcp with invalid body returns error', async () => {
    const app = createApp(makeFactory());
    const { port } = await listenOnRandomPort(app);

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('GET /mcp without session returns 400+', async () => {
    const app = createApp(makeFactory());
    const { port } = await listenOnRandomPort(app);

    const res = await fetch(`http://127.0.0.1:${port}/mcp`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('DELETE /mcp returns a response', async () => {
    const app = createApp(makeFactory());
    const { port } = await listenOnRandomPort(app);

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'DELETE' });
    // Stateless mode accepts DELETE gracefully
    expect(res.status).toBeLessThan(500);
  });
});

describe('startStreamableHTTPServer', () => {
  let httpServer: Server | null = null;

  afterAll(() => {
    httpServer?.close();
  });

  it('starts server and returns http.Server', async () => {
    const store = new FileCheckpointStore();
    const factory = () => createServer(store);
    process.env.PORT = '0';
    process.env.HOST = '127.0.0.1';
    httpServer = await startStreamableHTTPServer(factory);
    expect(httpServer).toBeDefined();
    const addr = httpServer.address();
    expect(addr).toBeDefined();
    expect(typeof addr).not.toBe('string');

    // Verify health works on the started server
    if (addr && typeof addr !== 'string') {
      const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
      expect(res.status).toBe(200);
    }
    delete process.env.PORT;
    delete process.env.HOST;
  });
});
