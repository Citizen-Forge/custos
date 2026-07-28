/**
 * Recognise the visible text of a clickable element as an entry/competition
 * submission CTA. Used by the bot to detect "Click here to enter <prize>"
 * style buttons on aggregators like customerfocus.co.uk (Take a Break
 * Competitions), Loquax, and MSE, which wrap entry submissions in plain
 * <a> tags whose visible text is not "Submit" but a CTA phrase.
 *
 * Why a dedicated matcher rather than extending the existing submit-form
 * strategy: plain anchors cannot be reliably distinguished from layout
 * anchors without scoping to article containers. This matcher sits behind
 * that scope (set by the calling strategy) and returns true only when the
 * visible text reads like an entry CTA — substring pads from the prize
 * name are tolerated, but random anchors that incidentally contain
 * "enter"/"submit" are filtered by length.
 */

/**
 * High-confidence CTA phrases. Matched as substrings against the lowercased
 * visible text of a clickable element; the surrounding prize name is
 * tolerated because vendors pad the button text with the prize
 * (e.g. "Click here to enter £250 cash draw").
 */
const ENTRY_CTA_PATTERNS: readonly string[] = [
  'click here to enter',
  'click here to play',
  'click to enter',
  'click to play',
  'click here for your chance',
  'enter competition',
  'enter this competition',
  'enter this prize',
  'enter this draw',
  'enter now',
  'enter to win',
  'enter for your chance',
  'submit entry',
  'submit my entry',
  'i want to win',
  'play to win',
  'start now',
];

/**
 * Direct-verb fallbacks — match the entire lowercased text against one of
 * these tokens. Catches sites that label the button with the action verb
 * only ("Enter", "Play"). Constrained to short strings so a long anchor
 * like "Visit our enterprise newsletter" doesn't trigger on 'enter'.
 */
const DIRECT_VERB_TOKENS: readonly string[] = ['enter', 'submit', 'play'];

/**
 * Returns true when the visible text of a clickable element reads like an
 * entry/competition submission CTA. Substring matching against
 * ENTRY_CTA_PATTERNS catches the padded variants; the DIRECT_VERB_TOKENS
 * fallback catches the bare-button case for sites that label the entry
 * button with just "Enter" or "Play".
 *
 * @param text Visible text of the clickable element (already lowercased).
 * @returns true if `text` describes an entry/competition submission CTA.
 */
export function matchesEntryCta(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;

  for (const phrase of ENTRY_CTA_PATTERNS) {
    if (t.includes(phrase)) return true;
  }

  // Bare-verb fallback — bounded to short strings so anchors with a lot
  // of supplementary text don't false-positive on "enter" or "submit".
  if (t.length <= 12 && DIRECT_VERB_TOKENS.includes(t)) return true;

  return false;
}
