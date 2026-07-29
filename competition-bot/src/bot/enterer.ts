import { get } from '../db/db.js';
import { newPage } from './browser.js';
import { analyseFormFields, answerQuestion, analyseSubmitAction, chooseSelectOption, askLlm } from '../llm/client.js';
import { matchesEntryCta } from './cta-match.js';
import { solveCaptchaOnPage, getActiveService } from '../captcha/solver.js';
import type { LlmProvider } from '../config/types.js';
import type { AnalysedField } from '../llm/client.js';
import type { Page as PlaywrightPage } from 'playwright';
import { botEvents } from '../events.js';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');

interface ProfileField {
  field_key: string;
  field_label: string;
  field_value: string;
}

// Alias map: any of these tokens in a form field's label/name → profile key
const FIELD_ALIASES: Record<string, string[]> = {
  email: ['email', 'e-mail', 'mail', 'email address'],
  full_name: ['full name', 'your name', 'name'],
  first_name: ['first name', 'firstname', 'forename', 'given name'],
  last_name: ['last name', 'lastname', 'surname', 'family name'],
  phone: ['phone', 'telephone', 'mobile', 'phone number', 'contact number'],
  address: ['address', 'street', 'address line 1', 'address line1'],
  address2: ['address line 2', 'address line2', 'apt', 'suite', 'unit'],
  city: ['city', 'town', 'suburb'],
  state: ['state', 'county', 'province', 'region'],
  postcode: ['postcode', 'zip', 'zip code', 'postal code'],
  country: ['country', 'nation'],
  date_of_birth: ['date of birth', 'dob', 'birth date', 'birthday', 'birth date'],
  occupation: ['occupation', 'job', 'job title', 'profession', 'career'],
  company: ['company', 'business', 'organisation', 'organization', 'employer'],
  website: ['website', 'web site', 'url', 'blog', 'social media'],
};

const FIELD_LOOKUP = new Map<string, string[]>();
for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
  FIELD_LOOKUP.set(key, aliases);
}

/**
 * Enter a competition by visiting its URL, analysing the form,
 * filling it in, and submitting it — with robust multi-strategy submission.
 */
export async function enterCompetition(
  competitionId: number,
  provider: LlmProvider,
): Promise<{ success: boolean; message: string }> {
  const competition = get().get<{
    id: number; title: string; url: string; status: string;
  }>('SELECT * FROM competitions WHERE id = ?', [competitionId]);

  if (!competition) return { success: false, message: 'Competition not found' };
  if (competition.status === 'entered') return { success: false, message: 'Already entered' };
  if (competition.status === 'excluded') return { success: false, message: 'Competition is excluded' };

  botEvents.enterStart(competition.title);

  const page = await newPage();
  let success = false;
  let errorMessage = '';
  let screenshotBefore = '';
  let screenshotAfter = '';

  try {
    await page.goto(competition.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 2000));

    // ── Follow external competition link if this is an aggregator/forum ──
    // Loquax, MSE, and similar forums don't host entry forms themselves —
    // they link out to the actual competition page. If we detect a single
    // prominent outbound link, navigate to it before analysing the form.
    const followed = await followExternalCompetitionLink(page, competition.url);
    if (followed) {
      await new Promise((r) => setTimeout(r, 3000));
    }

    // ── CAPTCHA detection ────────────────────────────────────────────
    // Don't abort immediately — many pages embed reCAPTCHA/hCaptcha widgets
    // (e.g. Gleam forms) that don't block basic email entry. We mark the
    // presence and only fail if submission is actually blocked.
    const captchaDetected = await page.evaluate(() => {
      const body = document.body?.innerHTML?.toLowerCase() || '';
      return (
        body.includes('recaptcha') ||
        body.includes('hcaptcha') ||
        body.includes('g-recaptcha') ||
        body.includes('cf-turnstile') ||
        body.includes('turnstile') ||
        document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, div[class*="captcha"], .cf-turnstile, iframe[src*="turnstile"]') !== null
      );
    });

    if (captchaDetected) {
      botEvents.info('  ⚠️ CAPTCHA widget detected on page — will attempt entry anyway (many forms with embedded captcha work fine for basic entry)');
    }

    // ── Analyse the page for form fields ──────────────────────────────
    const pageContent = await page.evaluate(() => document.body?.innerText || '');
    const pageHtml = await page.evaluate(() => document.body?.innerHTML?.slice(0, 5000) || '');

    // Also grab image descriptions (alt text, titles, captions) for richer prize context
    const imageDetails = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img[alt], img[title]'));
      return imgs
        .map((img) => {
          const el = img as HTMLImageElement;
          const alt = el.alt?.trim();
          const title = el.title?.trim();
          const src = el.src?.split('/').pop()?.split('?')[0] || '';
          const parts = [alt, title, src].filter(Boolean);
          return parts.length ? `Image: ${parts.join(' — ')}` : '';
        })
        .filter(Boolean)
        .slice(0, 20)
        .join('\n');
    });

    // Build prize-rich context for LLM question answering.
    const fullContext = [
      `--- PRIZE IMAGES ---`,
      imageDetails || '(no images found)',
      `\n--- PAGE TEXT ---`,
      pageContent.slice(0, 4000),
      `\n--- PAGE HTML (snippet) ---`,
      pageHtml.slice(0, 1500),
    ].join('\n');

    const analysis = await analyseFormFields(provider, pageContent + '\n\n' + pageHtml, competition.url);

    // Update competition with analysis
    get().run('UPDATE competitions SET requires_questions = ?, description = ? WHERE id = ?',
      [analysis.requiresQuestions ? 1 : 0, analysis.summary, competitionId]);

    // ── Fill in the form ─────────────────────────────────────────────
    for (const field of analysis.fields) {
      const value = await determineFieldValue(field, provider, competition.title, fullContext);
      if (value === '__SKIP__') continue;
      if (value !== undefined && value !== '') {
        await fillField(page, field, value);
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // ── Try to solve text-based CAPTCHAs with the LLM ────────────────
    // Many competition pages use simple anti-spam questions like
    // "What is 3+5?" that an LLM can trivially answer, or "Enter the code"
    // prompts where the code is shown on the page.
    await solveTextCaptcha(page, provider, competition.title, pageContent);

    // ── Try to find and check consent checkboxes ─────────────────────
    await page.evaluate(() => {
      const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      ));
      for (const cb of checkboxes) {
        const label = (cb.closest('label')?.innerText || cb.nextSibling?.textContent || '').toLowerCase();
        const id = (cb.id || '').toLowerCase();
        const name = (cb.name || '').toLowerCase();
        const termsIndicators = ['terms', 'conditions', 'privacy', 'agree', 'consent', 'accept'];
        const shouldCheck = termsIndicators.some((t) => label.includes(t) || id.includes(t) || name.includes(t));
        if (shouldCheck && !cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });

    // ── Handle multi-step flows ────────────────────────────────────
    if (analysis.submitStrategy.type === 'multi_step' && analysis.submitStrategy.steps) {
      for (const step of analysis.submitStrategy.steps) {
        if (step.action === 'wait') {
          const ms = parseInt(step.target || '2000', 10);
          await new Promise((r) => setTimeout(r, ms));
        } else if (step.action === 'click' && step.target) {
          await page.evaluate((sel) => {
            const el = document.querySelector<HTMLElement>(sel);
            if (el) el.click();
          }, step.target);
          await new Promise((r) => setTimeout(r, 1500));
        } else if (step.action === 'scroll') {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    // ── Screenshot: filled form (before submit) ─────────────────────
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const beforePath = path.join(SCREENSHOT_DIR, `${competitionId}-before.png`);
    await page.screenshot({ path: beforePath, fullPage: true });
    screenshotBefore = `/screenshots/${competitionId}-before.png`;

    // ── Submit the form — multi-strategy ────────────────────────────
    let submitted = await submitForm(page, provider, competition.title, pageContent, pageHtml);

    // ── If submission failed and CAPTCHA detected, try external solver ───
    if (!submitted && captchaDetected) {
      const serviceName = getActiveService();
      if (serviceName !== 'none') {
        botEvents.info('  🔄 First submission attempt failed with CAPTCHA present — trying external solving service...');

        const solved = await solveCaptchaOnPage(page, competition.url);
        if (solved) {
          // Wait for the page to process the solved token
          await new Promise((r) => setTimeout(r, 2000));

          // Retry submission with the solved CAPTCHA
          botEvents.info('  🔄 Retrying submission with solved CAPTCHA...');
          submitted = await submitForm(page, provider, competition.title, pageContent, pageHtml);
        }
      }
    }

    if (!submitted) {
      // Distinguish CAPTCHA-blocked failures from normal submit-button failures
      if (captchaDetected && getActiveService() === 'none') {
        throw new Error('CAPTCHA detected — form could not be submitted (CAPTCHA widget likely blocked the entry). Consider configuring an external CAPTCHA solving service in Settings.');
      }
      if (captchaDetected) {
        throw new Error('CAPTCHA detected — form could not be submitted even after external solving attempt (the solving service may have failed or the CAPTCHA may not be the blocker)');
      }
      throw new Error(
        "Could not find submit button — none of the 7 strategies located a click-to-enter CTA, a submit button, or a keyboard/Enter/click_next path. See the activity feed for the strategy results; the most common cause on third-party aggregator pages (customerfocus.co.uk, Loquax) is that the entry CTA is a plain <a> tag with text like \"Click here to enter <prize>\", now covered by strategy 6b.",
      );
    }

    // Wait for submission to process (slightly longer to let result page load)
    await new Promise((r) => setTimeout(r, 4000));

    // ── Screenshot: success/confirmation page (after submit) ────────
    const afterPath = path.join(SCREENSHOT_DIR, `${competitionId}-after.png`);
    await page.screenshot({ path: afterPath, fullPage: true });
    screenshotAfter = `/screenshots/${competitionId}-after.png`;

    // ── Check for success indicators ─────────────────────────────────
    const pageAfterSubmit = await page.evaluate(() => document.body?.innerText?.toLowerCase() || '');
    const successIndicators = ['thank you', "you're entered", 'success', 'submitted', 'good luck', 'entry received', 'you are now entered'];
    const hasSuccessMessage = successIndicators.some((s) => pageAfterSubmit.includes(s));

    success = hasSuccessMessage;
    if (!hasSuccessMessage) {
      errorMessage = 'Could not confirm successful entry (page may have changed)';
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    await page.close();
  }

  // Record the entry — and persist immediately
  get().run("UPDATE competitions SET status = ? WHERE id = ?", [success ? 'entered' : 'failed', competitionId]);
  get().run(
    'INSERT INTO entries (competition_id, competition_title, status, response_data, error_message, screenshot_before, screenshot_after) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [competitionId, competition.title, success ? 'success' : 'failed', '', errorMessage, screenshotBefore, screenshotAfter],
  );
  get().save();

  botEvents.enterDone(competition.title, success, success ? undefined : errorMessage);

  return {
    success,
    message: success ? 'Successfully entered competition' : `Failed: ${errorMessage}`,
  };
}

// ── Multi-strategy form submission ─────────────────────────────────────

/** Success phrases that indicate an entry was submitted correctly. */
const SUCCESS_PHRASES = [
  'thank you', "you're entered", 'success', 'submitted',
  'good luck', 'entry received', 'you are now entered',
];

/**
 * Check whether the current page shows a success message.
 */
async function checkSuccess(page: PlaywrightPage): Promise<boolean> {
  const text = await page.evaluate(() => document.body?.innerText?.toLowerCase() || '');
  return SUCCESS_PHRASES.some((p) => text.includes(p));
}

/**
 * If the current page is a forum/aggregator thread that links out to the
 * actual competition (e.g. Loquax XenForo threads), find the outbound
 * link and navigate to it before form analysis. Returns true if followed.
 */
async function followExternalCompetitionLink(
  page: PlaywrightPage,
  currentUrl: string,
): Promise<boolean> {
  try {
    const currentOrigin = new URL(currentUrl).origin;

    const outbound = await page.evaluate((origin: string) => {
      // Collect all <a> tags in the main content area. On XenForo (Loquax),
      // the thread content lives in .messageContent or .message-body.
      const contentSelectors = [
        '.messageContent',
        '.message-body',
        '.article-body',
        '.post-body',
        'article',
        '[role="main"]',
        'main',
      ];

      const links: Array<{ text: string; href: string; score: number }> = [];

      function scoreLink(href: string, text: string): number {
        const lowerText = text.toLowerCase();
        let score = 0;
        if (!href.startsWith('/') && !href.startsWith(origin) && !href.startsWith('#')) {
          score += 10;
        }
        if (['enter', 'click here', 'visit', 'go to', 'try', 'enter now', 'enter competition'].some((w) => lowerText.includes(w))) {
          score += 20;
        }
        if (lowerText.startsWith('http')) {
          score += 15;
        }
        return score;
      }

      for (const sel of contentSelectors) {
        const roots = document.querySelectorAll(sel);
        for (const root of Array.from(roots)) {
          const anchors = root.querySelectorAll('a[href]');
          for (const a of Array.from(anchors)) {
            const href = a.getAttribute('href') || '';
            const text = (a.textContent || '').trim();
            if (!href || href.startsWith('#') || href.startsWith(origin)) continue;
            const score = scoreLink(href, text);
            if (score > 0) {
              links.push({ text, href, score });
            }
          }
        }
      }

      // If nothing found in content scopes, fall back to scanning ALL links
      // and picking the best off-domain candidate.
      if (links.length === 0) {
        const allAnchors = document.querySelectorAll('a[href]');
        for (const a of Array.from(allAnchors)) {
          const href = a.getAttribute('href') || '';
          const text = (a.textContent || '').trim();
          if (!href || href.startsWith('#') || href.startsWith(origin)) continue;
          const score = scoreLink(href, text);
          if (score > 0) {
            links.push({ text, href, score });
          }
        }
      }

      // Sort by score descending, return best candidate
      links.sort((a, b) => b.score - a.score);
      // Require score >= 15 in fallback to avoid nav/footer off-domain links
      const minScore = links.length > 0 && links[0].href && !links[0].href.startsWith('http') ? 15 : 10;
      return links.length > 0 && links[0].score >= minScore ? links[0] : null;
    }, currentOrigin);

    if (!outbound) {
      return false;
    }

    botEvents.info(`  🔗 Following outbound competition link: "${outbound.text.slice(0, 60)}" → ${outbound.href}`);

    // Navigate to the competition page
    await page.goto(outbound.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return true;
  } catch (err) {
    botEvents.info(`  ⚠️ Could not follow external link: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Attempt to submit the form using multiple strategies in order.
 * Returns true if any strategy appeared to succeed.
 */
async function submitForm(
  page: PlaywrightPage,
  provider: LlmProvider,
  competitionTitle: string,
  pageText: string,
  pageHtml: string,
): Promise<boolean> {
  const strategies: Array<() => Promise<boolean>> = [
    // Strategy 1: Standard submit button search
    async () => {
      const result = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll<HTMLElement>(
          'button[type="submit"], input[type="submit"]',
        ));
        for (const btn of btns) {
          if (btn instanceof HTMLButtonElement || btn instanceof HTMLInputElement) {
            if (!btn.disabled) { btn.click(); return true; }
          }
        }
        return false;
      });
      if (result) await new Promise((r) => setTimeout(r, 2000));
      return result;
    },

    // Strategy 2: Wait 2s for JS validation, then try again
    async () => {
      await new Promise((r) => setTimeout(r, 2000));
      const result = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll<HTMLElement>(
          'button[type="submit"], input[type="submit"]',
        ));
        for (const btn of btns) {
          if (btn instanceof HTMLButtonElement || btn instanceof HTMLInputElement) {
            if (!btn.disabled) { btn.click(); return true; }
          }
        }
        return false;
      });
      if (result) await new Promise((r) => setTimeout(r, 2000));
      return result;
    },

    // Strategy 3: Look for any clickable element that says enter/submit/play/etc
    async () => {
      const result = await page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll<HTMLElement>(
          'button, a.btn, a.button, [role="button"], input[type="button"]',
        ));
        for (const btn of allBtns) {
          const text = btn.innerText?.toLowerCase() || btn.getAttribute('value')?.toLowerCase() || '';
          if (['enter', 'submit', 'go', 'send', 'play', 'try', 'enter now', 'enter competition', 'i want to win'].some((w) => text.includes(w))) {
            if (btn instanceof HTMLButtonElement || btn instanceof HTMLInputElement) {
              if (btn.disabled) continue;
            }
            btn.click();
            return true;
          }
        }
        return false;
      });
      if (result) await new Promise((r) => setTimeout(r, 2000));
      return result;
    },

    // Strategy 4: Press Tab then Enter on the last text field via Puppeteer's keyboard
    async () => {
      // Focus the last input/textarea
      const hasInputs = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll<HTMLElement>(
          'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea',
        ));
        return inputs.length > 0;
      });
      if (!hasInputs) return false;

      // Use Puppeteer to Tab through and Enter
      await page.keyboard.press('Tab');
      await new Promise((r) => setTimeout(r, 300));
      await page.keyboard.press('Tab');
      await new Promise((r) => setTimeout(r, 500));
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 2000));

      return await checkSuccess(page);
    },

    // Strategy 5: Scroll to bottom — button might be off-screen
    async () => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 1500));
      const result = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll<HTMLElement>(
          'button[type="submit"], input[type="submit"]',
        ));
        for (const btn of btns) {
          if (btn instanceof HTMLButtonElement || btn instanceof HTMLInputElement) {
            if (!btn.disabled) { btn.click(); return true; }
          }
        }
        return false;
      });
      if (result) await new Promise((r) => setTimeout(r, 2000));
      return result;
    },

    // Strategy 6: Third-party "Click here to enter <prize>" CTAs.
    // Customerfocus.co.uk (Take a Break Competitions), Loquax, MSE and
    // similar aggregators wrap entry submissions in plain <a> tags inside
    // the article container — not styled as buttons nor input[type=submit].
    // Earlier strategies only catch <button>, <a class="btn">, [role=button],
    // or input[type=button], so they miss these plain-anchor CTAs and the
    // enterer dies with "Could not find submit button".
    //
    // Two CDP round-trips total (not N per-handle round-trips): the first
    // harvests candidate text + href across all scope roots in one go; the
    // match runs Node-side through matchesEntryCta (unit-tested, no need
    // to re-inline the matcher in the browser context); the second
    // round-trip re-traverses in the SAME order and clicks the winner by
    // index, but only if the element at that index still has the same
    // visible text — a DOM-shift self-check that prevents the click from
    // firing on the wrong anchor if the page mutated between scans (e.g.
    // late hydration, ad injection). Total cost ≈ 2 round-trips × ~30ms
    // ≈ 60ms rather than N handles × 30ms (600ms–1s on a 20-anchor
    // customerfocus post).
    async () => {
      // Article-container scope. Plain anchors in nav/footer/sidebar
      // (which also contain verbs like "Contact" or "Submit a recipe")
      // don't appear in any of these roots, so they're filtered out
      // structurally before the matcher runs.
      //
      // The list covers:
      //   - Standard: <main>, <article>, [role=main]
      //   - WordPress (WordPress.org themes + Twenty*): .entry-content,
      //     .post-content, .post, .content, .single-content
      //   - Ghost + a number of WP magazine themes: .post-content, .post
      //   - Newspaper-style themes: .article-body, .article-content,
      //     [itemprop="articleBody"]
      //   - Webflow: .w-richtext, .rich-text
      //   - Generic CMS fallbacks: .page, .content
      //   - XenForo / forum software: .messageContent, .message-body, .post-body
      const SCOPE_SELECTORS: readonly string[] = [
        'main',
        'article',
        '[role="main"]',
        '.entry-content',
        '.post-content',
        '.post',
        '.content',
        '.page',
        '.article-body',
        '.article-content',
        '[itemprop="articleBody"]',
        '.single-content',
        '.w-richtext',
        '.rich-text',
        '.messageContent',       // XenForo
        '.message-body',          // XenForo alternate
        '.post-body',             // Generic forum
      ];

      // 1st round-trip: collect candidate (text, href) pairs in document
      // order. Empty-text candidates are skipped here so the index sequence
      // stays consistent with the click traversal below.
      const candidates = await page.evaluate((SCOPES: readonly string[]) => {
        const out: Array<{ text: string; href: string }> = [];
        for (const sel of SCOPES) {
          const roots = document.querySelectorAll(sel);
          for (const root of Array.from(roots)) {
            const els = root.querySelectorAll('a, button');
            for (const el of Array.from(els)) {
              const text = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
              if (!text) continue;
              out.push({ text, href: el.getAttribute('href') || '' });
            }
          }
        }
        return out;
      }, SCOPE_SELECTORS);

      // Node-side: find the first index where the matcher accepts the
      // visible text. This is where the unit-tested matcher logic runs,
      // not in the browser context — keeps the matcher testable.
      let winnerIdx = -1;
      for (let i = 0; i < candidates.length; i++) {
        if (matchesEntryCta(candidates[i].text.toLowerCase())) {
          winnerIdx = i;
          break;
        }
      }

      if (winnerIdx < 0) {
        botEvents.info('  ℹ️ No third-party entry CTA matched');
        return false;
      }

      // 2nd round-trip: re-traverse the scopes in the SAME order and
      // click the element whose index matches the winner, gated on the
      // currently-observed visible text matching what step 1 captured.
      // If the page mutated between step 1's collection and step 2's
      // click (hydration, lazy ad injection, the page-builder rewriting
      // anchor text), the index often points at a different element;
      // firing .click() at the wrong anchor is unsafe, so we abort.
      const expectedText = candidates[winnerIdx].text;
      const winner = await page.evaluate(({ SCOPES, idx, expectedText }: { SCOPES: readonly string[]; idx: number; expectedText: string }) => {
        let cur = 0;
        for (const sel of SCOPES) {
          const roots = document.querySelectorAll(sel);
          for (const root of Array.from(roots)) {
            const els = root.querySelectorAll('a, button');
            for (const el of Array.from(els)) {
              const text = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
              if (!text) continue;
              if (cur === idx) {
                if (text !== expectedText) {
                  // DOM-shift self-check failed. Don't fire the click —
                  // surfacing the diagnostic to the activity feed happens
                  // back in Node so the botEvents bus sees the actual
                  // observed text.
                  return { clicked: false, text, href: '', mismatch: true };
                }
                (el as HTMLElement).click();
                return { clicked: true, text, href: el.getAttribute('href') || '' };
              }
              cur++;
            }
          }
        }
        return { clicked: false, text: '', href: '', mismatch: false };
      }, { SCOPES: SCOPE_SELECTORS, idx: winnerIdx, expectedText });

      if (winner.mismatch) {
        botEvents.info(
          `  ⚠️ DOM shifted during CTA scan — index ${winnerIdx} now matches "${winner.text}", expected "${expectedText}". Skipping click.`,
        );
        return false;
      }

      if (!winner.clicked) {
        botEvents.info('  ⚠️ Entry CTA index out of range (DOM shifted beyond scans)');
        return false;
      }

      botEvents.info(`  🎯 Clicked entry CTA: "${winner.text.trim()}" → ${winner.href}`);
      await new Promise((r) => setTimeout(r, 2000));
      return true;
    },

    // Strategy 7: LLM fallback — ask the model what to do
    async () => {
      botEvents.enterStart(`${competitionTitle} — asking LLM how to submit`);
      const currentHtml = await page.evaluate(() => document.body?.innerHTML?.slice(0, 5000) || '');
      const currentText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '');
      const advice = await analyseSubmitAction(provider, currentHtml, currentText, competitionTitle);

      if (advice.action === 'click_button' || advice.action === 'click_element') {
        if (advice.selector) {
          const clicked = await page.evaluate((sel) => {
            const el = document.querySelector<HTMLElement>(sel);
            if (el) { el.click(); return true; }
            return false;
          }, advice.selector);
          if (clicked) {
            await new Promise((r) => setTimeout(r, 3000));
            return true;
          }
        }
      } else if (advice.action === 'scroll_to_submit') {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise((r) => setTimeout(r, 2000));
        const clicked = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll<HTMLElement>('button'));
          for (const btn of btns) {
            if (btn instanceof HTMLButtonElement || btn instanceof HTMLInputElement) {
              if (!btn.disabled) { btn.click(); return true; }
            }
          }
          return false;
        });
        if (clicked) {
          await new Promise((r) => setTimeout(r, 3000));
          return true;
        }
      } else if (advice.action === 'fill_field' && advice.selector && advice.value) {
        await page.evaluate(({ sel, val }) => {
          const el = document.querySelector<HTMLInputElement>(sel);
          if (el) {
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, { sel: advice.selector, val: advice.value });
        await new Promise((r) => setTimeout(r, 1000));
        const retry = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll<HTMLElement>(
            'button[type="submit"], input[type="submit"]'
          ));
          for (const btn of btns) {
            if (btn instanceof HTMLButtonElement || btn instanceof HTMLInputElement) {
              if (!btn.disabled) { btn.click(); return true; }
            }
          }
          return false;
        });
        if (retry) {
          await new Promise((r) => setTimeout(r, 3000));
          return true;
        }
      } else if (advice.action === 'press_enter') {
        await page.keyboard.press('Enter');
        await new Promise((r) => setTimeout(r, 3000));
        return true;
      } else if (advice.action === 'complete') {
        return true;
      }

      return false;
    },
  ];

  for (let i = 0; i < strategies.length; i++) {
    try {
      const ok = await strategies[i]();
      if (ok) {
        if (await checkSuccess(page)) return true;
        // If strategy returned true but no success message yet, keep trying
      }
    } catch {
      // Strategy failed silently — try next one
    }
  }

  return false;
}

// ── Text CAPTCHA solving ────────────────────────────────────────────

/**
 * Scan the page for simple text-based CAPTCHAs / anti-spam questions
 * that an LLM can trivially answer, and fill them in.
 *
 * Handles patterns like:
 *   "What is 3 + 5?"
 *   "Enter the code shown: ABC123"
 *   "What colour is the sky?"
 *   "Type the word: SUNSHINE"
 *   Any input near a label containing "captcha", "code", "verify", "anti-spam", etc.
 */
async function solveTextCaptcha(
  page: PlaywrightPage,
  provider: LlmProvider,
  competitionTitle: string,
  pageText: string,
): Promise<void> {
  // First, find any text input near a CAPTCHA-like label
  const captchaField = await page.evaluate(() => {
    const captchaKeywords = ['captcha', 'anti-spam', 'antispam', 'verification', 'verify you\'re human', 'prove you\'re human', 'are you human', 'security check', 'enter the code', 'type the code', 'type the word', 'enter code', 'what is'];

    // Check labels
    const labels = Array.from(document.querySelectorAll<HTMLElement>('label, span, div, p, strong'));
    for (const el of labels) {
      const text = el.innerText?.toLowerCase().trim();
      if (!text) continue;
      if (captchaKeywords.some((kw) => text.includes(kw))) {
        // Found a CAPTCHA-like label. Look for the nearest text input.
        const input = el.closest('div, form, section, li, p')?.querySelector<HTMLInputElement>(
          'input[type="text"], input:not([type]), input[type="tel"], input[type="number"]',
        );
        if (input) {
          return {
            found: true,
            label: el.innerText.trim(),
            name: input.name || input.id || '',
          };
        }
      }
    }

    // Also check placeholders on text inputs
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(
      'input[type="text"], input:not([type]), input[type="tel"], input[type="number"]',
    ));
    for (const input of inputs) {
      const placeholder = (input.placeholder || '').toLowerCase();
      if (placeholder && captchaKeywords.some((kw) => placeholder.includes(kw))) {
        const parentText = input.closest('div, form, section, li, p')?.textContent || '';
        return {
          found: true,
          label: parentText.trim().slice(0, 200),
          name: input.name || input.id || '',
        };
      }
    }

    return { found: false, label: '', name: '' };
  });

  if (!captchaField.found) return;

  botEvents.info('  🔢 Text-based CAPTCHA detected — asking LLM to solve');

  // Build prompt: give the LLM the label text and nearby page context
  const systemPrompt = `You are solving a simple anti-spam question or text CAPTCHA on a competition entry form.

Your job:
- Look at the question/label text and any nearby context
- Answer the question directly and accurately
- If it's a math question, compute the answer
- If it asks you to type a code or word shown on the page, extract it from the context
- If it's a common-sense question (e.g. "what colour is the sky?"), give the obvious answer

Return ONLY the answer — no explanation, no quotes, just the value to type into the field.`;

  const userPrompt = `Competition: ${competitionTitle}

Question/label on the page:
"${captchaField.label}"

Nearby page context:
${pageText.slice(0, 1000)}

What should be entered in this CAPTCHA field? Return ONLY the exact value to type, nothing else.`;

  try {
    const answer = await askLlm(provider, systemPrompt, userPrompt);
    const cleaned = answer.trim().replace(/^["'\s]+|["'\s]+$/g, '');

    if (cleaned && cleaned.length < 100) {
      // Try to fill by name/id first, then by proximity
      if (captchaField.name) {
        await fillField(page, {
          name: captchaField.name,
          type: 'text',
          label: captchaField.label,
        }, cleaned);
      } else {
        // Fallback: find input nearest to the label text
        await page.evaluate((answer: string) => {
          const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(
            'input[type="text"], input:not([type]), input[type="tel"], input[type="number"]',
          ));
          if (inputs.length > 0) {
            const last = inputs[inputs.length - 1];
            last.value = answer;
            last.dispatchEvent(new Event('input', { bubbles: true }));
            last.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, cleaned);
      }

      botEvents.info(`  ✅ LLM solved text CAPTCHA: "${cleaned.slice(0, 50)}"`);
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (err) {
    // LLM failed to solve — continue without it
    botEvents.info('  ⚠️ Could not solve text CAPTCHA with LLM — continuing anyway');
  }
}

// ── Field value determination ─────────────────────────────────────────

async function determineFieldValue(
  field: AnalysedField,
  provider: LlmProvider,
  competitionTitle: string,
  /** Full page content with prize context scraped from the competition page. */
  pageContext?: string,
): Promise<string | undefined> {
  const label = field.label.toLowerCase();
  const name = field.name.toLowerCase();

  // Skip checkbox/radio here — they're handled separately in the consent loop
  if (field.type === 'checkbox') return '__SKIP__';
  if (field.type === 'radio') return '__SKIP__';

  // ── Attempt profile-field match first ────────────────────────────
  const profileFields = get().all<ProfileField>(
    'SELECT field_key, field_label, field_value FROM profile_fields WHERE field_value != ?',
    [''],
  );

  const combined = `${label} ${name} ${field.type}`;

  for (const pf of profileFields) {
    const aliases = FIELD_LOOKUP.get(pf.field_key) || [pf.field_key.replace(/_/g, ' '), pf.field_key];
    for (const alias of aliases) {
      if (combined.includes(alias)) {
        return pf.field_value;
      }
    }
  }

  // ── Select/dropdown — use LLM to pick the right option ──────────
  if (field.type === 'select' && field.options && field.options.length > 0) {
    return await chooseSelectOption(provider, field.label || field.name, field.options, competitionTitle);
  }

  // ── Competition question — use LLM with full page context ────────
  if (field.question) {
    return await answerQuestion(provider, field.question, competitionTitle, pageContext);
  }

  // ── LLM-powered free-text answer for open-ended fields ───────────
  if (field.type === 'textarea' || field.type === 'text') {
    const questionLike = ['why', 'tell us', 'describe', 'what', 'how', 'explain', 'your thoughts', 'comment'];
    if (questionLike.some((q) => label.includes(q))) {
      return await answerQuestion(provider, field.label || field.name, competitionTitle, pageContext);
    }
  }

  // ── Date field fallback ──────────────────────────────────────────
  if (field.type === 'date' || combined.includes('date') || combined.includes('dob') || combined.includes('birth')) {
    const dob = profileFields.find((p) => p.field_key === 'date_of_birth');
    return dob?.field_value || '1990-01-15';
  }

  // ── For select without options from LLM, try profile field values ──
  if (field.type === 'select') {
    for (const pf of profileFields) {
      if (combined.includes(pf.field_key.replace(/_/g, ' '))) {
        return pf.field_value;
      }
    }
    return 'Yes';
  }

  // Unknown — skip
  return undefined;
}

// ── Field filling ─────────────────────────────────────────────────────

async function fillField(page: PlaywrightPage, field: AnalysedField, value: string): Promise<void> {
  const fieldName = field.name;
  const selectors = [
    `input[name="${fieldName}"]`,
    `input[id="${fieldName}"]`,
    `input[placeholder*="${fieldName}"]`,
    `textarea[name="${fieldName}"]`,
    `textarea[id="${fieldName}"]`,
    `select[name="${fieldName}"]`,
    `#${fieldName}`,
    `[name="${fieldName}"]`,
    `input[name*="${fieldName.replace(/[^a-zA-Z0-9]/g, '')}"]`,
  ];

  for (const selector of selectors) {
    const el = await page.$(selector);
    if (el) {
      const tagName = await el.evaluate((e) => e.tagName.toLowerCase());

      if (tagName === 'select') {
        try {
          await el.selectOption(value);
        } catch {
          // If value isn't an option, try selecting the first non-empty option
          const optionCount = await page.evaluate((sel) => {
            const s = document.querySelector<HTMLSelectElement>(sel);
            return s?.options.length || 0;
          }, selector);
          if (optionCount > 1) {
            await page.evaluate((sel) => {
              const s = document.querySelector<HTMLSelectElement>(sel);
              if (s && s.options.length > 1) {
                s.selectedIndex = 1;
                s.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, selector);
          }
        }
        // Dispatch events for JS validation
        await page.evaluate((sel) => {
          const s = document.querySelector<HTMLSelectElement>(sel);
          if (s) {
            s.dispatchEvent(new Event('input', { bubbles: true }));
            s.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, selector);

      } else if (tagName === 'textarea') {
        await el.click();
        await el.type(value, { delay: 30 });

        // Set value directly and dispatch events (triggers JS validation listeners)
        await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
          const e = document.querySelector<HTMLTextAreaElement>(sel);
          if (e) {
            e.value = val;
            e.dispatchEvent(new Event('input', { bubbles: true }));
            e.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, { sel: selector, val: value });

      } else {
        await el.click();
        await el.type(value, { delay: 30 });

        // Set value directly and dispatch events (triggers JS validation listeners)
        await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
          const e = document.querySelector<HTMLInputElement>(sel);
          if (e) {
            e.value = val;
            e.dispatchEvent(new Event('input', { bubbles: true }));
            e.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, { sel: selector, val: value });
      }
      return;
    }
  }
}
