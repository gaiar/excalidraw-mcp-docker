/**
 * Entry point for running the MCP server.
 * Run with: npx @mcp-demos/excalidraw-server
 * Or: node dist/index.js [--stdio]
 */

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'node:http';
import { createStore } from './checkpoint-store.js';
import { createServer } from './server.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Request logging middleware */
function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
}

/**
 * Creates and configures the Express app with MCP routes.
 * Exported for testing.
 */
export function createApp(serverFactory: () => McpServer): ReturnType<typeof createMcpExpressApp> {
  const app = createMcpExpressApp({ host: '0.0.0.0' });
  app.use(cors());
  app.use(requestLogger);

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.all('/mcp', async (req: Request, res: Response) => {
    const server = serverFactory();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  return app;
}

/**
 * Starts an MCP server with Streamable HTTP transport in stateless mode.
 */
export async function startStreamableHTTPServer(serverFactory: () => McpServer): Promise<Server> {
  const port = parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  const app = createApp(serverFactory);

  return new Promise<Server>((resolve, reject) => {
    const httpServer = app.listen(port, host, (err) => {
      if (err) {
        reject(err);
        return;
      }
      console.log(`MCP server listening on http://${host}:${port}/mcp`);
      resolve(httpServer);
    });

    /* v8 ignore start -- shutdown handlers can't be tested without killing the process */
    const shutdown = () => {
      console.log('\nShutting down...');
      httpServer.close(() => process.exit(0));
      setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    /* v8 ignore stop */
  });
}

/**
 * Starts an MCP server with stdio transport.
 */
export async function startStdioServer(serverFactory: () => McpServer): Promise<void> {
  await serverFactory().connect(new StdioServerTransport());
}

/* v8 ignore start -- CLI entry point, tested via integration/smoke tests */
async function main() {
  const store = createStore();
  const factory = () => createServer(store);
  if (process.argv.includes('--stdio')) {
    await startStdioServer(factory);
  } else {
    await startStreamableHTTPServer(factory);
  }
}

// Only run main() when executed directly (not imported in tests)
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/main.ts') ||
    process.argv[1].endsWith('/main.js') ||
    process.argv[1].endsWith('/index.js'));

if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
/* v8 ignore stop */
