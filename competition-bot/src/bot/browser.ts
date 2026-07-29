import { firefox, type Browser, type Page, type BrowserContext } from 'playwright';
import { get } from '../db/db.js';

let _browser: Browser | null = null;

function getHeadless(): boolean {
  const row = get().get<{ value: string }>("SELECT value FROM settings WHERE key = 'headless_mode'");
  return row ? row.value !== 'false' : true;
}

export async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await firefox.launch({
    headless: getHeadless(),
    args: [
      // Firefox equivalents of the Chrome stealth flags
      '-no-remote',
    ],
    firefoxUserPrefs: {
      // Disable telemetry and automated browser signals
      'toolkit.telemetry.enabled': false,
      'toolkit.telemetry.unified': false,
      'datareporting.healthreport.uploadEnabled': false,
      'datareporting.policy.dataSubmissionEnabled': false,
      // Set a consistent timezone
      'javascript.options.mem.max': 1024,
    },
  });
  return _browser;
}

export async function newPage(): Promise<Page> {
  const browser = await getBrowser();

  // Create an isolated browser context — this lets us set
  // extra HTTP headers and other per-context options.
  const context: BrowserContext = await browser.newContext({
    // Use a realistic Firefox User-Agent (v131+)
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    // Block unnecessary resource types to speed up page loads
    // and reduce detection surface
    bypassCSP: true,
    // Send realistic Accept-Language header
    extraHTTPHeaders: {
      'Accept-Language': 'en-GB,en;q=0.9,en-US;q=0.8',
    },
  });

  const page = await context.newPage();

  // Extra patches that run before any page JavaScript loads
  await page.addInitScript(() => {
    // Ensure navigator.languages matches our locale
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-GB', 'en', 'en-US'],
      configurable: true,
    });
    // Hide the automation flag — Playwright exposes this by default
    // on Navigator.prototype. Delete it from the prototype chain
    // entirely rather than shadowing it, so advanced detectors
    // (Object.getOwnPropertyDescriptor, hasOwnProperty, 'in' operator)
    // all see nothing — exactly like a real browser.
    try {
      const proto = Object.getPrototypeOf(navigator);
      if ('webdriver' in proto) {
        delete (proto as any).webdriver;
      }
    } catch {}
  });

  return page;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    try {
      await _browser.close();
    } catch { /* ignore */ }
    _browser = null;
  }
}
