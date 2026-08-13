/**
 * Extracts the agent's contract block. Prefers the requested tag, then a
 * generic json fence, then a bare brace-balanced object -- models are
 * reliable about emitting the JSON and much less reliable about labelling
 * the fence, and a run that did all the work is too expensive to throw away
 * over a missing tag. Takes the *last* match: an agent that reasons out
 * loud often shows a draft of the block before its real one.
 */
export function extractContract<T>(text: string, tag: string): T | null {
  const candidates: string[] = [];
  const fenced = new RegExp("```(?:" + tag + "|json)?[ \\t]*\\r?\\n([\\s\\S]*?)```", "g");
  for (const match of text.matchAll(fenced)) candidates.push(match[1]);

  for (const candidate of candidates.reverse()) {
    try {
      return JSON.parse(candidate.trim()) as T;
    } catch {
      // Try the next-most-recent fence.
    }
  }

  // Fence matching fails whenever the JSON itself contains a fence -- an
  // engineer's `summary` routinely includes a markdown code block, which
  // terminates the non-greedy match early and leaves invalid JSON. Falling
  // back to brace scanning recovers those, and it matters: this runs after
  // the work is already done, so a parse failure here throws away an entire
  // ticket's worth of time and money over punctuation.
  for (const candidate of balancedObjects(text).reverse()) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/**
 * Every balanced `{...}` region in the text, in order of appearance, with
 * string literals and escapes respected so a brace inside a quoted value
 * doesn't throw the depth count off.
 */
function balancedObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        found.push(text.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  return found;
}
