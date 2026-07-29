import { get } from '../db/db.js';
import { newPage } from './browser.js';
import { askLlm } from '../llm/client.js';
import { botEvents } from '../events.js';
import { connectRandom, disconnect, getStatus } from '../vpn/manager.js';
import type { Competition, LlmProvider } from '../config/types.js';

// Common nav / noise link text that is clearly NOT a competition
const NOISE_PATTERNS = [
  'skip to', 'log in', 'login', 'sign in', 'sign up', 'register',
  'menu', 'cart', 'basket', 'account', 'my account', 'profile',
  'settings', 'help', 'faq', 'contact', 'about', 'about us',
  'privacy', 'privacy policy', 'terms', 'terms of', 'cookies',
  'search', 'facebook', 'twitter', 'instagram', 'youtube', 'tiktok',
  'share', 'follow', 'subscribe', 'newsletter', 'email', 'phone',
  'advertise', 'careers', 'jobs', 'sitemap', 'accessibility',
  'home', 'back to', 'go back', 'previous', 'next', 'page',
  'reviews', 'rating', 'stars',
];

// Strong prize signals — a link matching ANY of these is a competition
const STRONG_PRIZE_MARKERS = [
  /enter\s+to\s+win/i,
  /enter\s+(now|today|here|free)/i,
  /\bwin\s+(a|an|the|this|our|your|my|\$|£|€|free)/i,
  /^win\s/i,
  /\bprize\s+draw\b/i,
  /\bgiveaway\b/i,
  /sweepstake/i,
  /\bcompetition\b/i,
  /\benter\s+(our|this|the|a)\s+(competition|prize|giveaway|draw)\b/i,
  /click\s+(here\s+)?to\s+(enter|win)/i,
  /\bcomp\s+of\s+the\s+(week|month|day)\b/i,
  /\bfree\s+(to\s+)?(enter|win)\b/i,
];

// Weaker prize signals — need at least 2 to count
const WEAK_PRIZE_MARKERS = [
  /\bprize\b/i,
  /\bwin\b/i,
  /\benter\b/i,
  /\bwinner\b/i,
  /\bwinners\b/i,
  /\bwinning\b/i,
  /free\b/i,
  /\bdrawn?\b/i,
  /\blucky\b/i,
  /\bchance\s+to\s+win\b/i,
  /\bcompetition\b/i,
  /\bcomp\b/i,
];

// URL path patterns that suggest a competition
const PRIZE_URL_PATTERNS = [
  /\/competition/i,
  /\/comp\//i,
  /\/prize/i,
  /\/win/i,
  /\/enter/i,
  /\/giveaway/i,
  /\/sweepstake/i,
  /\/draw/i,
  /\/contest/i,
  /\/lucky/i,
  /\/free/i,
];

/**
 * Score a link's text and href for how likely it is to be a competition.
 * Returns a score (0-10+). Only links with score >= threshold are kept.
 */
function scoreLink(text: string, href: string): number {
  const t = text.toLowerCase().trim();
  const h = href.toLowerCase();

  // Strong match → immediate pass (score 10)
  for (const pat of STRONG_PRIZE_MARKERS) {
    if (pat.test(t) || pat.test(h)) return 10;
  }

  // Noise match → immediate fail
  for (const noise of NOISE_PATTERNS) {
    if (t.includes(noise) && t.length < 30) return -1;
  }

  // Skip single-word links (common in nav: "Home", "Prizes", "Contact")
  if (t.split(/\s+/).length <= 1 && t.length < 15 && !PRIZE_URL_PATTERNS.some((p) => p.test(h))) {
    return -1;
  }

  let score = 0;

  // URL pattern match
  for (const pat of PRIZE_URL_PATTERNS) {
    if (pat.test(h)) score += 4;
  }

  // Count weak matches in text
  for (const pat of WEAK_PRIZE_MARKERS) {
    if (pat.test(t)) score += 1;
  }

  // Longer text is more likely a real competition (vs nav link)
  if (t.length > 40) score += 1;
  if (t.length > 20) score += 1;

  // Contains numbers (e.g. "Win an iPhone 15" or "Top 10 prizes")
  if (/\d/.test(t)) score += 1;

  // Contains monetary symbols
  if (/[\$£€]/.test(t)) score += 2;

  // URL looks like a product or article page (not nav/static)
  if (/\/[\w-]{10,}/.test(h)) score += 1;

  return score;
}

/**
 * Scan a single competition page for competition links/entries.
 * Returns newly found competitions (not already in the DB).
 */
export async function scanPage(pageId: number): Promise<Competition[]> {
  // Check if LLM verification is enabled
  const verifySetting = get().get<{ value: string }>("SELECT value FROM settings WHERE key = 'llm_verification_enabled'");
  const llmVerifyEnabled = verifySetting?.value === 'true';
  const pageRow = get().get<{ id: number; name: string; url: string }>(
    'SELECT * FROM competition_pages WHERE id = ? AND enabled = 1',
    [pageId],
  );
  if (!pageRow) return [];

  // ── VPN: Connect before scanning if enabled ──────────────────────
  const vpnEnabled = get().get<{ value: string }>("SELECT value FROM settings WHERE key = 'vpn_enabled'");
  const useVpn = vpnEnabled?.value === 'true';
  let vpnConnected = false;
  if (useVpn) {
    const status = await getStatus();
    if (!status.connected) {
      botEvents.info('  🔐 Connecting VPN before scan...');
      vpnConnected = (await connectRandom()) !== null;
      if (vpnConnected) {
        botEvents.info('  ✅ VPN connected — scan traffic will use VPN IP');
      } else {
        botEvents.info('  ⚠️ VPN connect failed — scanning without VPN');
      }
    } else {
      botEvents.info(`  🔐 Already connected via VPN (${status.configLabel || status.serverIp || 'unknown'})`);
    }
  }

  // Load exclusion keywords
  const keywordRows = get().all<{ keyword: string }>('SELECT keyword FROM exclusion_keywords');
  const keywords = keywordRows.map((r) => r.keyword.toLowerCase());

  const existingRows = get().all<{ url: string }>('SELECT url FROM competitions WHERE page_id = ?', [pageId]);
  const existingUrls = new Set(existingRows.map((r) => r.url));

  let found: Competition[] = [];
  const page = await newPage();

  // Load the configured LLM provider for verification (if enabled)
  let verifyProvider: LlmProvider | null = null;
  if (llmVerifyEnabled) {
    const providerIdRow = get().get<{ value: string }>("SELECT value FROM settings WHERE key = 'verification_provider_id'");
    const providerId = providerIdRow?.value ? Number(providerIdRow.value) : 0;
    if (providerId > 0) {
      const row = get().get<LlmProvider>('SELECT * FROM llm_providers WHERE id = ?', [providerId]);
      if (row) {
        verifyProvider = row as LlmProvider;
      } else {
        botEvents.info('⚠️ Verification provider not found — falling back to heuristic');
      }
    } else {
      // No specific provider set — use the first one as fallback
      const row = get().get<LlmProvider>('SELECT * FROM llm_providers ORDER BY id ASC LIMIT 1');
      if (row) {
        verifyProvider = row as LlmProvider;
        botEvents.info(`  ℹ️ No verification provider selected — using "${row.name}" (first configured provider)`);
      } else {
        botEvents.info('⚠️ LLM verification enabled but no LLM provider configured — falling back to heuristic');
      }
    }
  }

  try {
    await page.goto(pageRow.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 2000));

    // Get all links with their nav/footer context
    const links = await page.evaluate(() => {
      const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]');
      return Array.from(anchors).map((a) => {
        // Check if the link is inside nav, footer, or header
        const inNav = !!a.closest('nav, footer, .nav, .navbar, .footer, .header, .sidebar, .menu');
        return {
          href: a.href,
          text: a.innerText?.trim() || '',
          inNav,
        };
      });
    });

    const pageTitle = await page.title();
    const mainContent = await page.evaluate(() => {
      const article = document.querySelector('article')?.innerText ||
        document.querySelector('main')?.innerText ||
        document.body?.innerText ||
        '';
      return article.slice(0, 3000);
    });

    // Score and filter links
    for (const link of links) {
      if (existingUrls.has(link.href)) continue;
      if (!link.text) continue;

      const text = link.text.slice(0, 200);
      const score = scoreLink(text, link.href);

      // Penalize links in nav/footer
      const effectiveScore = link.inNav ? Math.min(score, 3) : score;

      // Minimum threshold — require score >= 4
      if (effectiveScore < 4) continue;

      const excludeReason = checkExclusion(text, keywords);
      if (excludeReason) {
        found.push({
          pageId: pageRow.id,
          title: text,
          url: link.href,
          sourcePageUrl: pageRow.url,
          description: '',
          requiresQuestions: false,
          status: 'excluded',
          exclusionReason: excludeReason,
        });
        continue;
      }

      found.push({
        pageId: pageRow.id,
        title: text,
        url: link.href,
        sourcePageUrl: pageRow.url,
        description: '',
        requiresQuestions: false,
        status: 'found',
        exclusionReason: '',
      });
    }

    // If no candidates found, check if the page itself is a prize page
    if (found.length === 0 && scoreLink(pageTitle, pageRow.url) >= 4) {
      if (!existingUrls.has(pageRow.url)) {
        const excludeReason = checkExclusion(pageTitle + ' ' + mainContent, keywords);
        if (!excludeReason) {
          found.push({
            pageId: pageRow.id,
            title: pageTitle || pageRow.name,
            url: pageRow.url,
            sourcePageUrl: pageRow.url,
            description: mainContent.slice(0, 500),
            requiresQuestions: false,
            status: 'found',
            exclusionReason: '',
          });
        }
      }
    }

    botEvents.scanProgress(pageRow.name, found.length);

    // ── LLM verification step ───────────────────────────────────────
    if (llmVerifyEnabled && verifyProvider && found.length > 0) {
      botEvents.verifyStart(pageRow.name);
      const approvedIndices = await verifyLinksWithLLM(verifyProvider, found, pageTitle, pageRow.url, mainContent);
      if (approvedIndices !== null) {
        const before = found.length;
        found = found.filter((_, i) => approvedIndices.has(i));
        const rejected = before - found.length;
        if (rejected > 0) {
          botEvents.verifyProgress(pageRow.name, found.length, before);
        } else {
          botEvents.verifyProgress(pageRow.name, found.length, before);
        }
      } else {
        botEvents.info(`⚠️ LLM verification failed for "${pageRow.name}" — keeping all heuristic results`);
      }
    }

    if (found.length > 0) {
      get().transaction(() => {
        for (const item of found) {
          get().run(
            'INSERT INTO competitions (page_id, title, url, source_page_url, description, requires_questions, status, exclusion_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [item.pageId, item.title, item.url, item.sourcePageUrl, item.description, item.requiresQuestions ? 1 : 0, item.status, item.exclusionReason],
          );
        }
      });
      get().save();
    } else {
      botEvents.info(`  ℹ️ No competitions found on "${pageRow.name}"`);
    }
  } finally {
    await page.close();
  }

  // ── VPN: Disconnect after scanning if we connected ─────────────
  if (vpnConnected) {
    botEvents.info('  🔐 Disconnecting VPN after scan...');
    await disconnect();
  }

  return found;
}

function checkExclusion(text: string, keywords: string[]): string | null {
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      return `Excluded by keyword: "${kw}"`;
    }
  }
  return null;
}

/**
 * Send candidate competition links to the LLM for verification.
 * Returns a Set of indices that the LLM considers real competitions,
 * or null if the LLM call failed (caller falls back to heuristic results).
 */
async function verifyLinksWithLLM(
  provider: LlmProvider,
  candidates: Competition[],
  pageTitle: string,
  pageUrl: string,
  mainContent: string,
): Promise<Set<number> | null> {
  if (candidates.length === 0) return new Set<number>();

  const systemPrompt = `You are a competition detection assistant. You scan lists of links found on a web page and identify which ones are genuine prize competitions, giveaways, or sweepstakes.

A genuine competition:
- Offers a chance to win a prize (money, physical goods, gift cards, experiences)
- Requires the user to enter (fill a form, answer a question, etc.)
- Is typically something like "Win an iPhone", "Prize Draw", "Enter to Win £1000", etc.

NOT a competition:
- Navigation links ("Home", "About Us", "Contact", "FAQ", "Skip to content")
- Login/signup links
- Social media links (Facebook, Instagram, Twitter, TikTok)
- Generic category or tag pages
- Article or blog post links (unless they clearly describe a competition)
- Advertisements or sponsored content
- Product listing or shopping pages

You will receive:
1. The page title and URL (for context about what site you're on)
2. A brief excerpt of the page's main content (for context)
3. A list of candidate links with their displayed text and URL

Return ONLY a valid JSON array of the index numbers that are genuine competitions.
Example: [0, 3, 7]
If none are competitions, return an empty array: []
Do not include any other text in your response.`;

  const linksFormatted = candidates
    .map((c, i) => `[${i}] "${c.title}" — ${c.url}`)
    .join('\n');

  const contextExcerpt = mainContent.slice(0, 2000);

  const userPrompt = `Page: "${pageTitle}"
URL: ${pageUrl}

Page content (excerpt):
${contextExcerpt}

Candidate links:
${linksFormatted}

Return a JSON array of the index numbers that are genuine competitions:`;

  try {
    const raw = await askLlm(provider, systemPrompt, userPrompt);
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn('LLM verification: no JSON array in response:', raw.slice(0, 200));
      return null;
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      console.warn('LLM verification: response is not an array:', raw.slice(0, 200));
      return null;
    }
    // Validate — only keep valid indices
    const valid = new Set<number>();
    for (const idx of parsed) {
      if (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < candidates.length) {
        valid.add(idx);
      }
    }
    return valid;
  } catch (err) {
    console.warn('LLM verification failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
