import { Router, type Request, type Response } from 'express';
import { botEvents } from '../events.js';

export const eventsRouter = Router();

/**
 * Server-Sent Events endpoint.
 * The dashboard connects here and receives live scan/enter progress.
 */
eventsRouter.get('/', (req: Request, res: Response) => {
  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',  // disable nginx buffering if proxied
  });

  // Send an initial connection event
  res.write(`data: ${JSON.stringify({ type: 'info', message: '🟢 Connected', timestamp: new Date().toISOString() })}\n\n`);

  // Subscribe to all bot events
  const unsubscribe = botEvents.subscribe((event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Client disconnected
      unsubscribe();
    }
  });

  // Keep-alive ping every 30 seconds to prevent proxy timeouts
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
      unsubscribe();
    }
  }, 30_000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});
