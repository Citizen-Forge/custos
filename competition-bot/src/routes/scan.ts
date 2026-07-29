import { Router } from 'express';
import { get } from '../db/db.js';
import { scanPage } from '../bot/scanner.js';
import { botEvents } from '../events.js';

export const scanRouter = Router();

// `/all` must be defined BEFORE `/:pageId` or Express will match
// the literal path "all" as a pageId parameter and fail with NaN.
scanRouter.post('/all', async (_req, res) => {
  const pages = get().all<{ id: number; name: string }>('SELECT id, name FROM competition_pages WHERE enabled = 1');

  const results: Array<{ pageId: number; pageName: string; found: number }> = [];
  for (const page of pages) {
    try {
      const competitions = await scanPage(page.id);
      results.push({ pageId: page.id, pageName: page.name, found: competitions.length });
    } catch {
      results.push({ pageId: page.id, pageName: page.name, found: -1 });
    }
  }

  botEvents.scanDone(pages.length);
  res.json({ ok: true, data: results });
});

scanRouter.post('/:pageId', async (req, res) => {
  const pageId = Number(req.params.pageId);
  const page = get().get('SELECT * FROM competition_pages WHERE id = ?', [pageId]);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });

  try {
    const competitions = await scanPage(pageId);
    botEvents.scanDone(1);
    res.json({ ok: true, data: { found: competitions.length, competitions } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
