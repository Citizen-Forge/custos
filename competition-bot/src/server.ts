import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from './db/db.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
import { providersRouter } from './routes/providers.js';
import { pagesRouter } from './routes/pages.js';
import { competitionsRouter } from './routes/competitions.js';
import { entriesRouter } from './routes/entries.js';
import { keywordsRouter } from './routes/keywords.js';
import { settingsRouter } from './routes/settings.js';
import { scanRouter } from './routes/scan.js';
import { enterRouter } from './routes/enter.js';
import { profileFieldsRouter } from './routes/profile-fields.js';
import { eventsRouter } from './routes/events.js';
import { testBrowserRouter } from './routes/test-browser.js';
import { vpnRouter } from './routes/vpn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // API routes
  app.use('/api/providers', providersRouter);
  app.use('/api/pages', pagesRouter);
  app.use('/api/competitions', competitionsRouter);
  app.use('/api/entries', entriesRouter);
  app.use('/api/keywords', keywordsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/scan', scanRouter);
  app.use('/api/enter', enterRouter);
  app.use('/api/profile-fields', profileFieldsRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/test-browser', testBrowserRouter);
  app.use('/api/vpn', vpnRouter);

  // Serve entry screenshots from the data directory
  app.use('/screenshots', express.static(path.join(DATA_DIR, 'screenshots')));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // Dashboard stats
  app.get('/api/stats', (_req, res) => {
    const total = (get().get<{ c: number }>('SELECT COUNT(*) as c FROM competitions'))?.c ?? 0;
    const entered = (get().get<{ c: number }>("SELECT COUNT(*) as c FROM competitions WHERE status = 'entered'"))?.c ?? 0;
    const pending = (get().get<{ c: number }>("SELECT COUNT(*) as c FROM competitions WHERE status = 'found'"))?.c ?? 0;
    const failed = (get().get<{ c: number }>("SELECT COUNT(*) as c FROM competitions WHERE status = 'failed'"))?.c ?? 0;
    const excluded = (get().get<{ c: number }>("SELECT COUNT(*) as c FROM competitions WHERE status = 'excluded'"))?.c ?? 0;
    const providers = (get().get<{ c: number }>('SELECT COUNT(*) as c FROM llm_providers'))?.c ?? 0;
    const pages = (get().get<{ c: number }>('SELECT COUNT(*) as c FROM competition_pages'))?.c ?? 0;
    res.json({ ok: true, data: { total, entered, pending, failed, excluded, providers, pages } });
  });

  // Serve static admin UI — only for non-API routes so unknown API paths
  // still return a proper 404 JSON response.
  const uiDist = path.resolve(__dirname, '..', 'admin-ui', 'dist');
  app.use(express.static(uiDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(uiDist, 'index.html'));
  });

  return app;
}
