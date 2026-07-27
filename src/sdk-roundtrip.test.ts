// Synthetic Anthropic SDK integration test.
//
// The carrier strategy in `src/types.ts` and `src/providers/openai-translate.ts`
// assumes Claude Code's client SDK round-trips `provider_metadata` ON THE
// WIRE -- it shows up in the request body when the assistant's previous
// tool_use block re-enters the conversation, and the SDK doesn't strip
// it. This test pins that assumption empirically so users don't hit a
// silent SDK regression that drops unknown fields.
//
// We DON'T make real HTTP. The SDK accepts a custom `fetch` in its
// constructor (or via global override) so we can intercept the
// exact body that would go on the wire. If the test fails, the
// carrier strategy probably went wrong upstream -- e.g. a future
// SDK version that uses Zod positional parsing with `strict` mode
// would drop our custom `provider_metadata` field on the way out,
// and the docs in openai-translate.ts would need a redo.
//
// Two tests:
//   1. The headline: a tool_use block carrying provider_metadata.bedrock
//      survives the SDK's JSON serializer with the trace_id verbatim.
//   2. A sanity check: requests WITHOUT provider_metadata still produce
//      a well-formed JSON body keyed on the standard fields.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

// One Anthropic-stub Message response body that the SDK will accept so
// `await client.messages.create(...)` resolves cleanly. We don't care
// about its content -- only the request body the SDK serializes.
const STUB_RESPONSE = {
  id: "msg-sdk-roundtrip",
  type: "message" as const,
  role: "assistant" as const,
  model: "claude-3-haiku-20240307",
  content: [{ type: "text" as const, text: "ok" }],
  stop_reason: "end_turn" as const,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

/** A `fetch`-compatible capture fn that records the body the SDK
 *  serializes and returns a 200 with the stub response above. */
function makeCaptureFetch(): {
  fetch: typeof globalThis.fetch;
  body: () => string;
} {
  let captured: string | null = null;
  const capture: typeof globalThis.fetch = async (_input, init) => {
    captured = typeof init?.body === "string" ? init.body : null;
    return new Response(JSON.stringify(STUB_RESPONSE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetch: capture,
    body: () => {
      assert.ok(captured, "the SDK never serialized a body -- fetch wasn't called");
      return captured as string;
    },
  };
}

describe("Anthropic SDK -- provider_metadata survives the request serializer", () => {
  it("carries provider_metadata.bedrock.trace_id through messages.create() JSON body", async () => {
    const cap = makeCaptureFetch();
    const client = new Anthropic({ apiKey: "test-key-not-real", fetch: cap.fetch });

    // Build a messages.create() call whose assistant turn carries a
    // tool_use block with a custom provider_metadata.bedrock field.
    // The SDK's TypeScript types for ToolUseBlockParam are strict
    // interfaces -- no index signature -- so the carrier strategy's
    // custom field can't be expressed in the typed shape. We cast
    // through `unknown` once at the call boundary; the carrier
    // strategy is the thing under test, not the SDK's strictness.
    const params = {
      model: "claude-3-haiku-20240307",
      max_tokens: 100,
      messages: [
        { role: "user" as const, content: "what is the weather?" },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "call_1",
              name: "search",
              input: { q: "weather" },
              // Custom field on a tool_use block. Bedrock would emit a
              // `trace_id` here when it needs to round-trip across
              // turns. The carrier strategy assumes the SDK passes
              // unknown fields through.
              provider_metadata: {
                bedrock: {
                  trace_id: "trace-abc-123",
                  performanceConfig: { latencyOptimized: true },
                },
              },
            },
          ],
        },
      ],
    };

    await client.messages.create(params as Parameters<typeof client.messages.create>[0]);

    // Parse the captured body and drill into the assistant tool_use
    // block to assert the trace_id made it through verbatim. If this
    // test fails, the SDK has stopped passing through unknown fields
    // and the carrier strategy in src/types.ts needs an audit.
    const parsed = JSON.parse(cap.body());
    const assistant = parsed.messages[1];
    assert.equal(assistant.role, "assistant", "second message should be the assistant");
    const toolUse = assistant.content[0];
    assert.equal(toolUse.type, "tool_use", "assistant's first content block should be the tool_use");
    assert.equal(
      toolUse.provider_metadata?.bedrock?.trace_id,
      "trace-abc-123",
      "provider_metadata.bedrock.trace_id must survive the SDK's JSON serialization",
    );
    assert.deepEqual(
      toolUse.provider_metadata,
      { bedrock: { trace_id: "trace-abc-123", performanceConfig: { latencyOptimized: true } } },
      "the full carrier survives verbatim (no field rename, no namespace rewrite). See src/types.ts VendorMetadata for the carrier strategy this test locks in.",
    );
  });

  it("carries provider_metadata.bedrock.trace_id on a text content block (alternate placement)", async () => {
    // The carrier strategy documented in src/providers/openai-translate.ts
    // puts the carrier on text content blocks too -- a Bedrock trace
    // summary or an OpenRouter provider_specific_fields turn that
    // surfaces as assistant text lands on the message-level text
    // block, not on a tool_use. If the SDK's serializer for
    // TextBlockParam differs from ToolUseBlockParam (different code
    // paths under the hood), a future SDK regression could strip
    // unknown fields from one and not the other. This test pins the
    // text-block path so we see both halves of the carrier strategy
    // empirically.
    const cap = makeCaptureFetch();
    const client = new Anthropic({ apiKey: "test-key-not-real", fetch: cap.fetch });

    const params = {
      model: "claude-3-haiku-20240307",
      max_tokens: 100,
      messages: [
        { role: "user" as const, content: "summarize this" },
        {
          role: "assistant" as const,
          content: [
            {
              type: "text" as const,
              text: "here is a trace-aware summary",
              // Same carrier, but on a text block. The SDK has a
              // distinct TextBlockParam type from ToolUseBlockParam;
              // this is the alternate placement the carrier strategy
              // exercises on response side.
              provider_metadata: {
                bedrock: { trace_id: "trace-text-456" },
              },
            },
          ],
        },
      ],
    };

    await client.messages.create(params as Parameters<typeof client.messages.create>[0]);

    const parsed = JSON.parse(cap.body());
    const assistant = parsed.messages[1];
    const textBlock = assistant.content[0];
    assert.equal(textBlock.type, "text", "assistant's first content block should be the text");
    assert.equal(
      textBlock.provider_metadata?.bedrock?.trace_id,
      "trace-text-456",
      "provider_metadata.bedrock.trace_id must survive on a text content block too. See src/types.ts VendorMetadata for the carrier strategy this test locks in.",
    );
  });

  it("response-side deserialization surfaces provider_metadata.bedrock.trace_id on the typed Message", async () => {
    // The OTHER half of the round-trip. The previous tests prove
    // provider_metadata survives the SDK's REQUEST serializer. This
    // test pins the inverse: a response body the SDK parses must
    // surface provider_metadata on the typed Message result so
    // Claude Code's loop (and the gateway's fromOpenAIResponse on
    // the OpenAI-compat side) can read the carrier back. If the SDK
    // ever ships a response-time Zod parser that strips unknown
    // fields, this test fails and the carrier strategy in
    // src/types.ts gets audited.
    //
    // The same fake-fetch hook returns a stubbed response that the
    // SDK will parse; provider_metadata.bedrock.trace_id must show
    // up verbatim on response.content[0].provider_metadata after
    // the round trip.
    const RESPONSE_BODY = {
      id: "msg-sdk-roundtrip-resp",
      type: "message" as const,
      role: "assistant" as const,
      model: "claude-3-haiku-20240307",
      content: [
        {
          type: "tool_use" as const,
          id: "call_1",
          name: "search",
          input: { q: "weather" },
          // Carrier on the response side -- what the gateway reads
          // back via `providerMetadataOf` (openai-translate.ts).
          provider_metadata: {
            bedrock: { trace_id: "trace-rsp-789", performanceConfig: { latencyOptimized: true } },
          },
        },
      ],
      stop_reason: "tool_use" as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const fakeResp = new Response(JSON.stringify(RESPONSE_BODY), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fakeFetch: typeof globalThis.fetch = async (_input, _init) => fakeResp;
    const client = new Anthropic({ apiKey: "test-key-not-real", fetch: fakeFetch });

    // Any minimal request -- the test only cares about what the SDK
    // does on the response side.
    const result = await client.messages.create(
      {
        model: "claude-3-haiku-20240307",
        max_tokens: 100,
        messages: [{ role: "user" as const, content: "search the weather" }],
        tools: [
          {
            name: "search",
            description: "search the web",
            input_schema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      } as Parameters<typeof client.messages.create>[0],
    );

    // Cast through `unknown` for the same reason as the request-side
    // tests: the SDK's typed return shape is a discriminated union
    // (Stream | Message), and the ToolUseBlock shape is strict. We're
    // proving the untyped carrier survives deserialization, which is
    // what the carrier-strategy code paths actually access at
    // runtime.
    const loose = result as unknown as {
      content: Array<{
        type: string;
        provider_metadata?: { bedrock?: { trace_id?: string; performanceConfig?: { latencyOptimized?: boolean } } };
      }>;
    };
    // Find by type rather than index -- a future SDK that inserts
    // a leading text block before the tool_use won't break this
    // test for the wrong reason.
    const toolUse = loose.content.find((b) => b.type === "tool_use");
    assert.ok(toolUse, "the stub response should contain a tool_use content block");
    assert.equal(
      toolUse.provider_metadata?.bedrock?.trace_id,
      "trace-rsp-789",
      "provider_metadata.bedrock.trace_id must survive the SDK's RESPONSE deserializer. See src/types.ts VendorMetadata for the carrier strategy this test locks in.",
    );
    // Also walk the typed result structure to confirm no other
    // field on the standard ToolUseBlock shape was perturbed.
    assert.equal(toolUse.provider_metadata?.bedrock?.performanceConfig?.latencyOptimized, true);
  });

  it("request WITHOUT provider_metadata produces well-formed JSON (sanity check)", async () => {
    // This is the negative control. If this test fails, the harness
    // itself is broken (e.g. the SDK is now rejecting the request
    // shape before serialization, or our stubbed fetch isn't being
    // invoked). Either way, fix the harness before trusting the
    // positive test above.
    const cap = makeCaptureFetch();
    const client = new Anthropic({ apiKey: "test-key-not-real", fetch: cap.fetch });

    await client.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 100,
      messages: [{ role: "user" as const, content: "hi" }],
    } as Parameters<typeof client.messages.create>[0]);

    const parsed = JSON.parse(cap.body());
    assert.equal(parsed.model, "claude-3-haiku-20240307");
    assert.equal(parsed.max_tokens, 100);
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].role, "user");
    assert.equal(parsed.messages[0].content, "hi");
    // The plain request has no provider_metadata anywhere -- confirms
    // the SDK didn't accidentally inject one.
    const walked = JSON.stringify(parsed);
    assert.equal(walked.includes("provider_metadata"), false, "plain requests must not invent provider_metadata");
  });
});
