import React, { useState, useEffect } from 'react';
import { vpnApi, type VpnConfig } from '../api.js';

export default function VpnSettings() {
  const [status, setStatus] = useState<{
    available: boolean;
    connected: boolean;
    configId: number | null;
    configLabel: string | null;
    serverIp: string | null;
    configCount: number;
  } | null>(null);
  const [configs, setConfigs] = useState<VpnConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [operating, setOperating] = useState(false);

  // Add config form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newContent, setNewContent] = useState('');
  const [addError, setAddError] = useState('');

  const loadData = async () => {
    try {
      setLoading(true);
      const [s, c] = await Promise.all([vpnApi.status(), vpnApi.configs()]);
      setStatus(s);
      setConfigs(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleConnect = async (configId: number) => {
    setOperating(true);
    setError('');
    try {
      await vpnApi.connect(configId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperating(false);
    }
  };

  const handleConnectRandom = async () => {
    setOperating(true);
    setError('');
    try {
      await vpnApi.connectRandom();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperating(false);
    }
  };

  const handleRotate = async () => {
    setOperating(true);
    setError('');
    try {
      await vpnApi.rotate();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperating(false);
    }
  };

  const handleDisconnect = async () => {
    setOperating(true);
    setError('');
    try {
      await vpnApi.disconnect();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperating(false);
    }
  };

  const handleAddConfig = async () => {
    if (!newLabel.trim() || !newContent.trim()) {
      setAddError('Label and config content are required');
      return;
    }
    setOperating(true);
    setAddError('');
    try {
      await vpnApi.addConfig(newLabel.trim(), newContent.trim());
      setShowAddForm(false);
      setNewLabel('');
      setNewContent('');
      await loadData();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperating(false);
    }
  };

  const handleDeleteConfig = async (id: number) => {
    if (!confirm('Delete this VPN config?')) return;
    setOperating(true);
    try {
      await vpnApi.deleteConfig(id);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperating(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 32, color: '#8b949e' }}>
        <p>Loading VPN settings...</p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <span style={{ fontSize: 28 }}>🔐</span>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#f0f6fc' }}>VPN Settings</h1>
      </div>

      {!status?.available && (
        <div style={{
          background: '#2d1b1b', border: '1px solid #f8514966', borderRadius: 8,
          padding: 16, marginBottom: 24, color: '#f85149',
        }}>
          <strong>⚠️ WireGuard not available.</strong>
          <p style={{ margin: '8px 0 0', fontSize: 13, color: '#8b949e' }}>
            The container needs <code>--cap-add=NET_ADMIN</code> to use WireGuard. Rebuild with VPN
            support enabled, or add the capability to the existing container.
          </p>
        </div>
      )}

      {/* Status card */}
      <div style={styles.card}>
        <h2 style={styles.cardTitle}>Connection Status</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px 16px', fontSize: 14 }}>
          <span style={styles.label}>Status:</span>
          <span>
            {status?.connected
              ? <span style={{ color: '#3fb950', fontWeight: 600 }}>🟢 Connected</span>
              : <span style={{ color: '#8b949e' }}>⚪ Disconnected</span>
            }
          </span>

          {status?.connected && (
            <>
              <span style={styles.label}>Server:</span>
              <span style={{ color: '#e1e4e8' }}>{status.configLabel || 'Unknown'}</span>

              {status.serverIp && (
                <>
                  <span style={styles.label}>IP:</span>
                  <span style={{ color: '#e1e4e8', fontFamily: 'monospace' }}>{status.serverIp}</span>
                </>
              )}
            </>
          )}

          <span style={styles.label}>Configs:</span>
          <span style={{ color: '#e1e4e8' }}>{configs.length} saved</span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          {status?.available && (
            <>
              {configs.length > 0 && (
                <>
                  {!status?.connected && (
                    <button onClick={handleConnectRandom} disabled={operating}
                      style={{ ...styles.btn, ...styles.btnPrimary }}>
                      🔀 Connect Random
                    </button>
                  )}
                  {status?.connected && (
                    <>
                      <button onClick={handleRotate} disabled={operating}
                        style={{ ...styles.btn, ...styles.btnSecondary }}>
                        🔄 Rotate VPN
                      </button>
                      <button onClick={handleDisconnect} disabled={operating}
                        style={{ ...styles.btn, ...styles.btnDanger }}>
                        ⚡ Disconnect
                      </button>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Configs list */}
      <div style={styles.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ ...styles.cardTitle, margin: 0 }}>WireGuard Configs</h2>
          <button onClick={() => setShowAddForm(!showAddForm)}
            style={{ ...styles.btn, ...styles.btnPrimary }}>
            {showAddForm ? '✕ Cancel' : '+ Add Config'}
          </button>
        </div>

        {/* Add config form */}
        {showAddForm && (
          <div style={{ background: '#161b22', borderRadius: 8, padding: 16, marginBottom: 16, border: '1px solid #30363d' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14, color: '#f0f6fc' }}>Add WireGuard Config</h3>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', marginBottom: 4, color: '#8b949e', fontSize: 13 }}>Label</label>
              <input
                placeholder="e.g. Netherlands #1, US Free, Japan..."
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                style={styles.input}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', marginBottom: 4, color: '#8b949e', fontSize: 13 }}>
                Paste WireGuard config content
              </label>
              <textarea
                placeholder={`[Interface]\nPrivateKey = ...\nAddress = ...\nDNS = ...\n\n[Peer]\nPublicKey = ...\nEndpoint = ...\nAllowedIPs = 0.0.0.0/0`}
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                rows={10}
                style={{ ...styles.input, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
              />
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#8b949e' }}>
                Download from{' '}
                <a href="https://account.protonvpn.com/downloads#wireguard-configuration"
                  target="_blank" rel="noopener noreferrer"
                  style={{ color: '#58a6ff' }}>
                  Proton VPN Downloads
                </a>
                {' '}→ WireGuard configuration. Pick servers from different countries.
              </p>
            </div>

            {addError && <p style={{ color: '#f85149', fontSize: 13, margin: '0 0 8px' }}>{addError}</p>}

            <button onClick={handleAddConfig} disabled={operating}
              style={{ ...styles.btn, ...styles.btnSuccess }}>
              {operating ? 'Saving...' : 'Save Config'}
            </button>
          </div>
        )}

        {/* Config list */}
        {configs.length === 0 ? (
          <p style={{ color: '#8b949e', fontSize: 14 }}>
            No WireGuard configs yet. Download configs from Proton VPN and add them above.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {configs.map((cfg) => (
              <div key={cfg.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: '#161b22', borderRadius: 8, padding: '12px 16px',
                border: status?.configId === cfg.id ? '1px solid #3fb95066' : '1px solid #30363d',
              }}>
                <div>
                  <div style={{ fontWeight: 600, color: '#f0f6fc', fontSize: 14 }}>
                    {cfg.label}
                    {status?.configId === cfg.id && (
                      <span style={{ color: '#3fb950', fontSize: 12, marginLeft: 8 }}>● Active</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#8b949e', marginTop: 4 }}>
                    {cfg.country} · {cfg.filename}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {status?.available && (
                    <button
                      onClick={() => handleConnect(cfg.id)}
                      disabled={operating || status?.configId === cfg.id}
                      style={{ ...styles.btnSm, ...styles.btnPrimary }}>
                      {status?.configId === cfg.id ? 'Connected' : 'Connect'}
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteConfig(cfg.id)}
                    disabled={operating}
                    style={{ ...styles.btnSm, ...styles.btnDanger }}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* How to get configs */}
      <div style={styles.card}>
        <h2 style={styles.cardTitle}>How to get WireGuard configs from Proton VPN</h2>
        <ol style={{ color: '#8b949e', fontSize: 13, lineHeight: 1.7, margin: 0, paddingLeft: 20 }}>
          <li>Go to <a href="https://account.protonvpn.com/downloads#wireguard-configuration"
            target="_blank" rel="noopener noreferrer" style={{ color: '#58a6ff' }}>
            Proton VPN Downloads</a></li>
          <li>Click <strong>"WireGuard configuration"</strong> — pick servers from different countries for IP variety</li>
          <li>Download 3-5 configs from different countries</li>
          <li>Open each <code>.conf</code> file and paste the content above with a descriptive label (e.g. "Netherlands #1", "US Free", "Japan")</li>
          <li>Once saved, click <strong>"Connect Random"</strong> — the bot will pick one at random</li>
          <li>Enable <strong>"VPN Auto-Connect"</strong> in Settings to automatically connect before scans/entries</li>
        </ol>
        <div style={{ marginTop: 12, padding: 12, background: '#1f2937', borderRadius: 6, fontSize: 13, color: '#8b949e' }}>
          <strong style={{ color: '#f0f6fc' }}>Free tier?</strong> Proton VPN Free gives you servers in
          {' '}<strong>US, Netherlands, and Japan</strong> — that's 3 different IPs to rotate through.
          Enough for basic Cloudflare avoidance. Paid gives you 70+ countries.
        </div>
      </div>

      {error && (
        <div style={{
          marginTop: 16, padding: 12, background: '#2d1b1b',
          border: '1px solid #f8514966', borderRadius: 8, color: '#f85149', fontSize: 13,
        }}>
          {error}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 8,
    padding: 20,
    marginBottom: 16,
  },
  cardTitle: {
    margin: '0 0 16px',
    fontSize: 16,
    fontWeight: 600,
    color: '#f0f6fc',
  },
  label: {
    color: '#8b949e',
    fontWeight: 500,
  },
  input: {
    width: '100%',
    padding: '8px 12px',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 6,
    color: '#e1e4e8',
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  btn: {
    padding: '8px 16px',
    borderRadius: 6,
    border: 'none',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  btnSm: {
    padding: '5px 12px',
    borderRadius: 6,
    border: 'none',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  btnPrimary: {
    background: '#1f6feb',
    color: '#fff',
  },
  btnSecondary: {
    background: '#1f2937',
    color: '#e1e4e8',
    border: '1px solid #30363d',
  },
  btnSuccess: {
    background: '#238636',
    color: '#fff',
  },
  btnDanger: {
    background: '#21262d',
    color: '#f85149',
    border: '1px solid #f8514966',
  },
};
