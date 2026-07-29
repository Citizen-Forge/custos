import React, { useEffect, useState } from 'react';
import { profileFieldsApi, type ProfileField } from '../api.js';

export default function ProfileFieldsPage() {
  const [fields, setFields] = useState<ProfileField[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ProfileField | null>(null);
  const [form, setForm] = useState({ field_key: '', field_label: '', field_value: '' });
  const [message, setMessage] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await profileFieldsApi.list();
      setFields(data);
    } catch (err) { console.error(err); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleSubmit = async () => {
    setMessage('');
    try {
      if (editing) {
        await profileFieldsApi.update(editing.id, form);
      } else {
        await profileFieldsApi.create(form);
      }
      setShowForm(false);
      setEditing(null);
      setForm({ field_key: '', field_label: '', field_value: '' });
      load();
    } catch (err) {
      setMessage(`Error: ${err}`);
    }
  };

  const handleEdit = (f: ProfileField) => {
    setEditing(f);
    setForm({ field_key: f.field_key, field_label: f.field_label, field_value: f.field_value });
    setShowForm(true);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this profile field?')) return;
    await profileFieldsApi.delete(id);
    load();
  };

  if (loading) return <div style={styles.loading}>Loading...</div>;

  return (
    <div>
      <div style={styles.headerRow}>
        <h1 style={styles.header}>Profile Fields</h1>
        <button
          onClick={() => { setShowForm(!showForm); setEditing(null); setForm({ field_key: '', field_label: '', field_value: '' }); }}
          style={styles.addBtn}
        >
          {showForm ? '✕ Cancel' : '+ Add Field'}
        </button>
      </div>

      <p style={styles.description}>
        These are the personal details the bot will use when filling in competition forms.
        The bot matches form field labels against these fields and enters the stored value.
        Leave a field blank to let the LLM generate a creative answer instead.
      </p>

      {showForm && (
        <div style={styles.form}>
          <input
            placeholder="Field key (e.g. full_name)"
            value={form.field_key}
            onChange={(e) => setForm({ ...form, field_key: e.target.value })}
            style={styles.input}
            disabled={!!editing}
          />
          <input
            placeholder="Label (e.g. Full Name)"
            value={form.field_label}
            onChange={(e) => setForm({ ...form, field_label: e.target.value })}
            style={styles.input}
          />
          <input
            placeholder="Your value (e.g. Alex Johnson)"
            value={form.field_value}
            onChange={(e) => setForm({ ...form, field_value: e.target.value })}
            style={{ ...styles.input, flex: 2 }}
          />
          {message && <p style={styles.message}>{message}</p>}
          <button onClick={handleSubmit} style={styles.saveBtn}>
            {editing ? 'Update' : 'Add'}
          </button>
        </div>
      )}

      <div style={styles.table}>
        <div style={styles.tableHeader}>
          <span style={{ ...styles.th, flex: 1 }}>Key</span>
          <span style={{ ...styles.th, flex: 1.5 }}>Label</span>
          <span style={{ ...styles.th, flex: 2 }}>Value</span>
          <span style={{ ...styles.th, flex: 0.5 }}>Actions</span>
        </div>
        {fields.length === 0 && (
          <p style={styles.empty}>No profile fields configured. Add some to help the bot fill forms accurately.</p>
        )}
        {fields.map((f) => (
          <div key={f.id} style={styles.row}>
            <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 13, color: '#58a6ff' }}>{f.field_key}</span>
            <span style={{ flex: 1.5 }}>{f.field_label}</span>
            <span style={{
              flex: 2,
              color: f.field_value ? '#e1e4e8' : '#8b949e',
              fontStyle: f.field_value ? 'normal' : 'italic',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {f.field_value || '(LLM will generate)'}
            </span>
            <span style={{ flex: 0.5, display: 'flex', gap: 8 }}>
              <button onClick={() => handleEdit(f)} style={styles.actionBtn} title="Edit">✏️</button>
              <button onClick={() => handleDelete(f.id)} style={styles.actionBtn} title="Delete">🗑️</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loading: { padding: 40, fontSize: 18, color: '#8b949e' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  header: { fontSize: 28, fontWeight: 700, margin: 0, color: '#f0f6fc' },
  description: { color: '#8b949e', fontSize: 13, margin: '0 0 20px', maxWidth: 700, lineHeight: 1.5 },
  addBtn: { padding: '10px 20px', background: '#238636', color: '#fff', border: '1px solid #2ea043', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  form: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 20, marginBottom: 24, display: 'flex', flexWrap: 'wrap' as const, gap: 12, alignItems: 'flex-end' },
  input: { padding: '10px 14px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, color: '#e1e4e8', fontSize: 14, flex: 1, minWidth: 150 },
  message: { color: '#f85149', fontSize: 13, width: '100%' },
  saveBtn: { padding: '10px 24px', background: '#238636', color: '#fff', border: '1px solid #2ea043', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const },
  table: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, overflow: 'hidden' },
  tableHeader: { display: 'flex', padding: '12px 16px', borderBottom: '1px solid #30363d', background: '#0d1117', fontSize: 12, fontWeight: 600, textTransform: 'uppercase' as const, color: '#8b949e', letterSpacing: 1 },
  th: { color: '#8b949e' },
  row: { display: 'flex', padding: '12px 16px', borderBottom: '1px solid #21262d', alignItems: 'center', fontSize: 14, transition: 'background 0.1s' },
  empty: { padding: 24, color: '#8b949e', textAlign: 'center' as const },
  actionBtn: { background: 'transparent', border: '1px solid #30363d', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 14 },
};
