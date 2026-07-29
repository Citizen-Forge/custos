import { initDb, get } from './db/db.js';
import { createApp } from './server.js';
import cron from 'node-cron';

const PORT = Number(process.env.PORT) || 3456;

async function main() {
  // Initialize database (sql.js WASM load + schema migration)
  await initDb();
  console.log('✓ Database initialized');

  const app = createApp();

  const server = app.listen(PORT, () => {
    console.log(`🏆 Competition Bot running on http://0.0.0.0:${PORT}`);
  });

  // ── Scheduler ───────────────────────────────────────────────────
  // Check every minute if a scan is due

  async function scheduledScan() {
    try {
      const intervalRow = get().get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'scan_interval_minutes'",
      );
      if (!intervalRow) return;
      const interval = Number(intervalRow.value);
      if (interval <= 0) return;

      const lastScanRow = get().get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'last_scan_time'",
      );
      const lastScan = lastScanRow ? new Date(lastScanRow.value).getTime() : 0;
      const now = Date.now();

      if (now - lastScan < interval * 60 * 1000) return;

      console.log('Scan scheduled: scanning all active pages...');

      const { scanPage } = await import('./bot/scanner.js');
      const pages = get().all<{ id: number; name: string }>(
        'SELECT id, name FROM competition_pages WHERE enabled = 1',
      );

      for (const page of pages) {
        try {
          const found = await scanPage(page.id);
          get().save();
          console.log(`  ${page.name}: found ${found.length} competitions`);
        } catch (err) {
          console.error(`  ${page.name}: error - ${err}`);
        }
      }

      get().run(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_scan_time', ?)",
        [new Date().toISOString()],
      );
      get().save();
      console.log('Scan complete.');
    } catch (err) {
      console.error('Scheduled scan error:', err);
    }
  }

  cron.schedule('* * * * *', scheduledScan);

  // ── Graceful shutdown ───────────────────────────────────────────

  async function shutdown() {
    console.log('\nShutting down...');
    const { closeBrowser } = await import('./bot/browser.js');
    await closeBrowser();
    server.close(() => process.exit(0));
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
