import React, { useEffect, useState } from 'react';
import { settingsApi, keywordsApi, providersApi, type Settings, type ExclusionKeyword, type LlmProvider } from '../api.js';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keywords, setKeywords] = useState<ExclusionKeyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newKeyword, setNewKeyword] = useState('');
  const [message, setMessage] = useState('');
  const [providers, setProviders] = useState<LlmProvider[]>([]);

  const load = async () => {
    try {
      const [s, k, p] = await Promise.all([settingsApi.get(), keywordsApi.list(), providersApi.list()]);
      setSettings(s);
      setKeywords(k);
      setProviders(p);
    } catch (err) { console.error(err); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setMessage('');
    try {
      const updated = await settingsApi.update(settings);
      setSettings(updated);
      setMessage('✅ Settings saved');
    } catch (err) { setMessage(`Error: ${err}`); }
    setSaving(false);
  };

  const handleAddKeyword = async () => {
    if (!newKeyword.trim()) return;
    try {
      await keywordsApi.create(newKeyword.trim().toLowerCase());
      setNewKeyword('');
      const k = await keywordsApi.list();
      setKeywords(k);
    } catch (err) { alert('Keyword may already exist'); }
  };

  const handleDeleteKeyword = async (id: number) => {
    await keywordsApi.delete(id);
    setKeywords(keywords.filter((k) => k.id !== id));
  };

  if (loading) return <div style={styles.loading}>Loading...</div>;

  return (
    <div>
      <h1 style={styles.header}>Settings</h1>

      {/* General Settings */}
      <section style={styles.section}>
        <h2 style={styles.sectionHeader}>General</h2>
        <div style={styles.formGrid}>
          <label style={styles.label}>
            Scan Interval (minutes)
            <input
              type="number"
              value={settings?.scan_interval_minutes || 60}
              onChange={(e) => setSettings(settings ? { ...settings, scan_interval_minutes: e.target.value } : null)}
              style={styles.input}
              min={1}
            />
          </label>
          <label style={styles.label}>
            Max Concurrent Entries
            <input
              type="number"
              value={settings?.max_concurrent_entries || 3}
              onChange={(e) => setSettings(settings ? { ...settings, max_concurrent_entries: e.target.value } : null)}
              style={styles.input}
              min={1}
              max={10}
            />
          </label>
          <label style={styles.label}>
            Entry Interval (seconds)
            <input
              type="number"
              value={settings?.entry_interval_seconds || 30}
              onChange={(e) => setSettings(settings ? { ...settings, entry_interval_seconds: e.target.value } : null)}
              style={styles.input}
              min={5}
              max={600}
            />
            <span style={{ color: '#8b949e', fontSize: 12, marginTop: 2 }}>
              Delay between competition entries to avoid rate limiting. A random jitter of ±30% is added automatically.
            </span>
          </label>
          <label style={styles.label}>
            Headless Mode
            <select
              value={settings?.headless_mode || 'true'}
              onChange={(e) => setSettings(settings ? { ...settings, headless_mode: e.target.value } : null)}
              style={styles.input}
            >
              <option value="true">Yes (no visible browser)</option>
              <option value="false">No (show browser)</option>
            </select>
          </label>
          <label style={styles.label}>
            Default Email
            <input
              type="email"
              value={settings?.default_email || ''}
              onChange={(e) => setSettings(settings ? { ...settings, default_email: e.target.value } : null)}
              style={styles.input}
              placeholder="user@example.com"
            />
          </label>
          <label style={styles.label}>
            Default Name
            <input
              type="text"
              value={settings?.default_name || ''}
              onChange={(e) => setSettings(settings ? { ...settings, default_name: e.target.value } : null)}
              style={styles.input}
              placeholder="Alex Johnson"
            />
          </label>
        </div>
        <button onClick={handleSave} disabled={saving} style={styles.saveBtn}>
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {message && <p style={styles.message}>{message}</p>}
      </section>

      {/* LLM Verification */}
      <section style={styles.section}>
        <h2 style={styles.sectionHeader}>🤖 LLM Verification</h2>
        <p style={styles.description}>
          After the scanner finds candidate competitions using heuristics, send them to the LLM
          for a second opinion. The LLM filters out false positives (nav links, category pages, etc.)
          — slower but much more accurate, especially on unusual site layouts.
        </p>

        <label style={{ ...styles.label, flexDirection: 'row', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings?.llm_verification_enabled === 'true'}
            onChange={(e) => setSettings(settings ? { ...settings, llm_verification_enabled: e.target.checked ? 'true' : 'false' } : null)}
            style={{ width: 20, height: 20, accentColor: '#238636' }}
          />
          <span style={{ fontSize: 14, color: '#e1e4e8', flex: 1 }}>
            Enable LLM verification on scan
            {(!settings?.llm_verification_enabled || settings.llm_verification_enabled === 'false') &&
              <span style={{ color: '#8b949e', fontSize: 12, display: 'block', marginTop: 2 }}>
                Heuristic-only mode — may include false positives
              </span>
            }
            {settings?.llm_verification_enabled === 'true' &&
              <span style={{ color: '#3fb950', fontSize: 12, display: 'block', marginTop: 2 }}>
                Verification runs on every scan after heuristic scoring
              </span>
            }
          </span>
        </label>

        {settings?.llm_verification_enabled === 'true' && (
          <label style={styles.label}>
            Verification Provider
            <select
              value={settings?.verification_provider_id || ''}
              onChange={(e) => setSettings(settings ? { ...settings, verification_provider_id: e.target.value } : null)}
              style={styles.input}
            >
              <option value="">Auto (first configured provider) — {providers[0]?.name || 'none available'}</option>
              {providers.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name} ({p.model})
                </option>
              ))}
            </select>
            <span style={{ color: '#8b949e', fontSize: 12, marginTop: 2 }}>
              Use a cheaper/faster model here (e.g. Gemini Flash) to save tokens
            </span>
          </label>
        )}
      </section>

      {/* CAPTCHA Solving Service */}
      <section style={styles.section}>
        <h2 style={styles.sectionHeader}>🔐 External CAPTCHA Solving Service</h2>
        <p style={styles.description}>
          When the LLM can't solve a text CAPTCHA and automatic form submission fails,
          an external solving service can handle reCAPTCHA v2, hCaptcha, and Cloudflare
          Turnstile challenges automatically. Requires a paid account with the service.
        </p>

        <div style={styles.formGrid}>
          <label style={styles.label}>
            Service Provider
            <select
              value={settings?.captcha_service || 'none'}
              onChange={(e) => setSettings(settings ? { ...settings, captcha_service: e.target.value } : null)}
              style={styles.input}
            >
              <option value="none">Disabled</option>
              <option value="2captcha">2captcha.com</option>
              <option value="capsolver">Capsolver.com</option>
            </select>
            <span style={{ color: '#8b949e', fontSize: 12, marginTop: 2 }}>
              {settings?.captcha_service === 'none'
                ? 'CAPTCHA-protected forms will fail entry — the bot attempts entry regardless but may be blocked'
                : settings?.captcha_service === '2captcha'
                  ? 'Costs ~$2-3 per 1000 solves for reCAPTCHA v2'
                  : 'Costs ~$3-4 per 1000 solves for reCAPTCHA v2'
              }
            </span>
          </label>

          {settings?.captcha_service !== 'none' && (
            <label style={styles.label}>
              API Key
              <input
                type="password"
                value={settings?.captcha_api_key || ''}
                onChange={(e) => setSettings(settings ? { ...settings, captcha_api_key: e.target.value } : null)}
                style={styles.input}
                placeholder="Enter your API key"
              />
              <span style={{ color: '#8b949e', fontSize: 12, marginTop: 2 }}>
                Your API key is stored locally and never shared.
              </span>
            </label>
          )}
        </div>
      </section>

      {/* Exclusion Keywords */}
      <section style={styles.section}>
        <h2 style={styles.sectionHeader}>Exclusion Keywords</h2>
        <p style={styles.description}>
          Competitions matching these keywords will be automatically skipped.
          Common excludes: "free spins", "bonus", "casino", etc.
        </p>

        <div style={styles.addKeywordRow}>
          <input
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddKeyword()}
            placeholder="e.g. free spins"
            style={styles.input}
          />
          <button onClick={handleAddKeyword} style={styles.addBtn}>Add</button>
        </div>

        <div style={styles.keywordList}>
          {keywords.map((k) => (
            <div key={k.id} style={styles.keywordChip}>
              <span>{k.keyword}</span>
              <button onClick={() => handleDeleteKeyword(k.id)} style={styles.removeBtn}>✕</button>
            </div>
          ))}
          {keywords.length === 0 && <p style={styles.empty}>No exclusion keywords configured.</p>}
        </div>
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loading: { padding: 40, fontSize: 18, color: '#8b949e' },
  header: { fontSize: 28, fontWeight: 700, margin: '0 0 24px', color: '#f0f6fc' },
  section: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 24, marginBottom: 24 },
  sectionHeader: { fontSize: 18, fontWeight: 600, margin: '0 0 8px', color: '#f0f6fc' },
  description: { color: '#8b949e', fontSize: 13, margin: '0 0 16px' },
  formGrid: { display: 'flex', flexDirection: 'column' as const, gap: 16, marginBottom: 20 },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 6, fontSize: 13, fontWeight: 600, color: '#e1e4e8' },
  input: { padding: '10px 14px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, color: '#e1e4e8', fontSize: 14 },
  saveBtn: { padding: '10px 24px', background: '#238636', color: '#fff', border: '1px solid #2ea043', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  message: { color: '#3fb950', fontSize: 14, marginTop: 12 },
  addKeywordRow: { display: 'flex', gap: 8, marginBottom: 16 },
  addBtn: { padding: '10px 20px', background: '#238636', color: '#fff', border: '1px solid #2ea043', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  keywordList: { display: 'flex', flexWrap: 'wrap' as const, gap: 8 },
  keywordChip: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 12px', background: '#1f2937', border: '1px solid #30363d',
    borderRadius: 20, fontSize: 13, color: '#e1e4e8',
  },
  removeBtn: { background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 },
  empty: { color: '#8b949e', fontSize: 13, width: '100%' },
};
