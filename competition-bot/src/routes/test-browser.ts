import { Router } from 'express';
import { newPage } from '../bot/browser.js';
import { get } from '../db/db.js';

export const testBrowserRouter = Router();

testBrowserRouter.post('/', async (_req, res) => {
  let page;
  try {
    page = await newPage();

    // ── Step 1: Try loading a real competition site to check for CDN/Cloudflare blocks ──
    // This directly answers "is Cloudflare still detecting us?"
    let realPageTest = { attempted: false, url: '', status: 0, error: '', bodyLength: 0 };
    try {
      // First try loading a competition page from the DB, then fall back to a known site
      const firstPage = get().get<{ url: string; name: string }>('SELECT url, name FROM competition_pages WHERE enabled = 1 ORDER BY id ASC LIMIT 1');
      const testUrl = firstPage?.url || 'https://www.theprizefinder.com/top-prizes';
      realPageTest.url = testUrl;
      realPageTest.attempted = true;

      const response = await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (response) {
        realPageTest.status = response.status();
        realPageTest.bodyLength = (await response.text())?.length || 0;
      }
    } catch (navErr) {
      realPageTest.error = navErr instanceof Error ? navErr.message.slice(0, 150) : String(navErr);
    }

    // ── Step 2: Run fingerprint checks on the loaded page ──
    const signals = await page.evaluate(() => {
      const results: Record<string, { value: string; status: 'pass' | 'warn' | 'fail'; tip?: string }> = {};

      // ── 1. User Agent ────────────────────────────────────────────
      const ua = navigator.userAgent;
      const isFirefox = ua.includes('Firefox');
      const isHeadless = ua.includes('Headless');
      results.userAgent = {
        value: ua.slice(0, 120),
        status: isFirefox ? 'pass' : 'warn',
        tip: isHeadless ? '⚠️ Contains "Headless" — detectable!' :
              !isFirefox ? 'Uses non-Firefox UA — may differ from browser engine' : undefined,
      };

      // ── 2. navigator.webdriver ───────────────────────────────────
      const wd = (navigator as any).webdriver;
      results.webdriver = {
        value: String(wd),
        status: wd == null ? 'pass' : 'fail',
        tip: wd != null ? '🚨 Bot detected! Real browsers never expose webdriver=true' : '✅ Hidden',
      };

      // ── 3. navigator.languages ───────────────────────────────────
      const langs = navigator.languages;
      results.languages = {
        value: Array.isArray(langs) ? langs.join(', ') : String(langs),
        status: Array.isArray(langs) && langs.length > 0 ? 'pass' : 'warn',
      };

      // ── 4. Plugins ──────────────────────────────────────────────
      const plugins = navigator.plugins;
      const pluginCount = plugins?.length ?? 0;
      results.plugins = {
        value: `${pluginCount} plugin${pluginCount !== 1 ? 's' : ''}`,
        status: pluginCount > 0 ? 'pass' : 'warn',
        tip: pluginCount === 0 ? 'No plugins — headless browsers often report 0 plugins' : undefined,
      };

      // ── 5. Hardware concurrency ──────────────────────────────────
      const cores = navigator.hardwareConcurrency;
      results.hardwareConcurrency = {
        value: `${cores} core${cores !== 1 ? 's' : ''}`,
        status: cores >= 2 ? 'pass' : 'warn',
        tip: cores < 2 ? 'Very low core count — looks like a minimal VM' : undefined,
      };

      // ── 6. Device memory ─────────────────────────────────────────
      const mem = (navigator as any).deviceMemory;
      results.deviceMemory = {
        value: mem != null ? `${mem} GB` : 'not reported',
        status: mem == null ? 'pass' : (mem >= 2 ? 'pass' : 'warn'),
        tip: mem == null ? 'Firefox does not expose deviceMemory — expected, not a leak' : undefined,
      };

      // ── 7. window.chrome ─────────────────────────────────────────
      const hasChrome = typeof (window as any).chrome !== 'undefined';
      results.chromeRuntime = {
        value: hasChrome ? 'Present' : 'Absent',
        status: hasChrome ? 'warn' : 'pass',
        tip: hasChrome ? 'window.chrome exists — unusual for Firefox, suggests stealth patches left a trace' :
                         '✅ Normal for Firefox',
      };

      // ── 8. Screen dimensions ─────────────────────────────────────
      results.screen = {
        value: `${screen.width}×${screen.height} (avail: ${screen.availWidth}×${screen.availHeight})`,
        status: screen.width >= 1920 ? 'pass' : 'warn',
        tip: screen.width < 1920 ? 'Small viewport — may not match expected desktop resolution' : undefined,
      };

      // ── 9. Canvas fingerprint ────────────────────────────────────
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 50;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.textBaseline = 'alphabetic';
          ctx.fillStyle = '#f60';
          ctx.fillRect(100, 1, 62, 20);
          ctx.fillStyle = '#069';
          ctx.font = '11pt Arial';
          ctx.fillText('Cwm fjordbank glyphs vext quiz, 😃', 2, 35);
          const dataUrl = canvas.toDataURL();
          const fingerprint = dataUrl.length;
          // Different engines produce slightly different canvas renders
          results.canvas = {
            value: `rendered (${fingerprint} chars)`,
            status: fingerprint > 1000 ? 'pass' : 'warn',
            tip: fingerprint <= 1000 ? 'Canvas render appears truncated — possible headless issue' : undefined,
          };
        } else {
          results.canvas = { value: 'Canvas 2D not available', status: 'fail', tip: '🚨 Canvas API blocked — highly detectable' };
        }
      } catch {
        results.canvas = { value: 'Canvas threw an error', status: 'fail', tip: '🚨 Canvas API blocked' };
      }

      // ── 10. WebGL ──────────────────────────────────────────────
      try {
        const c = document.createElement('canvas');
        const gl = (c.getContext('webgl') || c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
        if (gl) {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          const vendor = ext ? (gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string) : 'not available';
          const renderer = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : 'not available';
          results.webgl = {
            value: `${vendor} — ${renderer}`.slice(0, 120),
            status: vendor && !vendor.includes('SwiftShader') && !vendor.includes('llvm') ? 'pass' : 'warn',
            tip: vendor?.includes('SwiftShader') || vendor?.includes('llvm') ?
                 'Software renderer — typical of headless/CI environments' : undefined,
          };
        } else {
          results.webgl = { value: 'WebGL not available', status: 'warn', tip: 'WebGL not supported — uncommon on real desktops' };
        }
      } catch {
        results.webgl = { value: 'WebGL threw an error', status: 'fail', tip: 'WebGL blocked — highly detectable' };
      }

      // ── 11. Platform ────────────────────────────────────────────
      const platform = (navigator as any).platform || 'unknown';
      results.platform = {
        value: platform,
        status: platform.toLowerCase().includes('win') || platform.toLowerCase().includes('linux') ? 'pass' : 'warn',
      };

      // ── 12. Touch support ──────────────────────────────────────
      const maxTouchPoints = navigator.maxTouchPoints;
      results.touch = {
        value: `${maxTouchPoints} touch point${maxTouchPoints !== 1 ? 's' : ''}`,
        status: maxTouchPoints === 0 ? 'pass' : 'warn',
        tip: maxTouchPoints > 0 ? 'Touch support detected — unusual for headless on a server' : undefined,
      };

      return results;
    });

    // ── Compute overall score ──────────────────────────────────────
    let passCount = 0;
    let warnCount = 0;
    let failCount = 0;
    for (const s of Object.values(signals)) {
      if (s.status === 'pass') passCount++;
      else if (s.status === 'warn') warnCount++;
      else failCount++;
    }
    const total = Object.keys(signals).length;
    const score = Math.round((passCount / total) * 100);
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';

    res.json({
      ok: true,
      data: {
        browser: 'Firefox',
        headless: await page.evaluate(() => navigator.userAgent.includes('Headless')),
        score,
        grade,
        summary: `${passCount}/${total} pass, ${warnCount} warn, ${failCount} fail`,
        signals,
        userAgent: await page.evaluate(() => navigator.userAgent),
        realPageTest,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: `Browser test failed: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    if (page) await page.close();
  }
});
