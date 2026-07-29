import React, { useState, useEffect } from 'react';
import { Routes, Route, NavLink, useNavigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard.js';
import ProvidersPage from './pages/Providers.js';
import CompetitionPagesPage from './pages/CompetitionPages.js';
import CompetitionsPage from './pages/Competitions.js';
import EntriesPage from './pages/Entries.js';
import SettingsPage from './pages/Settings.js';
import ProfileFieldsPage from './pages/ProfileFields.js';
import VpnSettingsPage from './pages/VpnSettings.js';

type Tab = 'dashboard' | 'providers' | 'pages' | 'competitions' | 'entries' | 'profile-fields' | 'vpn' | 'settings';

const tabs: { key: Tab; label: string; icon: string }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: '📊' },
  { key: 'providers', label: 'LLM Providers', icon: '🧠' },
  { key: 'pages', label: 'Competition Pages', icon: '📄' },
  { key: 'competitions', label: 'Competitions', icon: '🏆' },
  { key: 'entries', label: 'Entry History', icon: '📝' },
  { key: 'profile-fields', label: 'Profile Fields', icon: '👤' },
  { key: 'vpn', label: 'VPN', icon: '🔐' },
  { key: 'settings', label: 'Settings', icon: '⚙️' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const navigate = useNavigate();

  useEffect(() => {
    navigate(activeTab === 'dashboard' ? '/' : `/${activeTab}`);
  }, [activeTab, navigate]);

  return (
    <div style={styles.layout}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>
          <span style={styles.logoIcon}>🏆</span>
          <span style={styles.logoText}>CompBot</span>
        </div>
        <nav style={styles.nav}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                ...styles.navItem,
                ...(activeTab === tab.key ? styles.navItemActive : {}),
              }}
            >
              <span style={styles.navIcon}>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main style={styles.main}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/pages" element={<CompetitionPagesPage />} />
          <Route path="/competitions" element={<CompetitionsPage />} />
          <Route path="/entries" element={<EntriesPage />} />
          <Route path="/profile-fields" element={<ProfileFieldsPage />} />
          <Route path="/vpn" element={<VpnSettingsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  layout: {
    display: 'flex',
    height: '100vh',
    background: '#0f1117',
    color: '#e1e4e8',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  sidebar: {
    width: 240,
    background: '#161b22',
    borderRight: '1px solid #30363d',
    display: 'flex',
    flexDirection: 'column',
    padding: '20px 0',
    flexShrink: 0,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 20px 20px',
    borderBottom: '1px solid #30363d',
    marginBottom: 16,
  },
  logoIcon: { fontSize: 28 },
  logoText: { fontSize: 20, fontWeight: 700, color: '#f0f6fc' },
  nav: { display: 'flex', flexDirection: 'column', gap: 4, padding: '0 8px' },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    border: 'none',
    background: 'transparent',
    color: '#8b949e',
    fontSize: 14,
    cursor: 'pointer',
    borderRadius: 8,
    textAlign: 'left',
    transition: 'all 0.15s ease',
  },
  navItemActive: {
    background: '#1f2937',
    color: '#f0f6fc',
    fontWeight: 600,
  },
  main: {
    flex: 1,
    overflow: 'auto',
    padding: '24px 32px',
  },
};
