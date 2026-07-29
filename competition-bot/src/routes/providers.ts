import { Router } from 'express';
import OpenAI from 'openai';
import { get } from '../db/db.js';
import { LlmProviderSchema } from '../config/types.js';

export const providersRouter = Router();

// List all
providersRouter.get('/', (_req, res) => {
  const rows = get().all('SELECT * FROM llm_providers ORDER BY created_at DESC');
  res.json({ ok: true, data: rows });
});

// Get one
providersRouter.get('/:id', (req, res) => {
  const row = get().get('SELECT * FROM llm_providers WHERE id = ?', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, data: row });
});

// Create
providersRouter.post('/', (req, res) => {
  const parsed = LlmProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  get().run(`
    INSERT INTO llm_providers (name, base_url, api_key, model, rpm_limit)
    VALUES (?, ?, ?, ?, ?)
  `, [
    parsed.data.name,
    parsed.data.base_url,
    parsed.data.api_key,
    parsed.data.model,
    parsed.data.rpm_limit,
  ]);
  get().save();
  const rows = get().all('SELECT * FROM llm_providers ORDER BY id DESC LIMIT 1');
  res.status(201).json({ ok: true, data: rows[0] || null });
});

// Update
providersRouter.put('/:id', (req, res) => {
  const parsed = LlmProviderSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const existing = get().get('SELECT * FROM llm_providers WHERE id = ?', [Number(req.params.id)]);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });

  const fields: string[] = [];
  const dbValues: unknown[] = [];
  const m: Record<string, string> = { name: 'name', base_url: 'base_url', api_key: 'api_key', model: 'model', rpm_limit: 'rpm_limit' };
  for (const [key, col] of Object.entries(m)) {
    if (parsed.data[key as keyof typeof parsed.data] !== undefined) {
      fields.push(`${col} = ?`);
      dbValues.push(parsed.data[key as keyof typeof parsed.data]);
    }
  }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    dbValues.push(Number(req.params.id));
    get().run(`UPDATE llm_providers SET ${fields.join(', ')} WHERE id = ?`, dbValues);
    get().save();
  }
  const updated = get().get('SELECT * FROM llm_providers WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true, data: updated });
});

// Test connection — lightweight completion to verify config
providersRouter.post('/test', async (req, res) => {
  const { base_url, api_key, model } = req.body;
  if (!base_url || !model) {
    return res.status(400).json({ ok: false, error: 'base_url and model are required' });
  }

  try {
    const client = new OpenAI({
      baseURL: base_url,
      apiKey: api_key || 'sk-dummy',
      timeout: 15_000,
      maxRetries: 0,
    });

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Reply with only the word "ok".' },
        { role: 'user', content: 'Say ok' },
      ],
      temperature: 0,
      max_tokens: 10,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || '';

    // Even if the model doesn't follow instructions perfectly, if we got
    // a response the connection works.
    res.json({
      ok: true,
      data: {
        success: true,
        message: `✅ Connected! Model replied: "${reply}"`,
        model: completion.model,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Try to extract a useful error message
    const friendly = message
      .replace(/^4\d\d /, '')        // strip HTTP status prefix
      .replace(/^5\d\d /, '')
      .split('\n')[0]
      .slice(0, 200);
    res.json({
      ok: true,
      data: {
        success: false,
        message: `❌ ${friendly}`,
      },
    });
  }
});

// Delete
providersRouter.delete('/:id', (req, res) => {
  get().run('DELETE FROM llm_providers WHERE id = ?', [Number(req.params.id)]);
  get().save();
  res.json({ ok: true });
});
