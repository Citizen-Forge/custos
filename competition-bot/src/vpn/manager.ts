import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { get } from '../db/db.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const WIREGUARD_DIR = path.join(DATA_DIR, 'wireguard');
const DEFAULT_IFACE = 'wg0';

/** A saved WireGuard config file */
export interface VpnConfig {
  id: number;
  label: string;
  filename: string;
  country: string;
  created_at: string;
}

/** Current VPN status */
export interface VpnStatus {
  connected: boolean;
  configId: number | null;
  configLabel: string | null;
  serverIp: string | null;
  device: string | null;
  since: string | null;
}

/** Parsed WireGuard config sections */
interface WgInterface {
  privateKey: string;
  address: string;
  dns: string;
  mtu?: number;
}

interface WgPeer {
  publicKey: string;
  allowedIPs: string[];
  endpoint: string;
  persistentKeepalive: number;
}

// ── Async helper ──────────────────────────────────────────────────

/**
 * Run a shell command and return stdout. Rejects on non-zero exit.
 * Keeps the event loop responsive unlike execSync.
 */
function execCmd(cmd: string, timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

// ── Initialisation ──────────────────────────────────────────────────

export function initVpnStorage(): void {
  fs.mkdirSync(WIREGUARD_DIR, { recursive: true });
}

// ── Config file management ──────────────────────────────────────────

/**
 * Save a WireGuard config file to disk. Returns the config id.
 * Expects the full .conf file content as a string.
 */
export function saveConfigFile(label: string, content: string): VpnConfig {
  initVpnStorage();
  const sanitised = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${sanitised}.conf`;

  // Detect country from the config comment or first DNS
  let country = 'unknown';
  const firstLine = content.split('\n')[0] || '';
  if (firstLine.startsWith('#')) {
    country = firstLine.replace(/^#\s*/, '').trim().split(/\s+/)[0] || 'unknown';
  }

  // Check if we already have this config (same filename → update)
  const existing = get().get<{ id: number }>(
    'SELECT id FROM vpn_configs WHERE filename = ?',
    [filename],
  );

  const filePath = path.join(WIREGUARD_DIR, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o600);

  if (existing) {
    get().run(
      "UPDATE vpn_configs SET label = ?, country = ?, updated_at = datetime('now') WHERE id = ?",
      [label, country, existing.id],
    );
  } else {
    get().run(
      'INSERT INTO vpn_configs (label, filename, country) VALUES (?, ?, ?)',
      [label, filename, country],
    );
  }
  get().save();

  const row = get().get<VpnConfig>('SELECT * FROM vpn_configs WHERE filename = ?', [filename]);
  return row!;
}

/** List all stored configs */
export function listConfigs(): VpnConfig[] {
  return get().all<VpnConfig>('SELECT * FROM vpn_configs ORDER BY created_at DESC');
}

/** Delete a config file */
export async function deleteConfig(id: number): Promise<boolean> {
  const row = get().get<{ filename: string }>('SELECT filename FROM vpn_configs WHERE id = ?', [id]);
  if (!row) return false;

  const status = await getStatus();
  if (status.connected && status.configId === id) {
    await disconnect();
  }

  const filePath = path.join(WIREGUARD_DIR, row.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  get().run('DELETE FROM vpn_configs WHERE id = ?', [id]);
  get().save();
  return true;
}

// ── Config parsing (minimal — enough for Proton VPN configs) ────────

function parseWgConfig(content: string): { iface: WgInterface; peer: WgPeer } | null {
  const lines = content.split('\n');
  let section: 'interface' | 'peer' | null = null;
  const iface: Partial<WgInterface> = {};
  const peer: Partial<WgPeer> = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const lower = line.toLowerCase();
    if (lower === '[interface]') { section = 'interface'; continue; }
    if (lower === '[peer]') { section = 'peer'; continue; }

    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const keyLower = key.toLowerCase();

    if (section === 'interface') {
      if (keyLower === 'privatekey') iface.privateKey = value;
      else if (keyLower === 'address') iface.address = value;
      else if (keyLower === 'dns') iface.dns = value;
      else if (keyLower === 'mtu') iface.mtu = parseInt(value, 10) || undefined;
    } else if (section === 'peer') {
      if (keyLower === 'publickey') peer.publicKey = value;
      else if (keyLower === 'allowedips') peer.allowedIPs = value.split(',').map((s) => s.trim());
      else if (keyLower === 'endpoint') peer.endpoint = value;
      else if (keyLower === 'persistentkeepalive') peer.persistentKeepalive = parseInt(value, 10) || 0;
    }
  }

  if (!iface.privateKey || !peer.publicKey || !peer.endpoint) return null;

  return {
    iface: { privateKey: iface.privateKey, address: iface.address || '', dns: iface.dns || '', mtu: iface.mtu || 1420 },
    peer: { publicKey: peer.publicKey, allowedIPs: peer.allowedIPs || ['0.0.0.0/0'], endpoint: peer.endpoint, persistentKeepalive: peer.persistentKeepalive || 25 },
  };
}

// ── Connection management (raw wg + ip — no wg-quick, no iptables) ──

/**
 * Connect to a VPN server using a stored WireGuard config.
 * Uses raw `wg` + `ip` commands instead of `wg-quick` to avoid
 * iptables/sysctl/resolvconf requirements that don't work in Docker.
 */
export async function connect(configId: number): Promise<boolean> {
  const config = get().get<VpnConfig>('SELECT * FROM vpn_configs WHERE id = ?', [configId]);
  if (!config) {
    console.warn(`[VPN] Config ${configId} not found`);
    return false;
  }

  const filePath = path.join(WIREGUARD_DIR, config.filename);
  if (!fs.existsSync(filePath)) {
    console.warn(`[VPN] Config file not found: ${filePath}`);
    return false;
  }

  const status = await getStatus();
  if (status.connected && status.configId === configId) {
    console.log(`[VPN] Already connected to "${config.label}"`);
    return true;
  }

  if (status.connected) {
    await disconnect();
  }

  try {
    console.log(`[VPN] Connecting to "${config.label}" (${config.filename})...`);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseWgConfig(raw);
    if (!parsed) {
      console.error(`[VPN] Failed to parse config: ${config.filename}`);
      return false;
    }

    // 1. Strip wg-quick-only directives and create a pure WireGuard config
    const wgOnlyLines = raw.split('\n').filter((l) => {
      const lower = l.trim().toLowerCase();
      // Strip wg-quick-only directives (Proton formats as 'Key = value')
      return !lower.startsWith('address')
          && !lower.startsWith('dns')
          && !lower.startsWith('mtu')
          && !lower.startsWith('table')
          && !lower.startsWith('preup')
          && !lower.startsWith('postup')
          && !lower.startsWith('predown')
          && !lower.startsWith('postdown')
          && !lower.startsWith('saveconfig')
          && !lower.startsWith('#');
    }).join('\n');
    const wgConfigPath = path.join(WIREGUARD_DIR, `wg-${config.filename}`);
    fs.writeFileSync(wgConfigPath, wgOnlyLines, 'utf-8');

    // 2. Extract the WireGuard server endpoint IP
    //    We need this to add a specific route for it through eth0,
    //    otherwise encrypted WireGuard packets would loop through wg0.
    const endpointHost = parsed.peer.endpoint.split(':')[0];
    const endpointIsIpv6 = endpointHost.startsWith('[');
    const endpointIp = endpointIsIpv6 ? endpointHost.replace(/^\[|\]$/g, '') : endpointHost;

    // 3. Get the Docker gateway IP (the host's bridge IP)
    const gatewayOutput = await execCmd('ip route show default');
    const gatewayIp = gatewayOutput.split(' ')[2] || '172.17.0.1';

    // 4. Create the WireGuard interface
    await execCmd(`ip link add ${DEFAULT_IFACE} type wireguard`, 5_000);

    // 5. Add a route for the WireGuard server IP through eth0 (prevents routing loop)
    //    This must be done BEFORE changing the default route.
    if (!endpointIsIpv6) {
      await execCmd(`ip route add ${endpointIp}/32 via ${gatewayIp} dev eth0`, 5_000);
    } else {
      try {
        await execCmd(`ip -6 route add ${endpointIp}/128 via fe80::1 dev eth0`, 3_000);
      } catch { /* ignore */ }
    }

    // 6. Configure from the stripped WireGuard-native config
    await execCmd(`wg setconf ${DEFAULT_IFACE} "${wgConfigPath}"`, 5_000);

    // Clean up the temp stripped config
    try { fs.unlinkSync(wgConfigPath); } catch { /* ignore */ }

    // 7. Assign IP addresses (comma-separated from Address field)
    const addresses = parsed.iface.address.split(',').map((a) => a.trim()).filter(Boolean);
    for (const addr of addresses) {
      if (addr.includes(':')) {
        await execCmd(`ip -6 address add ${addr} dev ${DEFAULT_IFACE}`, 5_000);
      } else {
        await execCmd(`ip address add ${addr} dev ${DEFAULT_IFACE}`, 5_000);
      }
    }

    // 8. Set MTU and bring up
    await execCmd(`ip link set mtu ${parsed.iface.mtu} up dev ${DEFAULT_IFACE}`, 5_000);

    // 9. Replace default routes — container already has a default via eth0
    await execCmd(`ip route replace default dev ${DEFAULT_IFACE}`, 5_000);

    // 10. Add IPv6 default route too (prevent IPv6 leak)
    try {
      await execCmd(`ip -6 route replace ::/0 dev ${DEFAULT_IFACE}`, 3_000);
    } catch { /* IPv6 may not be available — not critical */ }

    // 11. Override DNS — use Proton VPN's DNS to prevent DNS leaks
    //     DNS queries must go through the VPN tunnel so Cloudflare sees the VPN IP.
    const dnsServers = parsed.iface.dns.split(',').map((s) => s.trim()).filter(Boolean);
    if (dnsServers.length > 0) {
      const dnsLines = dnsServers.map((ip) => `nameserver ${ip}`).join('\n');
      fs.writeFileSync('/etc/resolv.conf', dnsLines + '\n', 'utf-8');
    }

    // 12. Verify the config loaded (peer configured, not necessarily handshaked)
    try {
      const verifyOutput = await execCmd('wg show', 3_000);
      if (!verifyOutput.includes('peer:')) {
        console.warn('[VPN] Interface created but no peer configured — config may be invalid');
        await disconnect();
        return false;
      }
    } catch { /* wg show might not work immediately — proceed anyway */ }

    console.log(`[VPN] Connected to "${config.label}"`);

    // Store connection state
    get().run("INSERT OR REPLACE INTO settings (key, value) VALUES ('vpn_active_config_id', ?)", [String(configId)]);
    get().run("INSERT OR REPLACE INTO settings (key, value) VALUES ('vpn_interface', ?)", [DEFAULT_IFACE]);
    get().run("INSERT OR REPLACE INTO settings (key, value) VALUES ('vpn_connected_at', ?)", [new Date().toISOString()]);
    get().save();

    return true;
  } catch (err) {
    console.error(`[VPN] Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    // Clean up on failure — interface might be partially created
    try { await execCmd(`ip link delete dev ${DEFAULT_IFACE} 2>/dev/null`, 3_000); } catch { /* ignore */ }
    return false;
  }
}

/**
 * Disconnect the current VPN connection.
 */
export async function disconnect(): Promise<boolean> {
  const status = await getStatus();
  if (!status.connected) return true;

  try {
    console.log(`[VPN] Disconnecting interface "${DEFAULT_IFACE}"...`);
    await execCmd(`ip link delete dev ${DEFAULT_IFACE}`, 5_000);
    console.log('[VPN] Disconnected');
  } catch (err) {
    console.warn(`[VPN] Disconnect warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  get().run("DELETE FROM settings WHERE key IN ('vpn_active_config_id', 'vpn_interface', 'vpn_connected_at')");
  get().save();
  return true;
}

/**
 * Connect to a random VPN config from the pool.
 */
export async function connectRandom(): Promise<number | null> {
  const configs = listConfigs();
  if (configs.length === 0) return null;

  const pick = configs[Math.floor(Math.random() * configs.length)];
  const ok = await connect(pick.id);
  return ok ? pick.id : null;
}

/**
 * Rotate to a different VPN config.
 */
export async function rotate(): Promise<number | null> {
  const configs = listConfigs();
  if (configs.length === 0) return null;

  const status = await getStatus();
  const others = configs.filter((c) => c.id !== status.configId);
  const pick = others.length > 0
    ? others[Math.floor(Math.random() * others.length)]
    : configs[Math.floor(Math.random() * configs.length)];

  const ok = await connect(pick.id);
  return ok ? pick.id : null;
}

// ── Status ─────────────────────────────────────────────────────────

/**
 * Get the current VPN connection status via `wg show`.
 */
export async function getStatus(): Promise<VpnStatus> {
  const empty: VpnStatus = {
    connected: false,
    configId: null,
    configLabel: null,
    serverIp: null,
    device: null,
    since: null,
  };

  try {
    const output = await execCmd('wg show', 5_000);
    if (!output.trim()) return empty;

    const lines = output.split('\n');
    const interfaceLine = lines[0];
    const device = interfaceLine?.split(':')[1]?.trim() || null;

    const endpointLine = lines.find((l) => l.trim().startsWith('endpoint:'));
    const serverIp = endpointLine?.split(':')[1]?.trim().split(':')[0] || null;

    const latestHandshake = lines.find((l) => l.trim().startsWith('latest handshake:'));
    const since = latestHandshake?.split(':')[1]?.trim() || null;

    const storedId = get().get<{ value: string }>("SELECT value FROM settings WHERE key = 'vpn_active_config_id'");
    const configId = storedId ? Number(storedId.value) : null;
    let configLabel: string | null = null;
    if (configId) {
      const row = get().get<{ label: string }>('SELECT label FROM vpn_configs WHERE id = ?', [configId]);
      configLabel = row?.label || null;
    }

    return { connected: true, configId, configLabel, serverIp, device, since };
  } catch {
    return empty;
  }
}

/**
 * Check if the VPN subsystem is available.
 */
export async function isVpnAvailable(): Promise<boolean> {
  try {
    await execCmd('which wg', 3_000);
    await execCmd('which ip', 3_000);
    return true;
  } catch {
    return false;
  }
}
