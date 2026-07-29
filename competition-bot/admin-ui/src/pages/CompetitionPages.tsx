import React, { useEffect, useState } from 'react';
import { pagesApi, scanApi, type CompetitionPage } from '../api.js';

export default function CompetitionPagesPage() {
  const [pages, setPages] = useState<CompetitionPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', url: '', enabled: true });
  const [scanning, setScanning] = useState<number | null>(null);

  const load = () => pagesApi.list().then(setPages).catch(console.error).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const handleSubmit = async () => {
    try {
      await pagesApi.create({ ...form, enabled: form.enabled ? 1 : 0 });
      setShowForm(false);
      setForm({ name: '', url: '', enabled: true });
      load();
    } catch (err) { alert(err); }
  };

  const handleToggle = async (p: CompetitionPage) => {
    await pagesApi.update(p.id, { enabled: p.enabled ? 0 : 1 });
    load();
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this page and all its competitions?')) return;
    await pagesApi.delete(id);
    load();
  };

  const handleScan = async (id: number) => {
    setScanning(id);
    try {
      await scanApi.page(id);
      load();
    } catch (err) { alert(err); }
    setScanning(null);
  };

  if (loading) return <div style={styles.loading}>Loading...</div>;

  return (
    <div>
      <div style={styles.headerRow}>
        <h1 style={styles.header}>Competition Pages</h1>
        <button onClick={() => setShowForm(!showForm)} style={styles.addBtn}>
          {showForm ? '✕ Cancel' : '+ Add Page'}
        </button>
      </div>

      {showForm && (
        <div style={styles.form}>
          <input placeholder="Name (e.g. Prize Finder)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={styles.input} />
          <input placeholder="URL (e.g. https://www.theprizefinder.com/top-prizes)" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} style={styles.input} />
          <button onClick={handleSubmit} style={styles.saveBtn}>Add Page</button>
        </div>
      )}

      <div style={styles.table}>
        <div style={styles.tableHeader}>
          <span style={{ ...styles.th, flex: 2 }}>Name</span>
          <span style={{ ...styles.th, flex: 3 }}>URL</span>
          <span style={{ ...styles.th, flex: 0.5 }}>Status</span>
          <span style={{ ...styles.th, flex: 1 }}>Actions</span>
        </div>
        {pages.length === 0 && <p style={styles.empty}>No competition pages configured yet.</p>}
        {pages.map((p) => (
          <div key={p.id} style={styles.row}>
            <span style={{ flex: 2, fontWeight: 600 }}>{p.name}</span>
            <span style={{ flex: 3, color: '#58a6ff', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.url}</span>
            <span style={{ flex: 0.5 }}>
              <span style={{ ...styles.badge, background: p.enabled ? '#238636' : '#21262d', color: p.enabled ? '#fff' : '#8b949e' }}>
                {p.enabled ? 'ON' : 'OFF'}
              </span>
            </span>
            <span style={{ flex: 1, display: 'flex', gap: 8 }}>
              <button onClick={() => handleToggle(p)} style={styles.actionBtn}>
                {p.enabled ? '⏸️' : '▶️'}
              </button>
              <button onClick={() => handleScan(p.id)} disabled={scanning === p.id} style={styles.actionBtn}>
                {scanning === p.id ? '⏳' : '🔍'}
              </button>
              <button onClick={() => handleDelete(p.id)} style={styles.actionBtn}>🗑️</button>
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
  form: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 20, marginBottom: 24, display: 'flex', gap: 12, alignItems: 'flex-end' },
  input: { padding: '10px 14px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, color: '#e1e4e8', fontSize: 14, flex: 1 },
  saveBtn: { padding: '10px 24px', background: '#238636', color: '#fff', border: '1px solid #2ea043', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const },
  table: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, overflow: 'hidden' },
  tableHeader: { display: 'flex', padding: '12px 16px', borderBottom: '1px solid #30363d', background: '#0d1117', fontSize: 12, fontWeight: 600, textTransform: 'uppercase' as const, color: '#8b949e', letterSpacing: 1 },
  th: { color: '#8b949e' },
  row: { display: 'flex', padding: '12px 16px', borderBottom: '1px solid #21262d', alignItems: 'center', fontSize: 14 },
  empty: { padding: 24, color: '#8b949e', textAlign: 'center' as const },
  badge: { padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600 },
  actionBtn: { background: 'transparent', border: '1px solid #30363d', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 14 },
};
