import { Router } from 'express';
import { get } from '../db/db.js';

export const keywordsRouter = Router();

keywordsRouter.get('/', (_req, res) => {
  const rows = get().all('SELECT * FROM exclusion_keywords ORDER BY created_at DESC');
  res.json({ ok: true, data: rows });
});

keywordsRouter.post('/', (req, res) => {
  const { keyword } = req.body;
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return res.status(400).json({ ok: false, error: 'Keyword is required' });
  }
  try {
    get().run('INSERT INTO exclusion_keywords (keyword) VALUES (?)', [keyword.trim().toLowerCase()]);
    get().save();
    const rows = get().all('SELECT * FROM exclusion_keywords ORDER BY id DESC LIMIT 1');
    res.status(201).json({ ok: true, data: rows[0] || null });
  } catch {
    res.status(409).json({ ok: false, error: 'Keyword already exists' });
  }
});

keywordsRouter.delete('/:id', (req, res) => {
  get().run('DELETE FROM exclusion_keywords WHERE id = ?', [Number(req.params.id)]);
  get().save();
  res.json({ ok: true });
});
