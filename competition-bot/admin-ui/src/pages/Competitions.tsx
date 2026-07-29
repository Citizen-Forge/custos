import React, { useEffect, useState } from 'react';
import { competitionsApi, providersApi, enterApi, type Competition, type LlmProvider } from '../api.js';

const statuses = ['all', 'found', 'entered', 'failed', 'excluded', 'skipped'] as const;

export default function CompetitionsPage() {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [entering, setEntering] = useState<number | null>(null);
  const [message, setMessage] = useState('');

  const load = async (status?: string) => {
    setLoading(true);
    try {
      const [comps, provs] = await Promise.all([
        competitionsApi.list(status === 'all' ? undefined : status),
        providersApi.list(),
      ]);
      setCompetitions(comps);
      setProviders(provs);
    } catch (err) { console.error(err); }
    setLoading(false);
  };

  useEffect(() => { load(filter); }, [filter]);

  const handleEnter = async (id: number) => {
    if (providers.length === 0) { setMessage('No LLM provider configured'); return; }
    setEntering(id);
    setMessage('');
    try {
      const result = await enterApi.competition(id, providers[0].id);
      setMessage(`${result.success ? '✅' : '❌'} ${result.message}`);
      load(filter);
    } catch (err) { setMessage(`Error: ${err}`); }
    setEntering(null);
  };

  const handleReset = async (id: number) => {
    await competitionsApi.reset(id);
    load(filter);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this competition?')) return;
    await competitionsApi.delete(id);
    load(filter);
  };

  const statusColors: Record<string, string> = {
    found: '#d29922', entered: '#3fb950', failed: '#f85149',
    excluded: '#8b949e', skipped: '#8b949e',
  };

  return (
    <div>
      <div style={styles.headerRow}>
        <h1 style={styles.header}>Competitions</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={async () => {
              if (!confirm('Delete all competitions with status "found"?')) return;
              await competitionsApi.deleteAll('found');
              load(filter);
            }}
            style={styles.dangerBtn}
            title="Delete all pending competitions"
          >
            🗑️ Clear Pending
          </button>
          <button
            onClick={async () => {
              if (!confirm('Delete ALL competitions? This cannot be undone.')) return;
              await competitionsApi.deleteAll();
              load(filter);
            }}
            style={styles.dangerBtn}
            title="Delete all competitions"
          >
            🗑️ Clear All
          </button>
          <button onClick={() => load(filter)} style={styles.refreshBtn}>🔄 Refresh</button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div style={styles.filters}>
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            style={{ ...styles.filterBtn, ...(filter === s ? styles.filterBtnActive : {}) }}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {message && <p style={styles.message}>{message}</p>}

      {loading ? (
        <div style={styles.loading}>Loading...</div>
      ) : (
        <div style={styles.table}>
          <div style={styles.tableHeader}>
            <span style={{ ...styles.th, flex: 3 }}>Title</span>
            <span style={{ ...styles.th, flex: 1 }}>Status</span>
            <span style={{ ...styles.th, flex: 0.5 }}>Q?</span>
            <span style={{ ...styles.th, flex: 2 }}>Source</span>
            <span style={{ ...styles.th, flex: 1 }}>Actions</span>
          </div>
          {competitions.length === 0 && <p style={styles.empty}>No competitions found.</p>}
          {competitions.map((c) => (
            <div key={c.id} style={styles.row}>
              <span style={{ flex: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                <a href={c.url} target="_blank" rel="noopener noreferrer" style={styles.link}>{c.title}</a>
              </span>
              <span style={{ flex: 1 }}>
                <span style={{ ...styles.badge, background: statusColors[c.status] + '22', color: statusColors[c.status], border: `1px solid ${statusColors[c.status]}` }}>
                  {c.status}
                </span>
              </span>
              <span style={{ flex: 0.5, color: c.requires_questions ? '#d29922' : '#8b949e' }}>
                {c.requires_questions ? '✅' : '—'}
              </span>
              <span style={{ flex: 2, color: '#8b949e', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.source_page_url}</span>
              <span style={{ flex: 1, display: 'flex', gap: 6 }}>
                {(c.status === 'found' || c.status === 'failed') && (
                  <button onClick={() => handleEnter(c.id)} disabled={entering === c.id} style={styles.actionBtn} title="Enter now">
                    {entering === c.id ? '⏳' : '🎯'}
                  </button>
                )}
                {c.status !== 'found' && (
                  <button onClick={() => handleReset(c.id)} style={styles.actionBtn} title="Reset to pending">↺</button>
                )}
                <button onClick={() => handleDelete(c.id)} style={styles.actionBtn} title="Delete">🗑️</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loading: { padding: 40, fontSize: 18, color: '#8b949e' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  header: { fontSize: 28, fontWeight: 700, margin: 0, color: '#f0f6fc' },
  refreshBtn: { padding: '8px 16px', background: '#21262d', color: '#e1e4e8', border: '1px solid #30363d', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  filters: { display: 'flex', gap: 8, marginBottom: 20 },
  filterBtn: { padding: '6px 16px', background: 'transparent', color: '#8b949e', border: '1px solid #30363d', borderRadius: 20, fontSize: 13, cursor: 'pointer', transition: 'all 0.15s' },
  filterBtnActive: { background: '#1f2937', color: '#f0f6fc', borderColor: '#58a6ff' },
  message: { padding: '8px 16px', background: '#161b22', border: '1px solid #30363d', borderRadius: 8, color: '#58a6ff', fontSize: 14, marginBottom: 16 },
  table: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, overflow: 'hidden' },
  tableHeader: { display: 'flex', padding: '12px 16px', borderBottom: '1px solid #30363d', background: '#0d1117', fontSize: 12, fontWeight: 600, textTransform: 'uppercase' as const, color: '#8b949e', letterSpacing: 1 },
  th: { color: '#8b949e' },
  row: { display: 'flex', padding: '12px 16px', borderBottom: '1px solid #21262d', alignItems: 'center', fontSize: 14 },
  empty: { padding: 24, color: '#8b949e', textAlign: 'center' as const },
  link: { color: '#58a6ff', textDecoration: 'none' },
  badge: { padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const },
  actionBtn: { background: 'transparent', border: '1px solid #30363d', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 14 },
  dangerBtn: { padding: '8px 14px', background: '#21262d', color: '#f85149', border: '1px solid #f85149', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
};
