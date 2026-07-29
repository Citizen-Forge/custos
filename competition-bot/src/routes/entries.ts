import { Router } from 'express';
import { get } from '../db/db.js';

export const entriesRouter = Router();

entriesRouter.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = get().all('SELECT * FROM entries ORDER BY created_at DESC LIMIT ?', [limit]);
  res.json({ ok: true, data: rows });
});

entriesRouter.get('/:id', (req, res) => {
  const row = get().get('SELECT * FROM entries WHERE id = ?', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, data: row });
});
