import React, { useEffect, useState } from 'react';
import { entriesApi, type Entry } from '../api.js';

export default function EntriesPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; label: string } | null>(null);

  useEffect(() => {
    entriesApi.list(200)
      .then(setEntries)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={styles.loading}>Loading...</div>;

  return (
    <div>
      <div style={styles.headerRow}>
        <h1 style={styles.header}>Entry History</h1>
        <span style={styles.count}>{entries.length} entries</span>
      </div>

      <div style={styles.table}>
        <div style={styles.tableHeader}>
          <span style={{ ...styles.th, flex: 3 }}>Competition</span>
          <span style={{ ...styles.th, flex: 0.5 }}>Status</span>
          <span style={{ ...styles.th, flex: 1 }}>Error</span>
          <span style={{ ...styles.th, flex: 0.5 }}>Screenshots</span>
          <span style={{ ...styles.th, flex: 0.8 }}>Date</span>
        </div>
        {entries.length === 0 && <p style={styles.empty}>No entries recorded yet.</p>}
        {entries.map((e) => (
          <React.Fragment key={e.id}>
            <div
              style={styles.row}
              onClick={() => setExpanded(expanded === e.id ? null : e.id)}
            >
              <span style={{ flex: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {e.competition_title || `#${e.competition_id}`}
              </span>
              <span style={{ flex: 0.5 }}>
                <span style={{ color: e.status === 'success' ? '#3fb950' : '#f85149', fontSize: 16 }}>
                  {e.status === 'success' ? '✅' : '❌'}
                </span>
              </span>
              <span style={{ flex: 1, color: '#8b949e', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {e.error_message || '—'}
              </span>
              <span style={{ flex: 0.5, fontSize: 13 }}>
                {e.screenshot_before || e.screenshot_after ? (
                  <span style={styles.hasScreenshots}>📸</span>
                ) : (
                  <span style={{ color: '#30363d' }}>—</span>
                )}
              </span>
              <span style={{ flex: 0.8, color: '#8b949e', fontSize: 13 }}>
                {new Date(e.created_at + 'Z').toLocaleDateString()}
              </span>
            </div>

            {/* Expanded details */}
            {expanded === e.id && (
              <div style={styles.expanded}>
                {e.error_message && (
                  <p style={{ margin: '0 0 12px', color: '#f85149', fontSize: 13 }}>
                    <strong>Error:</strong> {e.error_message}
                  </p>
                )}

                {/* Screenshot previews */}
                {(e.screenshot_before || e.screenshot_after) && (
                  <div style={styles.screenshotRow}>
                    {e.screenshot_before && (
                      <div
                        style={styles.thumbWrap}
                        onClick={() => setLightbox({ src: e.screenshot_before, label: 'Before submission' })}
                      >
                        <img src={e.screenshot_before} alt="Before submit" style={styles.thumb} />
                        <span style={styles.thumbLabel}>📋 Before submit</span>
                      </div>
                    )}
                    {e.screenshot_after && (
                      <div
                        style={styles.thumbWrap}
                        onClick={() => setLightbox({ src: e.screenshot_after, label: 'After submission' })}
                      >
                        <img src={e.screenshot_after} alt="After submit" style={styles.thumb} />
                        <span style={styles.thumbLabel}>📬 After submit</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* ── Lightbox ─────────────────────────────────────────────── */}
      {lightbox && (
        <div style={styles.overlay} onClick={() => setLightbox(null)}>
          <div style={styles.lightboxContent} onClick={(evt) => evt.stopPropagation()}>
            <button style={styles.lightboxClose} onClick={() => setLightbox(null)}>✕</button>
            <p style={styles.lightboxLabel}>{lightbox.label}</p>
            <img src={lightbox.src} alt={lightbox.label} style={styles.lightboxImg} />
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loading: { padding: 40, fontSize: 18, color: '#8b949e' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  header: { fontSize: 28, fontWeight: 700, margin: 0, color: '#f0f6fc' },
  count: { color: '#8b949e', fontSize: 14 },
  table: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, overflow: 'hidden' },
  tableHeader: { display: 'flex', padding: '12px 16px', borderBottom: '1px solid #30363d', background: '#0d1117', fontSize: 12, fontWeight: 600, textTransform: 'uppercase' as const, color: '#8b949e', letterSpacing: 1 },
  th: { color: '#8b949e' },
  row: { display: 'flex', padding: '12px 16px', borderBottom: '1px solid #21262d', alignItems: 'center', fontSize: 14, cursor: 'pointer', transition: 'background 0.1s' },
  empty: { padding: 24, color: '#8b949e', textAlign: 'center' as const },
  hasScreenshots: { cursor: 'pointer', fontSize: 16 },
  expanded: { padding: '12px 16px 16px 40px', background: '#0d1117', borderBottom: '1px solid #21262d' },
  screenshotRow: { display: 'flex', gap: 16, flexWrap: 'wrap' as const },
  thumbWrap: {
    cursor: 'pointer',
    border: '1px solid #30363d',
    borderRadius: 8,
    overflow: 'hidden',
    background: '#161b22',
    transition: 'border-color 0.15s',
    width: 200,
  },
  thumb: { width: '100%', height: 140, objectFit: 'cover' as const, display: 'block' },
  thumbLabel: { display: 'block', padding: '6px 10px', fontSize: 12, color: '#8b949e', textAlign: 'center' as const },

  // Lightbox
  overlay: {
    position: 'fixed' as const, inset: 0, zIndex: 1000,
    background: 'rgba(0,0,0,0.85)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 40,
  },
  lightboxContent: {
    position: 'relative' as const,
    maxWidth: '90vw', maxHeight: '90vh',
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
  },
  lightboxClose: {
    position: 'absolute' as const, top: -36, right: 0,
    background: 'transparent', border: 'none', color: '#e1e4e8',
    fontSize: 24, cursor: 'pointer', padding: '4px 8px',
  },
  lightboxLabel: { color: '#e1e4e8', fontSize: 14, margin: '0 0 8px', alignSelf: 'flex-start' as const },
  lightboxImg: {
    maxWidth: '90vw', maxHeight: '85vh',
    borderRadius: 8, border: '1px solid #30363d',
    objectFit: 'contain' as const,
  },
};
