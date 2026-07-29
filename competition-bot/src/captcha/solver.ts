/**
 * CAPTCHA solving service — outsources reCAPTCHA v2, hCaptcha, and
 * Cloudflare Turnstile challenges to third-party solving services
 * (2captcha or capsolver) when the LLM can't handle them.
 *
 * Each solve requires one long-polling cycle (typically 10–30 s).
 * Services are chosen and configured via Settings.
 */

import { botEvents } from '../events.js';
import { get } from '../db/db.js';

// ── Types ─────────────────────────────────────────────────────────────

export type CaptchaService = 'none' | '2captcha' | 'capsolver';

export type CaptchaType = 'recaptcha_v2' | 'hcaptcha' | 'turnstile';

export interface SolveResult {
  success: boolean;
  token?: string;
  error?: string;
}

// ── Configuration helpers ─────────────────────────────────────────────

export function getActiveService(): CaptchaService {
  const row = get().get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'captcha_service'",
  );
  const val = (row?.value || 'none') as CaptchaService;
  return ['2captcha', 'capsolver'].includes(val) ? val : 'none';
}

function getApiKey(): string {
  const row = get().get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'captcha_api_key'",
  );
  return row?.value || '';
}

// ── Sitekey extraction from page ──────────────────────────────────────

export interface CaptchaWidget {
  type: CaptchaType;
  sitekey: string;
  /** CSS selector of the element containing the widget. */
  containerSelector?: string;
}

/**
 * Scan the current page for CAPTCHA widgets and return their type + sitekey.
 * Run inside page.evaluate() so it has access to the live DOM.
 */
export function detectCaptchaWidgetsScript(): string {
  return `
(() => {
  const widgets = [];

  // reCAPTCHA v2 — look for data-sitekey attribute
  const recaptchaEls = document.querySelectorAll('[data-sitekey]');
  for (const el of recaptchaEls) {
    const sitekey = el.getAttribute('data-sitekey');
    if (sitekey) {
      widgets.push({ type: 'recaptcha_v2', sitekey, containerSelector: '#' + (el.id || '') });
    }
  }

  // reCAPTCHA — look for grecaptcha.render calls (can be in a div with class g-recaptcha)
  const grecaptchaEls = document.querySelectorAll('.g-recaptcha');
  for (const el of grecaptchaEls) {
    const sitekey = el.getAttribute('data-sitekey');
    if (sitekey) {
      widgets.push({ type: 'recaptcha_v2', sitekey, containerSelector: '.g-recaptcha' });
    }
  }

  // hCaptcha
  const hcaptchaEls = document.querySelectorAll('.h-captcha, [data-hcaptcha]');
  for (const el of hcaptchaEls) {
    const sitekey = el.getAttribute('data-sitekey');
    if (sitekey) {
      widgets.push({ type: 'hcaptcha', sitekey, containerSelector: '.h-captcha' });
    }
  }

  // Turnstile
  const turnstileEls = document.querySelectorAll('.cf-turnstile, [data-turnstile]');
  for (const el of turnstileEls) {
    const sitekey = el.getAttribute('data-sitekey');
    if (sitekey) {
      widgets.push({ type: 'turnstile', sitekey, containerSelector: '.cf-turnstile' });
    }
  }

  // Also check iframes (sometimes widget is embedded in an iframe with src containing the sitekey)
  const iframes = document.querySelectorAll('iframe');
  for (const f of iframes) {
    const src = (f.src || '').toLowerCase();
    if (src.includes('recaptcha') || src.includes('hcaptcha') || src.includes('turnstile')) {
      // Extract sitekey from iframe URL params — heuristic
      const match = src.match(/[?&](?:k|sitekey|key)=([^&]+)/);
      if (match) {
        widgets.push({
          type: src.includes('hcaptcha') ? 'hcaptcha' : src.includes('turnstile') ? 'turnstile' : 'recaptcha_v2',
          sitekey: match[1],
        });
      }
    }
  }

  return widgets.length > 0 ? widgets : null;
})()
`.trim();
}

/**
 * Inject the solved token into the page so the form can submit.
 * Different CAPTCHA types use different callback / hidden-field mechanisms.
 */
export function injectTokenScript(type: CaptchaType, token: string): string {
  const escape = JSON.stringify(token);

  switch (type) {
    case 'recaptcha_v2':
      return `
(function() {
  // Find the reCAPTCHA textarea (the one that stores the g-recaptcha-response)
  const ta = document.getElementById('g-recaptcha-response');
  if (ta) {
    ta.value = ${escape};
    ta.style.display = ''; // make visible so the form sees it
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Also try the internal grecaptcha callback
  if (typeof ___grecaptcha_cfg !== 'undefined') {
    try {
      // Find the callback function and call it with the token
      const clients = ___grecaptcha_cfg.clients;
      if (clients) {
        for (const id of Object.keys(clients)) {
          const client = clients[id];
          if (client && client.callback) {
            client.callback(${escape});
          }
        }
      }
    } catch {}
  }
})()
`.trim();

    case 'hcaptcha':
      return `
(function() {
  const ta = document.getElementById('h-captcha-response');
  if (ta) {
    ta.value = ${escape};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Trigger hCaptcha callback if available
  if (typeof hcaptcha !== 'undefined') {
    try { hcaptcha.setData('session', ${escape}); } catch {}
  }
})()
`.trim();

    case 'turnstile':
      return `
(function() {
  // Turnstile stores its response in a hidden input with name cf-turnstile-response
  const inputs = document.querySelectorAll('input[name="cf-turnstile-response"], input[name="turnstile-response"]');
  for (const el of inputs) {
    el.value = ${escape};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Turnstile validates the hidden input on submit — setting the value above is sufficient
})()
`.trim();
  }
}

// ── Solver APIs ───────────────────────────────────────────────────────

/**
 * Submit a CAPTCHA to 2captcha and poll until solved (or timeout).
 * Docs: https://2captcha.com/2captcha-api
 */
async function solveWith2captcha(
  apiKey: string,
  type: CaptchaType,
  sitekey: string,
  pageUrl: string,
): Promise<SolveResult> {
  const BASE = 'https://2captcha.com';

  // Map our type to 2captcha's method parameter
  const methodMap: Record<CaptchaType, string> = {
    recaptcha_v2: 'userrecaptcha',
    hcaptcha: 'hcaptcha',
    turnstile: 'turnstile',
  };

  // Step 1: Submit the task
  const submitBody = new URLSearchParams({
    key: apiKey,
    method: methodMap[type],
    googlekey: sitekey,
    pageurl: pageUrl,
    json: '1',
    soft_id: '3528', // public soft_id for custom integrations
  });

  const submitRes = await fetch(`${BASE}/in.php`, {
    method: 'POST',
    body: submitBody,
    signal: AbortSignal.timeout(30_000),
  });

  const submitData = await submitRes.json() as { status: number; request: string };
  if (submitData.status !== 1) {
    return { success: false, error: `2captcha submit failed: ${submitData.request}` };
  }

  const taskId = submitData.request;

  // Step 2: Poll for result (up to 120 s)
  const pollUrl = `${BASE}/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`;
  const deadline = Date.now() + 120_000; // 2 minute timeout

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000)); // poll every 5 s

    try {
      const pollRes = await fetch(pollUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      const pollData = await pollRes.json() as { status: number; request: string };

      if (pollData.status === 1) {
        // Solved! The token is in pollData.request
        return { success: true, token: pollData.request };
      }

      // status === 0 means still processing — keep polling
    } catch {
      // Network blip — retry
    }
  }

  return { success: false, error: '2captcha timed out after 120s' };
}

/**
 * Submit a CAPTCHA to capsolver (https://docs.capsolver.com/) and poll
 * until solved (or timeout).
 */
async function solveWithCapsolver(
  apiKey: string,
  type: CaptchaType,
  sitekey: string,
  pageUrl: string,
): Promise<SolveResult> {
  const BASE = 'https://api.capsolver.com';

  // Map our type to capsolver's task type
  const taskTypeMap: Record<CaptchaType, string> = {
    recaptcha_v2: 'ReCaptchaV2TaskProxyless',
    hcaptcha: 'HCaptchaTaskProxyless',
    turnstile: 'AntiTurnstileTaskProxyless',
  };

  // Step 1: Create the task
  const createPayload = {
    clientKey: apiKey,
    task: {
      type: taskTypeMap[type],
      websiteURL: pageUrl,
      websiteKey: sitekey,
    },
  };

  const createRes = await fetch(`${BASE}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createPayload),
    signal: AbortSignal.timeout(30_000),
  });

  const createData = await createRes.json() as { errorId?: number; errorDescription?: string; taskId?: string };
  if (createData.errorId || !createData.taskId) {
    return {
      success: false,
      error: `Capsolver createTask failed: ${createData.errorDescription || 'unknown'}`,
    };
  }

  const taskId = createData.taskId;

  // Step 2: Poll for result
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000)); // poll every 3 s

    try {
      const pollRes = await fetch(`${BASE}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        signal: AbortSignal.timeout(15_000),
      });

      const pollData = await pollRes.json() as {
        errorId?: number;
        status?: 'ready' | 'processing';
        solution?: { gRecaptchaResponse?: string; token?: string };
      };

      if (pollData.errorId || pollData.status === 'processing') {
        continue; // not ready yet
      }

      if (pollData.status === 'ready' && pollData.solution) {
        const token = pollData.solution.gRecaptchaResponse || pollData.solution.token || '';
        if (token) {
          return { success: true, token };
        }
      }
    } catch {
      // Network blip — retry
    }
  }

  return { success: false, error: 'Capsolver timed out after 120s' };
}

// ── Public entry point ────────────────────────────────────────────────

/**
 * Detect CAPTCHA widgets on the current page, then solve the first one
 * using the configured external service.
 *
 * @returns the solved token and captcha type, or null if disabled / failed.
 */
export async function solveCaptchaOnPage(
  page: import('playwright').Page,
  pageUrl: string,
): Promise<{ type: CaptchaType; token: string } | null> {
  const service = getActiveService();
  if (service === 'none') {
    botEvents.info('  ⏭️ External CAPTCHA solving not configured — skipping');
    return null;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    botEvents.info('  ⚠️ CAPTCHA service configured but no API key set — skipping');
    return null;
  }

  // Detect widgets
  const widgets = await page.evaluate(detectCaptchaWidgetsScript()) as CaptchaWidget[] | null;
  if (!widgets || widgets.length === 0) {
    botEvents.info('  ⏭️ No CAPTCHA widgets detected on page');
    return null;
  }

  const widget = widgets[0]; // solve the first one found
  botEvents.info(`  🔐 Solving ${widget.type} CAPTCHA via ${service} (sitekey: ${widget.sitekey.slice(0, 10)}...)`);

  let result: SolveResult;
  const solverLabel = service === '2captcha' ? '2captcha' : 'Capsolver';

  try {
    if (service === '2captcha') {
      result = await solveWith2captcha(apiKey, widget.type, widget.sitekey, pageUrl);
    } else {
      result = await solveWithCapsolver(apiKey, widget.type, widget.sitekey, pageUrl);
    }
  } catch (err) {
    return null;
  }

  if (!result.success || !result.token) {
    botEvents.info(`  ❌ ${solverLabel} failed: ${result.error || 'unknown error'}`);
    return null;
  }

  botEvents.info(`  ✅ ${solverLabel} solved ${widget.type} CAPTCHA`);

  // Inject the token into the page
  const injectionScript = injectTokenScript(widget.type, result.token);
  await page.evaluate(injectionScript);

  // Wait a moment for the page to register the token
  await new Promise((r) => setTimeout(r, 1000));

  return { type: widget.type, token: result.token };
}
