import { Router } from 'express';
import { get } from '../db/db.js';
import { CompetitionPageSchema } from '../config/types.js';

export const pagesRouter = Router();

pagesRouter.get('/', (_req, res) => {
  const rows = get().all('SELECT * FROM competition_pages ORDER BY created_at DESC');
  res.json({ ok: true, data: rows });
});

pagesRouter.get('/:id', (req, res) => {
  const row = get().get('SELECT * FROM competition_pages WHERE id = ?', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, data: row });
});

pagesRouter.post('/', (req, res) => {
  const parsed = CompetitionPageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  get().run(
    'INSERT INTO competition_pages (name, url, enabled) VALUES (?, ?, ?)',
    [parsed.data.name, parsed.data.url, parsed.data.enabled ? 1 : 0],
  );
  get().save();
  const rows = get().all('SELECT * FROM competition_pages ORDER BY id DESC LIMIT 1');
  res.status(201).json({ ok: true, data: rows[0] || null });
});

pagesRouter.put('/:id', (req, res) => {
  const parsed = CompetitionPageSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const existing = get().get('SELECT * FROM competition_pages WHERE id = ?', [Number(req.params.id)]);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });

  const fields: string[] = [];
  const values: unknown[] = [];
  if (parsed.data.name !== undefined) { fields.push('name = ?'); values.push(parsed.data.name); }
  if (parsed.data.url !== undefined) { fields.push('url = ?'); values.push(parsed.data.url); }
  if (parsed.data.enabled !== undefined) { fields.push('enabled = ?'); values.push(parsed.data.enabled ? 1 : 0); }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    values.push(Number(req.params.id));
    get().run(`UPDATE competition_pages SET ${fields.join(', ')} WHERE id = ?`, values);
    get().save();
  }
  const updated = get().get('SELECT * FROM competition_pages WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true, data: updated });
});

pagesRouter.delete('/:id', (req, res) => {
  get().run('DELETE FROM competition_pages WHERE id = ?', [Number(req.params.id)]);
  get().save();
  res.json({ ok: true });
});
