import OpenAI from 'openai';
import type { LlmProvider } from '../config/types.js';
import { RpmThrottle } from './throttle.js';

const throttle = new RpmThrottle();

/**
 * Ask an LLM provider a question and return the text answer.
 * Automatically respects per-provider RPM limits via the sliding window.
 */
export async function askLlm(
  provider: LlmProvider,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  await throttle.waitForSlot(provider);

  const client = openAIClient(provider);

  const completion = await client.chat.completions.create({
    model: provider.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 1024,
  });

  const text = completion.choices?.[0]?.message?.content?.trim() ?? '';
  return text;
}

function openAIClient(provider: LlmProvider) {
  return new OpenAI({
    baseURL: provider.base_url,
    apiKey: provider.api_key || 'sk-dummy',
  });
}

/** A single form field the LLM identified. */
export interface AnalysedField {
  name: string;
  type: string;
  label: string;
  question?: string;
  /** Available options for select/radio fields — the LLM extracts these so we can pick intelligently. */
  options?: string[];
}

/** How to submit the form — the LLM analyses this from the page. */
export interface SubmitStrategy {
  /** What kind of trigger reveals / activates the submit button. */
  type: 'direct' | 'hidden_until_filled' | 'multi_step' | 'scroll' | 'js_button' | 'unknown';
  /** CSS selector hint if one was found. */
  selector?: string;
  /** Human-readable instructions for finding/interacting with the submit trigger. */
  instructions?: string;
  /** For multi-step forms: intermediate clicks needed before the final submit. */
  steps?: Array<{
    action: 'click' | 'fill' | 'wait' | 'scroll';
    target?: string;
    hint?: string;
  }>;
}

export interface FormAnalysis {
  fields: AnalysedField[];
  requiresQuestions: boolean;
  summary: string;
  submitStrategy: SubmitStrategy;
}

/**
 * Have the LLM analyse a competition page / form and determine what it needs.
 * Returns structured JSON that describes the fields to fill AND how to submit.
 */
export async function analyseFormFields(
  provider: LlmProvider,
  pageContent: string,
  pageUrl: string,
): Promise<FormAnalysis> {
  const systemPrompt = `You are a competition-entry analysis bot. Analyse the HTML form content provided and determine what fields need to be filled in AND how to submit the form.

Return ONLY valid JSON with this exact shape:
{
  "fields": [
    {
      "name": "field_name_or_selector_hint",
      "type": "text|email|textarea|select|checkbox|radio|date|tel|url|number",
      "label": "the human-readable label for this field",
      "question": "if this is a competition question, the full question text",
      "options": ["Option 1", "Option 2"]  // ONLY for select/radio fields — list the available choices
    }
  ],
  "requiresQuestions": true/false,
  "summary": "a one-sentence summary of this competition",
  "submitStrategy": {
    "type": "direct|hidden_until_filled|multi_step|scroll|js_button|unknown",
    "selector": "CSS selector for the submit button/trigger if visible",
    "instructions": "explain how to submit this form",
    "steps": [
      { "action": "click|fill|wait|scroll", "target": "optional CSS selector", "hint": "why this step" }
    ]
  }
}

Guidelines for submitStrategy.type:
- "direct" — a standard submit button (button[type=submit], input[type=submit]) is visible on the page
- "hidden_until_filled" — the submit button exists but is hidden/disabled until form fields are filled correctly
- "multi_step" — multiple stages: click a "Next" or "Continue" button to reveal more fields, then submit
- "scroll" — the submit button exists but requires scrolling to reach it
- "js_button" — a custom JavaScript-driven element acts as the submit trigger (e.g. a div or link with onclick handler)
- "unknown" — can't determine how to submit

For select/radio fields, ALWAYS list the available options so the entry bot can pick the correct one.`;
  const userPrompt = `Analyse this competition page (${pageUrl}):

${pageContent.slice(0, 8000)}

Return the JSON analysis of what fields are present, what information is needed, and how to submit the form.`;

  const raw = await askLlm(provider, systemPrompt, userPrompt);

  try {
    // Extract JSON from the response (handle markdown-wrapped JSON)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in LLM response');
    }
    const parsed = JSON.parse(jsonMatch[0]);
    // Ensure submitStrategy exists with defaults
    if (!parsed.submitStrategy) {
      parsed.submitStrategy = { type: 'direct', instructions: 'Standard submit button' };
    }
    return parsed as FormAnalysis;
  } catch {
    // Fallback: return a basic structure
    return {
      fields: [{ name: 'unknown', type: 'text', label: 'Unknown field' }],
      requiresQuestions: false,
      summary: 'Could not analyse form fields',
      submitStrategy: { type: 'unknown', instructions: 'LLM analysis failed — attempting fallback' },
    };
  }
}

/**
 * Ask the LLM what action to take on the current page to submit the form.
 * Used as a fallback when standard button detection fails.
 */
export async function analyseSubmitAction(
  provider: LlmProvider,
  pageHtml: string,
  pageText: string,
  competitionTitle: string,
): Promise<{ action: string; selector?: string; value?: string }> {
  const systemPrompt = `You are analysing a competition entry form that has already been filled in. Your job is to find how to submit it.

Look at the HTML and page text provided. The form fields have already been filled. You need to find what element to interact with next to complete the entry.

Possible actions:
- "click_button" — click a specific button or link (provide a CSS selector)
- "press_enter" — press Enter on the last field
- "click_element" — click a specific element (provide selector)
- "scroll_to_submit" — scroll the page to reveal a hidden submit button
- "fill_field" — fill an additional field (provide the selector and value)
- "wait" — wait for something to load (provide seconds)
- "complete" — the form appears to be already submitted or no action needed

Return ONLY valid JSON: { "action": "click_button", "selector": "button.submit-btn", "value": "" }`;

  const userPrompt = `Competition: ${competitionTitle}

--- PAGE TEXT ---
${pageText.slice(0, 3000)}

--- PAGE HTML (snippet) ---
${pageHtml.slice(0, 4000)}

The form fields have been filled. What should the bot do next to submit this entry?`;

  const raw = await askLlm(provider, systemPrompt, userPrompt);
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch { /* fall through */ }
  return { action: 'complete' };
}

/**
 * Ask the LLM to pick the best option from a dropdown/select field.
 * Returns the value of the selected option.
 */
export async function chooseSelectOption(
  provider: LlmProvider,
  label: string,
  options: string[],
  competitionContext: string,
): Promise<string> {
  const systemPrompt = `You are filling in a competition entry form. A dropdown/select field needs a value. Pick the BEST option from the list.

Rules:
- If this is a title field (Mr/Mrs/Ms/Dr), pick "Mr"
- If this is a country field, pick the country that matches any provided context
- If this is an age range, pick an appropriate adult range (25-34 or 35-44)
- For all other fields, pick the most generic/positive option
- NEVER pick "Prefer not to say" or "Rather not say" if alternatives exist
- Return ONLY the exact option text, nothing else`;

  const userPrompt = `Field label: ${label}
Available options: ${options.join(', ')}

Competition context: ${competitionContext.slice(0, 500)}

Which option should be selected? Return ONLY the exact option text.`;

  return (await askLlm(provider, systemPrompt, userPrompt)).trim();
}

/**
 * Ask the LLM to answer a specific competition question,
 * referencing the actual prize details from the page so answers are
 * contextually relevant rather than generic.
 */
export async function answerQuestion(
  provider: LlmProvider,
  question: string,
  competitionTitle: string,
  /** Full page text + image descriptions — used as prize context. */
  pageContent?: string,
): Promise<string> {
  const systemPrompt = `You are helping enter a competition. You have access to the full page content, which describes the prize and the competition's theme.

Your job:
1. Scan the page content for prize details — product name, brand, value, what it looks like, what makes it special
2. Look for image descriptions or alt-text that describe the prize visually
3. Use ALL of that detail to answer the question in a way that sounds like a *real, excited person* who actually wants to win THIS specific prize

Rules:
- Keep your answer to 1-3 sentences
- BE SPECIFIC — mention the product name, brand, or a distinctive detail (e.g. "the 75" Neo QLED 8K TV" not just "a TV")
- Sound genuine and enthusiastic, not like a form letter
- Never mention that you're an AI or that you scanned the page`;

  const prizeSection = pageContent
    ? `
--- PRIZE DETAILS (from the competition page) ---
${pageContent.slice(0, 4000)}
---`
    : '';

  const userPrompt = `${prizeSection}

Competition title: ${competitionTitle.slice(0, 500)}

Question to answer: ${question}

Provide a natural, specific answer that shows you actually looked at the prize:`;

  return await askLlm(provider, systemPrompt, userPrompt);
}
