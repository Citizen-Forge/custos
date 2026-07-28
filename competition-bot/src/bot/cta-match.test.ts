import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesEntryCta } from './cta-match.js';

// ── High-confidence phrase matches ────────────────────────────────────

test('matches "Click here to enter" with no prize suffix', () => {
  assert.equal(matchesEntryCta('Click here to enter'), true);
});

test('matches "Click here to enter" with prize-suffix padding', () => {
  assert.equal(matchesEntryCta('Click here to enter £250 cash draw'), true);
  assert.equal(matchesEntryCta('CLICK HERE TO ENTER Money Pot'), true);
  assert.equal(matchesEntryCta('Click here to enter Ticket X'), true);
});

test('matches "Click here to play" with optional padding', () => {
  assert.equal(matchesEntryCta('Click here to play'), true);
  assert.equal(matchesEntryCta('Click here to play the bonus round'), true);
});

test('matches "Enter to win" and similar entry CTAs', () => {
  assert.equal(matchesEntryCta('Enter to win'), true);
  assert.equal(matchesEntryCta('Enter competition'), true);
  assert.equal(matchesEntryCta('Enter now'), true);
  assert.equal(matchesEntryCta('Enter this competition'), true);
  assert.equal(matchesEntryCta('Enter for your chance to win'), true);
});

test('matches "Submit entry" and "I want to win" CTAs', () => {
  assert.equal(matchesEntryCta('Submit entry'), true);
  assert.equal(matchesEntryCta('Submit my entry'), true);
  assert.equal(matchesEntryCta('I want to win'), true);
});

// ── Direct-verb fallbacks (short text only) ────────────────────────────

test('bare-verb fallback matches short lowercase labels', () => {
  assert.equal(matchesEntryCta('enter'), true);
  assert.equal(matchesEntryCta('Enter'), true);
  assert.equal(matchesEntryCta('SUBMIT'), true);
  assert.equal(matchesEntryCta('Play'), true);
});

test('bare-verb fallback rejects long strings', () => {
  // "Enter" alone is a direct-verb match; long sentences containing those
  // words should NOT match because the CTA scope (article container)
  // already filters nav/footer anchors, and the matcher must not be
  // fooled by arbitrary link text like "Enterprise newsletter" or
  // "Submit a press request".
  assert.equal(matchesEntryCta('Enterprise newsletter signup'), false);
  assert.equal(matchesEntryCta('Submit a press request'), false);
  assert.equal(matchesEntryCta('Please contact our support team for further help'), false);
});

// ── Negative cases ────────────────────────────────────────────────────

test('rejects nav/footer-style text', () => {
  assert.equal(matchesEntryCta('About Us'), false);
  assert.equal(matchesEntryCta('Privacy Policy'), false);
  assert.equal(matchesEntryCta('Terms and Conditions'), false);
  assert.equal(matchesEntryCta('Contact'), false);
  assert.equal(matchesEntryCta('Home'), false);
  assert.equal(matchesEntryCta('Read more'), false);
  assert.equal(matchesEntryCta('Subscribe to newsletter'), false);
  assert.equal(matchesEntryCta('Share this article'), false);
});

test('rejects empty / whitespace-only / non-string inputs gracefully', () => {
  assert.equal(matchesEntryCta(''), false);
  assert.equal(matchesEntryCta('   '), false);
});

test('rejects text where "enter" appears in a non-entry context', () => {
  // "ENTER key" is keyboard documentation, not a CTA.
  assert.equal(matchesEntryCta('Press ENTER key to continue'), false);
  // "center" contains "enter" but isn't an entry CTA.
  assert.equal(matchesEntryCta('Community center opens next month'), false);
});

// ── Case insensitivity ───────────────────────────────────────────────

test('is case-insensitive on input', () => {
  assert.equal(matchesEntryCta('CLICK HERE TO ENTER'), true);
  assert.equal(matchesEntryCta('cLiCk HeRe tO EnTeR Your Bonus Round'), true);
});

// ── Whitespace robustness ─────────────────────────────────────────────

test('trims surrounding whitespace before matching', () => {
  assert.equal(matchesEntryCta('   click here to enter   '), true);
  assert.equal(matchesEntryCta('\n\tClick here to enter £10  \n'), true);
});
