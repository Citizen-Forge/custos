import React, { useEffect, useState } from 'react';
import { providersApi, type LlmProvider } from '../api.js';

export default function ProvidersPage() {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<LlmProvider | null>(null);
  const [form, setForm] = useState({ name: '', base_url: '', api_key: '', model: '', rpm_limit: 10 });
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const load = () => providersApi.list().then(setProviders).catch(console.error).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const handleSubmit = async () => {
    setError('');
    try {
      if (editing) {
        await providersApi.update(editing.id, form);
      } else {
        await providersApi.create(form);
      }
      setShowForm(false);
      setEditing(null);
      setForm({ name: '', base_url: '', api_key: '', model: '', rpm_limit: 10 });
      load();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleEdit = (p: LlmProvider) => {
    setEditing(p);
    setForm({ name: p.name, base_url: p.base_url, api_key: '', model: p.model, rpm_limit: p.rpm_limit });
    setShowForm(true);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this provider?')) return;
    await providersApi.delete(id);
    load();
  };

  if (loading) return <div style={styles.loading}>Loading...</div>;

  return (
    <div>
      <div style={styles.headerRow}>
        <h1 style={styles.header}>LLM Providers</h1>
        <button onClick={() => { setShowForm(!showForm); setEditing(null); setForm({ name: '', base_url: '', api_key: '', model: '', rpm_limit: 10 }); }} style={styles.addBtn}>
          {showForm ? '✕ Cancel' : '+ Add Provider'}
        </button>
      </div>

      {showForm && (
        <div style={styles.form}>
          <input placeholder="Name (e.g. Gemini Free)" value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setTestResult(null); }} style={styles.input} />
          <input placeholder="Base URL (e.g. https://generativelanguage.googleapis.com/v1beta/openai/)" value={form.base_url} onChange={(e) => { setForm({ ...form, base_url: e.target.value }); setTestResult(null); }} style={styles.input} />
          <input placeholder="API Key (if required)" value={form.api_key} onChange={(e) => { setForm({ ...form, api_key: e.target.value }); setTestResult(null); }} style={styles.input} />
          <input placeholder="Model (e.g. gemini-2.0-flash-exp)" value={form.model} onChange={(e) => { setForm({ ...form, model: e.target.value }); setTestResult(null); }} style={styles.input} />
          <input placeholder="RPM Limit" type="number" value={form.rpm_limit} onChange={(e) => { setForm({ ...form, rpm_limit: Number(e.target.value) }); setTestResult(null); }} style={{ ...styles.input, width: 120 }} />
          {error && <p style={styles.error}>{error}</p>}
          <div style={styles.buttonRow}>
            <button onClick={handleSubmit} style={styles.saveBtn}>{editing ? 'Update' : 'Create'}</button>
            <button
              onClick={async () => {
                if (!form.base_url || !form.model) return;
                setTesting(true);
                setTestResult(null);
                try {
                  const result = await providersApi.test(form);
                  setTestResult(result);
                } catch (err) {
                  setTestResult({ success: false, message: String(err) });
                }
                setTesting(false);
              }}
              disabled={testing || !form.base_url || !form.model}
              style={{
                ...styles.testBtn,
                opacity: (!form.base_url || !form.model) ? 0.5 : 1,
              }}
            >
              {testing ? '⏳ Testing...' : '🔌 Test Connection'}
            </button>
          </div>
          {testResult && (
            <p style={{
              ...styles.testResult,
              color: testResult.success ? '#3fb950' : '#f85149',
            }}>
              {testResult.message}
            </p>
          )}
        </div>
      )}

      <div style={styles.table}>
        <div style={styles.tableHeader}>
          <span style={{ ...styles.th, flex: 2 }}>Name</span>
          <span style={{ ...styles.th, flex: 3 }}>Base URL</span>
          <span style={{ ...styles.th, flex: 2 }}>Model</span>
          <span style={{ ...styles.th, flex: 0.5 }}>RPM</span>
          <span style={{ ...styles.th, flex: 0.8 }}>Actions</span>
        </div>
        {providers.length === 0 && <p style={styles.empty}>No providers configured yet.</p>}
        {providers.map((p) => (
          <div key={p.id} style={styles.row}>
            <span style={{ flex: 2 }}>{p.name}</span>
            <span style={{ flex: 3, color: '#8b949e', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.base_url}</span>
            <span style={{ flex: 2, fontSize: 13 }}>{p.model}</span>
            <span style={{ flex: 0.5 }}>{p.rpm_limit}</span>
            <span style={{ flex: 0.8, display: 'flex', gap: 8 }}>
              <button onClick={() => handleEdit(p)} style={styles.editBtn}>✏️</button>
              <button onClick={() => handleDelete(p.id)} style={styles.deleteBtn}>🗑️</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loading: { padding: 40, fontSize: 18, color: '#8b949e' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  header: { fontSize: 28, fontWeight: 700, margin: 0, color: '#f0f6fc' },
  addBtn: { padding: '10px 20px', background: '#238636', color: '#fff', border: '1px solid #2ea043', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  form: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 20, marginBottom: 24, display: 'flex', flexWrap: 'wrap' as const, gap: 12, alignItems: 'flex-end' },
  input: { padding: '10px 14px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, color: '#e1e4e8', fontSize: 14, flex: 1, minWidth: 200 },
  error: { color: '#f85149', fontSize: 13, width: '100%' },
  buttonRow: { display: 'flex', gap: 10, width: '100%', alignItems: 'center' },
  saveBtn: { padding: '10px 24px', background: '#238636', color: '#fff', border: '1px solid #2ea043', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  testBtn: { padding: '10px 20px', background: '#1f2937', color: '#e1e4e8', border: '1px solid #30363d', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'all 0.15s' },
  testResult: { fontSize: 13, margin: 0, padding: '6px 0 0', width: '100%' },
  table: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, overflow: 'hidden' },
  tableHeader: { display: 'flex', padding: '12px 16px', borderBottom: '1px solid #30363d', background: '#0d1117', fontSize: 12, fontWeight: 600, textTransform: 'uppercase' as const, color: '#8b949e', letterSpacing: 1 },
  th: { color: '#8b949e' },
  row: { display: 'flex', padding: '12px 16px', borderBottom: '1px solid #21262d', alignItems: 'center', fontSize: 14, transition: 'background 0.1s' },
  empty: { padding: 24, color: '#8b949e', textAlign: 'center' as const },
  editBtn: { background: 'transparent', border: '1px solid #30363d', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 14 },
  deleteBtn: { background: 'transparent', border: '1px solid #30363d', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 14 },
};
