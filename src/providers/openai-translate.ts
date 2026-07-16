// Translates between the Anthropic Messages format (what this gateway speaks
// to Claude Code) and the OpenAI-compatible chat/completions format Ollama
// exposes. Ollama has no native Anthropic-format endpoint, so every request
// and response round-trips through this module.
import type { AnthropicContentBlock, AnthropicMessage, AnthropicMessagesRequest, AnthropicMessagesResponse } from "../types.js";

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  stream?: boolean;
  tools?: { type: "function"; function: { name: string; description?: string; parameters: unknown } }[];
}

export function blockText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as unknown as { text: string }).text)
    .join("\n");
}

function anthropicMessageToOpenAI(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  const toolResults = msg.content.filter((b) => b.type === "tool_result");
  if (toolResults.length > 0) {
    // Anthropic represents tool results as user-role content blocks; OpenAI
    // wants a distinct "tool" message per result, keyed by tool_call_id.
    return toolResults.map((b) => {
      const block = b as unknown as { tool_use_id: string; content: string | AnthropicContentBlock[] };
      return {
        role: "tool" as const,
        content: typeof block.content === "string" ? block.content : blockText(block.content),
        tool_call_id: block.tool_use_id,
      };
    });
  }

  const toolUses = msg.content.filter((b) => b.type === "tool_use");
  const text = blockText(msg.content);
  if (toolUses.length > 0) {
    return [
      {
        role: msg.role,
        content: text || null,
        tool_calls: toolUses.map((b) => {
          const block = b as unknown as { id: string; name: string; input: unknown };
          return {
            id: block.id,
            type: "function" as const,
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          };
        }),
      },
    ];
  }

  return [{ role: msg.role, content: text }];
}

export function toOpenAIRequest(req: AnthropicMessagesRequest, model: string): OpenAIRequest {
  const messages: OpenAIMessage[] = [];
  if (req.system) {
    messages.push({ role: "system", content: typeof req.system === "string" ? req.system : blockText(req.system) });
  }
  for (const msg of req.messages) {
    messages.push(...anthropicMessageToOpenAI(msg));
  }

  const out: OpenAIRequest = {
    model,
    messages,
    max_tokens: req.max_tokens,
    stream: req.stream ?? false,
  };

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    out.tools = (req.tools as { name: string; description?: string; input_schema: unknown }[]).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  return out;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: {
    message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export function mapFinishReason(reason: string): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "stop":
    default:
      return "end_turn";
  }
}

export function fromOpenAIResponse(res: OpenAIResponse, requestedModel: string): AnthropicMessagesResponse {
  const choice = res.choices[0];
  const content: AnthropicContentBlock[] = [];

  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  for (const call of choice.message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }

  return {
    id: res.id,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}
