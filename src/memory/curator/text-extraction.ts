/** Extract text from a message content value that may be a plain string,
 *  an array of content blocks (the format Claude Code's session files use,
 *  and what Anthropic's Messages API returns for multi-block responses),
 *  or any other shape.  Returns the concatenated text or null when nothing
 *  text-shaped is present. */
export function extractContentText(content: unknown): string | null {
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "tool_result" && typeof block.content === "string") {
          texts.push(block.content);
        } else if (block.type === "tool_result" && Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner && typeof inner === "object" && inner.type === "text" && typeof inner.text === "string") {
              texts.push(inner.text);
            }
          }
        }
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}
