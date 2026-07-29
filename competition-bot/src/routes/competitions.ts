import { Router } from 'express';
import { get } from '../db/db.js';

export const competitionsRouter = Router();

competitionsRouter.get('/', (req, res) => {
  const status = req.query.status as string | undefined;
  let rows;
  if (status) {
    rows = get().all('SELECT * FROM competitions WHERE status = ? ORDER BY created_at DESC', [status]);
  } else {
    rows = get().all('SELECT * FROM competitions ORDER BY created_at DESC');
  }
  res.json({ ok: true, data: rows });
});

competitionsRouter.get('/:id', (req, res) => {
  const row = get().get('SELECT * FROM competitions WHERE id = ?', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, data: row });
});

// Bulk delete — accepts optional ?status= query to delete only competitions
// with a specific status. Without ?status= it deletes ALL competitions.
competitionsRouter.delete('/', (req, res) => {
  const status = req.query.status as string | undefined;
  const allowed = ['found', 'entered', 'failed', 'excluded', 'skipped'];
  if (status && !allowed.includes(status)) {
    return res.status(400).json({ ok: false, error: `Invalid status. Allowed: ${allowed.join(', ')}` });
  }

  const deleted = status
    ? get().run('DELETE FROM competitions WHERE status = ?', [status])
    : get().run('DELETE FROM competitions');
  get().save();
  res.json({ ok: true });
});

competitionsRouter.delete('/:id', (req, res) => {
  get().run('DELETE FROM competitions WHERE id = ?', [Number(req.params.id)]);
  get().save();
  res.json({ ok: true });
});

competitionsRouter.post('/:id/reset', (req, res) => {
  const existing = get().get('SELECT * FROM competitions WHERE id = ?', [Number(req.params.id)]);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  get().run("UPDATE competitions SET status = 'found', exclusion_reason = '' WHERE id = ?", [Number(req.params.id)]);
  get().save();
  const updated = get().get('SELECT * FROM competitions WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true, data: updated });
});
