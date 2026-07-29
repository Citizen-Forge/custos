import { Router } from 'express';
import { get } from '../db/db.js';
import { z } from 'zod';

export const profileFieldsRouter = Router();

const FieldSchema = z.object({
  field_key: z.string().min(1),
  field_label: z.string().min(1),
  field_value: z.string().default(''),
});

// List all
profileFieldsRouter.get('/', (_req, res) => {
  const rows = get().all('SELECT * FROM profile_fields ORDER BY field_key ASC');
  res.json({ ok: true, data: rows });
});

// Create
profileFieldsRouter.post('/', (req, res) => {
  const parsed = FieldSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  try {
    get().run(
      'INSERT INTO profile_fields (field_key, field_label, field_value) VALUES (?, ?, ?)',
      [parsed.data.field_key, parsed.data.field_label, parsed.data.field_value],
    );
    get().save();
    const rows = get().all('SELECT * FROM profile_fields ORDER BY id DESC LIMIT 1');
    res.status(201).json({ ok: true, data: rows[0] || null });
  } catch {
    res.status(409).json({ ok: false, error: 'A field with this key already exists' });
  }
});

// Update
profileFieldsRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = get().get('SELECT * FROM profile_fields WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });

  const fields: string[] = [];
  const values: unknown[] = [];
  if (req.body.field_key !== undefined) { fields.push('field_key = ?'); values.push(req.body.field_key); }
  if (req.body.field_label !== undefined) { fields.push('field_label = ?'); values.push(req.body.field_label); }
  if (req.body.field_value !== undefined) { fields.push('field_value = ?'); values.push(req.body.field_value); }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    values.push(id);
    get().run(`UPDATE profile_fields SET ${fields.join(', ')} WHERE id = ?`, values);
    get().save();
  }
  const updated = get().get('SELECT * FROM profile_fields WHERE id = ?', [id]);
  res.json({ ok: true, data: updated });
});

// Delete
profileFieldsRouter.delete('/:id', (req, res) => {
  get().run('DELETE FROM profile_fields WHERE id = ?', [Number(req.params.id)]);
  get().save();
  res.json({ ok: true });
});
