import React, { useEffect, useState, useRef } from 'react';
import { statsApi, providersApi, scanApi, enterApi, testBrowserApi, type Stats, type BrowserTestResult } from '../api.js';

type Provider = { id: number; name: string; model: string };

interface ActivityEvent {
  type: string;
  message: string;
  timestamp: string;
}

const STATUS_COLORS: Record<string, string> = {
  pass: '#3fb950',
  warn: '#d29922',
  fail: '#f85149',
};

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [entering, setEntering] = useState(false);
  const [message, setMessage] = useState('');
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const maxItems = 200;

  // Browser test state
  const [testingBrowser, setTestingBrowser] = useState(false);
  const [browserResult, setBrowserResult] = useState<BrowserTestResult | null>(null);
  const [browserTestError, setBrowserTestError] = useState('');

  // ── Initial data load ────────────────────────────────────
  useEffect(() => {
    Promise.all([statsApi.get(), providersApi.list()])
      .then(([s, p]) => {
        setStats(s);
        setProviders(p);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // ── SSE connection to live activity feed ─────────────────
  useEffect(() => {
    const evtSource = new EventSource('/api/events');

    evtSource.onmessage = (evt) => {
      try {
        const event: ActivityEvent = JSON.parse(evt.data);
        setActivity((prev) => {
          const next = [...prev, event];
          return next.length > maxItems
            ? next.slice(next.length - maxItems)
            : next;
        });
      } catch { /* ignore parse errors */ }
    };

    evtSource.onerror = () => {
      // Reconnection is automatic with EventSource
    };

    return () => evtSource.close();
  }, []);

  // Auto-scroll feed to bottom when new events arrive
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [activity]);

  const handleScanAll = async () => {
    setScanning(true);
    setMessage('');
    try {
      const result = await scanApi.all();
      setMessage(`Scanned ${result.length} pages`);
      const s = await statsApi.get();
      setStats(s);
    } catch (err) {
      setMessage(`Error: ${err}`);
    }
    setScanning(false);
  };

  const handleEnterBatch = async () => {
    if (providers.length === 0) {
      setMessage('No LLM provider configured');
      return;
    }
    setEntering(true);
    setMessage('');
    try {
      const result = await enterApi.batch(providers[0].id);
      const success = result.filter((r) => r.success).length;
      const failed = result.filter((r) => !r.success).length;
      setMessage(`Entered: ${success} success, ${failed} failed`);
      const s = await statsApi.get();
      setStats(s);
    } catch (err) {
      setMessage(`Error: ${err}`);
    }
    setEntering(false);
  };

  const handleTestBrowser = async () => {
    setTestingBrowser(true);
    setBrowserResult(null);
    setBrowserTestError('');
    try {
      const result = await testBrowserApi.run();
      setBrowserResult(result);
    } catch (err) {
      setBrowserTestError(String(err));
    }
    setTestingBrowser(false);
  };

  if (loading) return <div style={styles.loading}>Loading dashboard...</div>;

  const cards = [
    { label: 'Total Competitions', value: stats?.total ?? 0, color: '#58a6ff' },
    { label: 'Pending Entry', value: stats?.pending ?? 0, color: '#d29922' },
    { label: 'Entered', value: stats?.entered ?? 0, color: '#3fb950' },
    { label: 'Failed', value: stats?.failed ?? 0, color: '#f85149' },
    { label: 'Excluded', value: stats?.excluded ?? 0, color: '#8b949e' },
  ];

  return (
    <div style={styles.layout}>
      {/* Left column: stats + actions */}
      <div style={styles.leftCol}>
        <h1 style={styles.header}>Dashboard</h1>
        <p style={styles.subtitle}>
          {stats?.providers} provider{stats?.providers !== 1 ? 's' : ''} · {stats?.pages} page{stats?.pages !== 1 ? 's' : ''}
        </p>

        {/* Stats Grid */}
        <div style={styles.grid}>
          {cards.map((card) => (
            <div key={card.label} style={styles.card}>
              <span style={{ ...styles.cardValue, color: card.color }}>{card.value}</span>
              <span style={styles.cardLabel}>{card.label}</span>
            </div>
          ))}
        </div>

        {/* Quick Actions */}
        <h2 style={styles.sectionHeader}>Quick Actions</h2>
        <div style={styles.actions}>
          <button onClick={handleScanAll} disabled={scanning} style={styles.actionBtn}>
            {scanning ? '⏳ Scanning...' : '🔍 Scan All Pages'}
          </button>
          <button onClick={handleEnterBatch} disabled={entering || providers.length === 0} style={styles.actionBtn}>
            {entering ? '⏳ Entering...' : '🎯 Enter Pending Competitions'}
          </button>
          <button onClick={handleTestBrowser} disabled={testingBrowser} style={{ ...styles.actionBtn, background: '#1f6feb', borderColor: '#388bfd' }}>
            {testingBrowser ? '⏳ Testing...' : '🕵️ Test Browser'}
          </button>
        </div>

        {message && <p style={styles.message}>{message}</p>}

        {/* Browser Test Results */}
        {browserTestError && (
          <div style={styles.testError}>
            ❌ {browserTestError}
          </div>
        )}
        {browserResult && (
          <div style={styles.testPanel}>
            {/* Real Page Test — the most directly useful answer */}
            {browserResult.realPageTest && browserResult.realPageTest.attempted && (
              <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 8, background: '#0d1117', border: '1px solid #30363d' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#8b949e', marginBottom: 6 }}>🌐 Real Page Load Test</div>
                <div style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
                  <span style={{ color: '#e1e4e8', maxWidth: 350, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                    {browserResult.realPageTest.url}
                  </span>
                  {browserResult.realPageTest.error ? (
                    <span style={{ color: '#f85149' }}>
                      🚨 Error: {browserResult.realPageTest.error}
                    </span>
                  ) : (
                    <>
                      <span style={{
                        padding: '2px 10px',
                        borderRadius: 10,
                        fontSize: 12,
                        fontWeight: 700,
                        background: browserResult.realPageTest.status >= 200 && browserResult.realPageTest.status < 400 ? '#3fb95022' : '#f8514922',
                        color: browserResult.realPageTest.status >= 200 && browserResult.realPageTest.status < 400 ? '#3fb950' : '#f85149',
                        border: '1px solid ' + (browserResult.realPageTest.status >= 200 && browserResult.realPageTest.status < 400 ? '#3fb95044' : '#f8514944'),
                      }}>
                        HTTP {browserResult.realPageTest.status}
                      </span>
                      <span style={{ color: '#8b949e', fontSize: 12 }}>
                        {browserResult.realPageTest.bodyLength.toLocaleString()} bytes
                      </span>
                      {browserResult.realPageTest.status === 429 && (
                        <span style={{ color: '#f85149', fontSize: 13 }}>🚨 Cloudflare/WAF block</span>
                      )}
                      {browserResult.realPageTest.status === 403 && (
                        <span style={{ color: '#d29922', fontSize: 13 }}>⚠️ Access forbidden</span>
                      )}
                      {browserResult.realPageTest.status >= 200 && browserResult.realPageTest.status < 300 && (
                        <span style={{ color: '#3fb950', fontSize: 13 }}>✅ Page loaded successfully</span>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            <div style={styles.testHeader}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>
                Grade: <span style={{
                  color: browserResult.grade === 'A' ? '#3fb950' :
                         browserResult.grade === 'B' ? '#58a6ff' : '#d29922',
                }}>{browserResult.grade}</span>
              </span>
              <span style={{ color: '#8b949e', fontSize: 13 }}>
                {browserResult.score}% · {browserResult.summary}
              </span>
              <span style={{ color: '#484f58', fontSize: 12 }}>Firefox</span>
            </div>
            <div style={styles.signalGrid}>
              {Object.entries(browserResult.signals).map(([key, signal]) => (
                <div key={key} style={styles.signalRow}>
                  <span style={styles.signalName}>{key}</span>
                  <span style={{
                    ...styles.statusBadge,
                    background: STATUS_COLORS[signal.status] + '22',
                    color: STATUS_COLORS[signal.status],
                    borderColor: STATUS_COLORS[signal.status] + '44',
                  }}>
                    {signal.status === 'pass' ? '✅' : signal.status === 'warn' ? '⚠️' : '🚨'} {signal.status}
                  </span>
                  <span style={styles.signalValue} title={signal.value}>{signal.value}</span>
                  {signal.tip && <span style={styles.signalTip}>{signal.tip}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right column: live activity feed */}
      <div style={styles.feedCol}>
        <h2 style={{ ...styles.sectionHeader, marginBottom: 12 }}>
          📡 Live Activity
          <span style={styles.feedCount}>{activity.length} events</span>
        </h2>
        <div ref={feedRef} style={styles.feed}>
          {activity.length === 0 && (
            <p style={styles.feedEmpty}>
              Waiting for activity...<br />
              <span style={{ fontSize: 12, color: '#8b949e' }}>Click a button above to start</span>
            </p>
          )}
          {activity.map((evt, i) => (
            <div key={i} style={styles.feedItem}>
              <span style={styles.feedTime}>
                {new Date(evt.timestamp).toLocaleTimeString()}
              </span>
              <span style={styles.feedMsg}>{evt.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loading: { padding: 40, fontSize: 18, color: '#8b949e' },
  layout: { display: 'flex', gap: 32, alignItems: 'flex-start' },
  leftCol: { flex: 1, minWidth: 0 },
  feedCol: { width: 380, flexShrink: 0 },
  header: { fontSize: 28, fontWeight: 700, margin: '0 0 4px', color: '#f0f6fc' },
  subtitle: { color: '#8b949e', margin: '0 0 24px', fontSize: 14 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: 12,
    marginBottom: 28,
  },
  card: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 12,
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  cardValue: { fontSize: 32, fontWeight: 700 },
  cardLabel: { fontSize: 12, color: '#8b949e', textTransform: 'uppercase' as const, letterSpacing: 1 },
  sectionHeader: {
    fontSize: 18,
    fontWeight: 600,
    margin: '0 0 16px',
    color: '#f0f6fc',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  feedCount: { fontSize: 12, fontWeight: 400, color: '#8b949e' },
  actions: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' as const },
  actionBtn: {
    padding: '10px 20px',
    background: '#238636',
    color: '#fff',
    border: '1px solid #2ea043',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  message: { color: '#58a6ff', fontSize: 14, marginTop: 12 },
  testError: {
    background: '#3d1a1a',
    border: '1px solid #f85149',
    borderRadius: 8,
    padding: '12px 16px',
    color: '#f85149',
    fontSize: 13,
    marginBottom: 16,
  },
  testPanel: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
  },
  testHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    marginBottom: 16,
    paddingBottom: 12,
    borderBottom: '1px solid #30363d',
  },
  signalGrid: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  signalRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 8px',
    borderRadius: 6,
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    flexWrap: 'wrap' as const,
  },
  signalName: {
    color: '#8b949e',
    minWidth: 110,
    fontWeight: 600,
    textTransform: 'capitalize' as const,
  },
  statusBadge: {
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 600,
    border: '1px solid',
    minWidth: 55,
    textAlign: 'center' as const,
  },
  signalValue: {
    color: '#e1e4e8',
    flex: 1,
    minWidth: 100,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  signalTip: {
    color: '#8b949e',
    fontStyle: 'italic',
    fontSize: 11,
    width: '100%',
    paddingLeft: 175,
  },
  feed: {
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 12,
    padding: 12,
    height: 420,
    overflowY: 'auto' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  feedEmpty: {
    color: '#8b949e',
    fontSize: 13,
    textAlign: 'center' as const,
    margin: 'auto',
    lineHeight: 1.6,
  },
  feedItem: {
    display: 'flex',
    gap: 8,
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    lineHeight: 1.6,
    padding: '2px 0',
  },
  feedTime: {
    color: '#484f58',
    flexShrink: 0,
    width: 70,
  },
  feedMsg: {
    color: '#e1e4e8',
    wordBreak: 'break-word' as const,
  },
};
