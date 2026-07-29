import { Router } from 'express';
import { get } from '../db/db.js';
import { enterCompetition } from '../bot/enterer.js';
import { botEvents } from '../events.js';
import { connectRandom, disconnect, getStatus } from '../vpn/manager.js';

export const enterRouter = Router();

enterRouter.post('/:competitionId', async (req, res) => {
  const competitionId = Number(req.params.competitionId);
  const competition = get().get('SELECT * FROM competitions WHERE id = ?', [competitionId]);
  if (!competition) return res.status(404).json({ ok: false, error: 'Competition not found' });

  const providerId = Number(req.body.providerId) || 0;
  const provider = get().get('SELECT * FROM llm_providers WHERE id = ?', [providerId]);
  if (!provider) return res.status(400).json({ ok: false, error: 'No LLM provider configured or specified' });

  try {
    const result = await enterCompetition(competitionId, provider as any);
    get().save();
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

enterRouter.post('/batch/:providerId', async (req, res) => {
  const providerId = Number(req.params.providerId);
  const provider = get().get('SELECT * FROM llm_providers WHERE id = ?', [providerId]);
  if (!provider) return res.status(400).json({ ok: false, error: 'LLM provider not found' });

  const maxRow = get().get<{ value: string }>("SELECT value FROM settings WHERE key = 'max_concurrent_entries'");
  const maxConcurrent = Math.min(Number(maxRow?.value) || 3, 10);

  // Read the inter-entry delay from settings (with 30% random jitter)
  const intervalSeconds = Number(get().get<{ value: string }>("SELECT value FROM settings WHERE key = 'entry_interval_seconds'")?.value) || 30;

  // ── VPN: Connect before batch entry if enabled ──────────────────
  const vpnEnabled = get().get<{ value: string }>("SELECT value FROM settings WHERE key = 'vpn_enabled'");
  const useVpn = vpnEnabled?.value === 'true';
  let vpnConnected = false;
  if (useVpn) {
    const status = await getStatus();
    if (!status.connected) {
      botEvents.info('🔐 Connecting VPN before batch entry...');
      vpnConnected = (await connectRandom()) !== null;
      if (vpnConnected) {
        botEvents.info('✅ VPN connected — entry traffic will use VPN IP');
      } else {
        botEvents.info('⚠️ VPN connect failed — entering without VPN');
      }
    } else {
      botEvents.info(`🔐 Already connected via VPN (${status.configLabel || status.serverIp || 'unknown'})`);
    }
  }

  const competitions = get().all<{ id: number; title: string }>(
    "SELECT id, title FROM competitions WHERE status = 'found' ORDER BY created_at ASC LIMIT ?",
    [maxConcurrent],
  );

  const results = [];
  for (let i = 0; i < competitions.length; i++) {
    const comp = competitions[i];
    try {
      const result = await enterCompetition(comp.id, provider as any);
      get().save();
      results.push({ competitionId: comp.id, title: comp.title, ...result });
    } catch (err) {
      results.push({ competitionId: comp.id, title: comp.title, success: false, message: err instanceof Error ? err.message : String(err) });
    }

    // Apply pacing delay between entries (but not after the last one)
    if (i < competitions.length - 1) {
      // 30% random jitter: interval ± up to 30%
      const jitter = (Math.random() - 0.5) * 0.6; // -0.3 to +0.3
      const delayMs = Math.round(intervalSeconds * (1 + jitter) * 1000);
      const delaySec = (delayMs / 1000).toFixed(1);
      botEvents.info(`  ⏳ Waiting ${delaySec}s before next entry (avoids rate limiting)...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // ── VPN: Disconnect after batch entry if we connected ──────────
  if (vpnConnected) {
    botEvents.info('🔐 Disconnecting VPN after batch entry...');
    await disconnect();
  }

  res.json({ ok: true, data: results });
});
