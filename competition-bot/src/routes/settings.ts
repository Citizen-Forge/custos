import { Router } from 'express';
import { get } from '../db/db.js';

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  const rows = get().all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  res.json({ ok: true, data: settings });
});

settingsRouter.put('/', (req, res) => {
  const allowed = ['scan_interval_minutes', 'headless_mode', 'max_concurrent_entries', 'default_email', 'default_name', 'llm_verification_enabled', 'verification_provider_id', 'entry_interval_seconds', 'captcha_service', 'captcha_api_key', 'vpn_enabled', 'vpn_auto_rotate'];

  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) {
      get().run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
    }
  }
  get().save();

  const rows = get().all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  res.json({ ok: true, data: settings });
});
