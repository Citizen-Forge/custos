import { get } from '../db/db.js';
import { newPage } from './browser.js';
import { analyseFormFields, answerQuestion, analyseSubmitAction, chooseSelectOption } from '../llm/client.js';
import { matchesEntryCta } from './cta-match.js';
import type { LlmProvider } from '../config/types.js';
import type { AnalysedField } from '../llm/client.js';
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
    await page.goto(competition.url, { waitUntil: 'networkidle2', timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 2000));

    // ── CAPTCHA detection ────────────────────────────────────────────
    const hasCaptcha = await page.evaluate(() => {
      const body = document.body?.innerHTML?.toLowerCase() || '';
      return (
        body.includes('recaptcha') ||
        body.includes('hcaptcha') ||
        body.includes('g-recaptcha') ||
        body.includes('cf-turnstile') ||
        document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, div[class*="captcha"]') !== null
      );
    });

    if (hasCaptcha) {
      throw new Error('CAPTCHA detected — cannot enter automatically');
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
    const submitted = await submitForm(page, provider, competition.title, pageContent, pageHtml);      if (!submitted) {
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
async function checkSuccess(page: import('puppeteer').Page): Promise<boolean> {
  const text = await page.evaluate(() => document.body?.innerText?.toLowerCase() || '');
  return SUCCESS_PHRASES.some((p) => text.includes(p));
}

/**
 * Attempt to submit the form using multiple strategies in order.
 * Returns true if any strategy appeared to succeed.
 */
async function submitForm(
  page: import('puppeteer').Page,
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

    // Strategy 6b: Third-party "Click here to enter <prize>" CTAs.
    // Customerfocus.co.uk (Take a Break Competitions), Loquax, MSE and
    // similar aggregators wrap entry submissions in plain <a> tags inside
    // the article container — not styled as buttons nor input[type=submit].
    // Earlier strategies only catch <button>, <a class="btn">, [role=button],
    // or input[type=button], so they miss these plain-anchor CTAs and the
    // enterer dies with "Could not find submit button". Adds them explicitly
    // to the candidate pool so the "click here to enter" link on the page
    // gets matched and clicked.
    async () => {
      // Scope to article containers so plain anchors in nav/footer/sidebar
      // (which also tend to contain verbs like "Contact" or "Submit a
      // recipe") don't false-positive on the CTA matcher.
      const SCOPE_SELECTORS = [
        'main',
        'article',
        '[role="main"]',
        '.entry-content',
        '.post-content',
        '.post',
        '.content',
        '.page',
      ];
      const handles = await page.$$(
        SCOPE_SELECTORS.map((s) => `${s} a`).join(', ') + ', a.btn, a.button',
      );
      for (const h of handles) {
        const info = await h.evaluate((el: Element) => {
          const a = el as HTMLAnchorElement;
          return {
            text: (a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '').trim(),
            href: a.getAttribute('href') || '',
          };
        });
        if (!info.text) continue;
        if (matchesEntryCta(info.text.toLowerCase())) {
          await h.click();
          botEvents.info(`  🎯 Clicked entry CTA: "${info.text}" → ${info.href}`);
          await new Promise((r) => setTimeout(r, 2000));
          return true;
        }
      }
      botEvents.info('  ℹ️ No third-party entry CTA matched');
      return false;
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

async function fillField(page: import('puppeteer').Page, field: AnalysedField, value: string): Promise<void> {
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
          await el.select(value);
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
        await page.evaluate((sel, val) => {
          const e = document.querySelector<HTMLTextAreaElement>(sel);
          if (e) {
            e.value = val;
            e.dispatchEvent(new Event('input', { bubbles: true }));
            e.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, selector, value);

      } else {
        await el.click();
        await el.type(value, { delay: 30 });

        // Set value directly and dispatch events (triggers JS validation listeners)
        await page.evaluate((sel, val) => {
          const e = document.querySelector<HTMLInputElement>(sel);
          if (e) {
            e.value = val;
            e.dispatchEvent(new Event('input', { bubbles: true }));
            e.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, selector, value);
      }
      return;
    }
  }
}
