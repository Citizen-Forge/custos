import type { TurnEvent } from "../../remote/turn-runner.js";

/** A short human-readable line for what just happened, used both as the
 * run's `currentAction` and as the live feed's event text. Returns null for
 * events not worth showing (token deltas). */
export function describeEvent(event: TurnEvent): string | null {
  if (event.type === "message_final") {
    const tool = event.content.find((block) => block.type === "tool_use");
    if (tool && tool.type === "tool_use") {
      const input = tool.input as Record<string, unknown> | undefined;
      const primary = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url;
      return typeof primary === "string" ? `${tool.name}: ${primary}` : tool.name;
    }
    const text = event.content.find((block) => block.type === "text");
    return text && text.type === "text" && text.text.trim() ? text.text.trim().split("\n")[0].slice(0, 160) : null;
  }
  if (event.type === "tool_result" && event.isError) return "a tool call failed";
  if (event.type === "error") return `error: ${event.message.slice(0, 160)}`;
  return null;
}
