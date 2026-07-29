import { Router } from 'express';
import { get } from '../db/db.js';
import {
  saveConfigFile,
  listConfigs,
  deleteConfig,
  connect,
  disconnect,
  connectRandom,
  rotate,
  getStatus,
  isVpnAvailable,
} from '../vpn/manager.js';

export const vpnRouter = Router();

// ── Status ──────────────────────────────────────────────────────────

vpnRouter.get('/status', async (_req, res) => {
  const status = await getStatus();
  const available = await isVpnAvailable();
  const configs = listConfigs();
  res.json({
    ok: true,
    data: {
      available,
      connected: status.connected,
      configId: status.configId,
      configLabel: status.configLabel,
      serverIp: status.serverIp,
      since: status.since,
      configCount: configs.length,
    },
  });
});

// ── List configs ───────────────────────────────────────────────────-

vpnRouter.get('/configs', (_req, res) => {
  const configs = listConfigs();
  res.json({ ok: true, data: configs });
});

// ── Add config (upload WireGuard .conf content) ─────────────────────

vpnRouter.post('/configs', (req, res) => {
  const { label, content } = req.body;
  if (!label || !content) {
    return res.status(400).json({ ok: false, error: 'label and content are required' });
  }

  try {
    const config = saveConfigFile(label, content);
    res.status(201).json({ ok: true, data: config });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Get config content ──────────────────────────────────────────────

vpnRouter.get('/configs/:id', (req, res) => {
  const id = Number(req.params.id);
  const config = get().get<{ id: number; label: string; filename: string; country: string }>(
    'SELECT * FROM vpn_configs WHERE id = ?', [id],
  );
  if (!config) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, data: config });
});

// ── Delete config ─────────────────────────────────────────────────-─

vpnRouter.delete('/configs/:id', async (req, res) => {
  const id = Number(req.params.id);
  const ok = await deleteConfig(id);
  if (!ok) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true });
});

// ── Connect to a specific config ───────────────────────────────────-

vpnRouter.post('/connect/:configId', async (req, res) => {
  const configId = Number(req.params.configId);

  if (!(await isVpnAvailable())) {
    return res.status(400).json({ ok: false, error: 'WireGuard tools not available in this container. Ensure --cap-add=NET_ADMIN is set.' });
  }

  try {
    const ok = await connect(configId);
    const status = await getStatus();
    res.json({ ok: true, data: { success: ok, status } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Connect to a random config ──────────────────────────────────────

vpnRouter.post('/connect-random', async (_req, res) => {
  if (!(await isVpnAvailable())) {
    return res.status(400).json({ ok: false, error: 'WireGuard tools not available' });
  }

  try {
    const configId = await connectRandom();
    const status = await getStatus();
    res.json({ ok: true, data: { success: configId !== null, configId, status } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Rotate to a different config ────────────────────────────────────

vpnRouter.post('/rotate', async (_req, res) => {
  if (!(await isVpnAvailable())) {
    return res.status(400).json({ ok: false, error: 'WireGuard tools not available' });
  }

  try {
    const configId = await rotate();
    const status = await getStatus();
    res.json({ ok: true, data: { success: configId !== null, configId, status } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Disconnect ──────────────────────────────────────────────────────

vpnRouter.post('/disconnect', async (_req, res) => {
  try {
    await disconnect();
    const status = await getStatus();
    res.json({ ok: true, data: { status } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
