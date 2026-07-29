// Carrier round-trip contracts for vendor-specific metadata in the
// OpenAI-compatible chat/completions translator.
//
// Each upstream tacks private state onto chat/completions turns that
// must round-trip -- Gemini's `thought_signature` (the original bug),
// OpenRouter's `provider_specific_fields`, Bedrock's trace IDs and
// performanceConfig, etc. The carrier on the Anthropic side is
// `provider_metadata: { [vendor]: unknown }` -- loose enough to admit
// whatever shape each upstream uses, so adding a new vendor is a no-op
// for the translator.
//
// RESPONSE-SIDE upstream shapes are now exercised by the per-vendor
// fixture matrix at `src/providers/fixtures.test.ts`. Each fixture
// under `src/providers/fixtures/` models a captured upstream response
// from a specific provider, and the matrix reports pass/fail per
// vendor. Adding an upstream is "drop a JSON file in fixtures/" --
// no new test code.
//
// What's left inline is the behavior the matrix can't model:
//   * Request-side emission (toOpenAIRequest's fold-in rules,
//     multi-vendor coexistence in a single block, last-wins merge
//     across multiple tool_uses, the empty-carrier no-op).
//   * Response-root vs message-level merge semantics -- the matrix's
//     `namespaceIn` check is key-presence only, so the asymmetric
//     merge between OpenRouter's two placements is pinned at the
//     STRING level inline.
//   * Streaming SSE (translateStream's pendingToolMetadata
//     accumulator, late-metadata drop / late-delta emission,
//     namespace pass-through).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromOpenAIResponse, toOpenAIRequest } from "./openai-translate.js";
import { translateStream } from "./openai-compatible.js";
import { makeFakeResponse, readStream, parseSSEOutput } from "./streaming-harness.js";
import type { AnthropicMessagesRequest, AnthropicMessage, VendorMetadataDeltaEvent } from "../types.js";

describe("toOpenAIRequest -- vendor metadata emission", () => {
  it("forwards a tool_use carrier as per-tool-call extra_content plus message-level extra_body (Gemini)", () => {
    const req: AnthropicMessagesRequest = {
      model: "ignored",
      max_tokens: 100,
      messages: [
        { role: "user", content: "what is the weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            {
              type: "tool_use",
              id: "call_1",
              name: "search",
              input: { q: "weather" },
              // The carrier uses the upstream vendor's own namespace
              // (Google here), so the request translator forwards
              // `{ google: { thought_signature } }` to both placements
              // without renaming.
              provider_metadata: { google: { thought_signature: "SIG-A" } },
            },
          ],
        },
      ],
    };
    const out = toOpenAIRequest(req, "gemini-3-thinking");

    const assistant = out.messages.find((m) => m.role === "assistant");
    assert.ok(assistant, "expected an assistant message");
    assert.equal(
      (assistant as { extra_body?: { google?: { thought_signature?: string } } }).extra_body?.google?.thought_signature,
      "SIG-A",
    );
    assert.equal(
      (assistant as { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }).tool_calls?.[0]?.extra_content
        ?.google?.thought_signature,
      "SIG-A",
    );
  });

  it("forwards an OpenRouter-style tool_use carrier without rewriting the namespace", () => {
    const out = toOpenAIRequest(
      {
        model: "ignored",
        max_tokens: 100,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "search",
                input: { q: "x" },
                provider_metadata: {
                  openrouter: {
                    provider_specific_fields: { reasoning: "long thinking" },
                  },
                },
              },
            ],
          },
        ],
      },
      "openrouter/anthropic/claude-3.5-sonnet",
    );

    const assistant = out.messages.find((m) => m.role === "assistant") as {
      extra_body?: Record<string, unknown>;
      tool_calls?: Array<{ extra_content?: Record<string, unknown> }>;
    };
    assert.deepEqual(assistant.extra_body, {
      openrouter: { provider_specific_fields: { reasoning: "long thinking" } },
    });
    assert.deepEqual(assistant.tool_calls?.[0]?.extra_content, {
      openrouter: { provider_specific_fields: { reasoning: "long thinking" } },
    });
  });

  it("forwards a Bedrock-style carrier (trace id + performanceConfig) verbatim", () => {
    const out = toOpenAIRequest(
      {
        model: "ignored",
        max_tokens: 100,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "ok" },
            ],
            provider_metadata: {
              bedrock: { trace_id: "trace-abc", performanceConfig: { latencyOptimized: true } },
            },
          },
        ],
      },
      "bedrock/anthropic.claude-3-haiku",
    );

    const assistant = out.messages.find((m) => m.role === "assistant");
    assert.deepEqual(
      (assistant as { extra_body?: Record<string, unknown> }).extra_body,
      { bedrock: { trace_id: "trace-abc", performanceConfig: { latencyOptimized: true } } },
    );
  });

  it("uses the last tool_use's vendor payload for the message-level extra_body when several are present", () => {
    const out = toOpenAIRequest(
      {
        model: "ignored",
        max_tokens: 100,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "a",
                input: {},
                provider_metadata: { google: { thought_signature: "FIRST" } },
              },
              {
                type: "tool_use",
                id: "call_2",
                name: "b",
                input: {},
                provider_metadata: { google: { thought_signature: "SECOND" } },
              },
            ],
          },
        ],
      },
      "gemini-3-thinking",
    );

    const assistant = out.messages.find((m) => m.role === "assistant");
    assert.equal(
      (assistant as { extra_body?: { google?: { thought_signature?: string } } }).extra_body?.google?.thought_signature,
      "SECOND",
    );
    const calls = (assistant as { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }).tool_calls;
    assert.equal(calls?.[0]?.extra_content?.google?.thought_signature, "FIRST");
    assert.equal(calls?.[1]?.extra_content?.google?.thought_signature, "SECOND");
  });

  it("attaches the vendor payload from a text block to the message-level extra_body when no tool_use follows", () => {
    const out = toOpenAIRequest(
      {
        model: "ignored",
        max_tokens: 100,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "still thinking",
                provider_metadata: { google: { thought_signature: "TEXT-SIG" } },
              },
            ],
          },
        ],
      },
      "gemini-3-thinking",
    );

    const assistant = out.messages.find((m) => m.role === "assistant");
    assert.equal(
      (assistant as { extra_body?: { google?: { thought_signature?: string } } }).extra_body?.google?.thought_signature,
      "TEXT-SIG",
    );
    assert.equal(
      (assistant as { tool_calls?: unknown[] }).tool_calls,
      undefined,
      "no tool_use means no tool_calls array",
    );
  });

  it("merges multi-vendor coexistence on a single tool_use block into both placements", () => {
    // A single tool_use whose carrier carries both Google's signature
    // and OpenRouter's reasoning. Both must end up on the per-call
    // extra_content AND on the message-level extra_body -- proving the
    // carrier is genuinely vendor-agnostic rather than Gemini-only.
    const out = toOpenAIRequest(
      {
        model: "ignored",
        max_tokens: 100,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "search",
                input: {},
                provider_metadata: {
                  google: { thought_signature: "GEM-SIG" },
                  openrouter: { provider_specific_fields: { reasoning: "openrouter thought" } },
                },
              },
            ],
          },
        ],
      },
      "openrouter/google/gemini-3",
    );

    const assistant = out.messages.find((m) => m.role === "assistant") as {
      extra_body?: Record<string, unknown>;
      tool_calls?: Array<{ extra_content?: Record<string, unknown> }>;
    };
    assert.deepEqual(assistant.extra_body, {
      google: { thought_signature: "GEM-SIG" },
      openrouter: { provider_specific_fields: { reasoning: "openrouter thought" } },
    });
    assert.deepEqual(assistant.tool_calls?.[0]?.extra_content, {
      google: { thought_signature: "GEM-SIG" },
      openrouter: { provider_specific_fields: { reasoning: "openrouter thought" } },
    });
  });

  it("merges per-vendor last-wins across multiple tool_use blocks in the same assistant turn", () => {
    // Tool_use A has google only; tool_use B has openrouter only.
    // The message-level extra_body fold should carry BOTH, with each
    // vendor namespace coming from whichever block most recently
    // mentioned it.
    const out = toOpenAIRequest(
      {
        model: "ignored",
        max_tokens: 100,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "a",
                input: {},
                provider_metadata: { google: { thought_signature: "A" } },
              },
              {
                type: "tool_use",
                id: "call_2",
                name: "b",
                input: {},
                provider_metadata: { openrouter: { provider_specific_fields: { reasoning: "B-think" } } },
              },
            ],
          },
        ],
      },
      "openrouter/google/gemini-3",
    );

    const assistant = out.messages.find((m) => m.role === "assistant") as {
      extra_body?: Record<string, unknown>;
    };
    assert.deepEqual(assistant.extra_body, {
      google: { thought_signature: "A" },
      openrouter: { provider_specific_fields: { reasoning: "B-think" } },
    });
  });

  it("omits all vendor fields when no block carries any provider_metadata", () => {
    const out = toOpenAIRequest(
      {
        model: "ignored",
        max_tokens: 100,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "hello" },
              { type: "tool_use", id: "call_1", name: "search", input: {} },
            ],
          },
        ],
      },
      "qwen",
    );

    for (const msg of out.messages) {
      assert.equal((msg as { extra_body?: unknown }).extra_body, undefined);
      for (const call of msg.tool_calls ?? []) {
        assert.equal((call as { extra_content?: unknown }).extra_content, undefined);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Response-side `fromOpenAIResponse` merge tests.
//
// The fixture matrix handles per-vendor JSON coverage with a
// key-presence check (`namespaceIn`). What `fromOpenAIResponse` needs
// INLINE for is the asymmetric merge between OpenRouter's two
// placements (response-root `provider_specific_fields` vs
// `choices[0].message.extra_content`) -- specifically the last-wins
// direction. A regression that accidentally swapped the merge order
// (root-wins instead of message-wins) would change WHICH reasoning
// hint survives an OpenRouter -> Gemini reroute, and the matrix
// wouldn't catch it because both placements' inner keys exist in
// either case. These tests pin the inner STRING at each placement so
// the merge direction is observable in CI.
// ---------------------------------------------------------------------------
describe("fromOpenAIResponse -- response_root provider_specific_fields", () => {
  it("captures response_root provider_specific_fields when message-level is absent", () => {
    // OpenRouter sometimes emits only the response_root placement
    // (e.g. a streaming-friendly path that doesn't populate
    // message.extra_content). The carrier must still surface the
    // reasoning hint.
    const anthropic = fromOpenAIResponse(
      {
        id: "msg-rr-only",
        model: "openrouter/anthropic/claude-3.5-sonnet",
        choices: [
          {
            finish_reason: "stop",
            message: { content: "ok" },
          },
        ],
        provider_specific_fields: {
          openrouter: { provider_specific_fields: { reasoning: "root-only reasoning" } },
        },
      },
      "openrouter/anthropic/claude-3.5-sonnet",
    );

    const block = anthropic.content[0] as { provider_metadata?: Record<string, unknown> };
    assert.equal(
      (block.provider_metadata as { openrouter?: { provider_specific_fields?: { reasoning?: string } } } | undefined)
        ?.openrouter?.provider_specific_fields?.reasoning,
      "root-only reasoning",
      "response_root placement must surface verbatim when message-level is absent",
    );
  });

  it("merges message-level provider_specific_fields over response_root on per-vendor conflict (last-wins, message wins)", () => {
    // Both placements populated with DIFFERENT reasoning strings so
    // the test pins direction, not just key presence. Documented
    // merge: message-level wins per-vendor because it's the more
    // specific placement. If a future change reverses the merge
    // order, this test fails with the swapped value.
    const anthropic = fromOpenAIResponse(
      {
        id: "msg-both",
        model: "openrouter/anthropic/claude-3.5-sonnet",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "ok",
              extra_content: {
                openrouter: { provider_specific_fields: { reasoning: "MSG-LEVEL-WINS" } },
              },
            },
          },
        ],
        provider_specific_fields: {
          openrouter: { provider_specific_fields: { reasoning: "ROOT-LEVEL-LOSES" } },
        },
      },
      "openrouter/anthropic/claude-3.5-sonnet",
    );

    const block = anthropic.content[0] as { provider_metadata?: Record<string, unknown> };
    assert.equal(
      (block.provider_metadata as { openrouter?: { provider_specific_fields?: { reasoning?: string } } } | undefined)
        ?.openrouter?.provider_specific_fields?.reasoning,
      "MSG-LEVEL-WINS",
      "on per-vendor conflict the message-level slot wins (last-wins merge, message is more specific)",
    );
  });

  it("OpenRouter -> Gemini reroute keeps the specific reasoning hint intact across the turn boundary", () => {
    // The headline test: the response_root placement survives a
    // cross-vendor reroute by being folded into the per-message
    // carrier, then the request-side translator pushes it onto the
    // outgoing message-level extra_body in the format Gemini (or any
    // other vendor) expects. The actual reasoning hint STRING
    // survives -- not just the namespace key.
    //
    // Drive fromOpenAIResponse on an OpenRouter response that places
    // the reasoning hint at the response root only (the realistic
    // OpenRouter streaming-friendly shape), then build an
    // AnthropicMessagesRequest mimicking what Claude Code would send
    // on the next turn, then call toOpenAIRequest targeting
    // gemini-3-thinking, and assert the specific reasoning string is
    // verbatim on the outgoing assistant message's extra_body.
    const fromOpenRouter = fromOpenAIResponse(
      {
        id: "msg-or-turn1",
        model: "openrouter/anthropic/claude-3.5-sonnet",
        choices: [
          {
            finish_reason: "stop",
            message: { content: "I recommend the second source." },
          },
        ],
        provider_specific_fields: {
          openrouter: { provider_specific_fields: { reasoning: "long cross-vendor reasoning hint" } },
        },
      },
      "openrouter/anthropic/claude-3.5-sonnet",
    );

    // Claude Code's transcript carries the captured content blocks
    // verbatim on the next turn. We re-emit targeting a different
    // vendor (gemini-3-thinking) so this exercises cross-vendor
    // propagation, not same-vendor round-trip.
    const nextTurn: AnthropicMessagesRequest = {
      model: "ignored",
      max_tokens: 100,
      messages: [
        { role: "user", content: "follow-up" },
        { role: "assistant", content: fromOpenRouter.content },
      ],
    };
    const outgoing = toOpenAIRequest(nextTurn, "gemini-3-thinking");
    const assistant = outgoing.messages.find((m) => m.role === "assistant") as
      | { extra_body?: { openrouter?: { provider_specific_fields?: { reasoning?: string } } } }
      | undefined;

    assert.equal(
      assistant?.extra_body?.openrouter?.provider_specific_fields?.reasoning,
      "long cross-vendor reasoning hint",
      "the specific reasoning STRING survives an OpenRouter -> Gemini reroute (not just the namespace key)",
    );
  });
});

// ---------------------------------------------------------------------------
// Streaming tests.
//
// `translateStream` reads a synthesized upstream Response whose body is an
// OpenAI-style SSE stream (data-only `data:` lines split by `\n\n`) and
// produces an Anthropic-style SSE stream. These tests drive the function
// with a fake body, drain the output, parse it back into structured events,
// and assert on `content_block_start.content_block.provider_metadata` --
// the surface where the loose vendor-metadata carrier has to land.
//
// The fixture matrix models JSON responses; SSE doesn't fit that
// format so streaming stays inline. Worth folding in once a vendor
// actually exercises the streaming path -- at that point we'd add
// `src/providers/fixtures/streaming/<vendor>.txt` and a separate
// streaming harness, mirroring this without changing the matrix.
// ---------------------------------------------------------------------------


describe("translateStream -- vendor metadata in content_block_start", () => {
  it("captures per-tool-call extra_content into the tool_use content_block.provider_metadata", async () => {
    const input = [
      'data: ' + JSON.stringify({
        id: "chunk-1",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "search", arguments: '{"q":"weather"}' },
              extra_content: { openrouter: { provider_specific_fields: { reasoning: "considered" } } },
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-2",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      '',
      'data: [DONE]',
      '',
    ].join("\n\n");

    const out = await readStream(translateStream(makeFakeResponse(input), "openrouter/anthropic/claude-3.5-sonnet"));
    const events = parseSSEOutput(out);

    const startEvent = events.find((e) => e.event === "content_block_start");
    assert.ok(startEvent, "expected a content_block_start event");
    const block = (startEvent.data as { content_block: Record<string, unknown> }).content_block;
    assert.deepEqual(block.provider_metadata, {
      openrouter: { provider_specific_fields: { reasoning: "considered" } },
    });
  });

  it("falls back to delta-level extra_content when the tool_call has no per-call metadata", async () => {
    const input = [
      'data: ' + JSON.stringify({
        id: "chunk-1",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "search", arguments: '{"q":"weather"}' },
              // no per-tool-call extra_content
            }],
            // No per-tool-call extra_content; message-level fallback.
            extra_content: { google: { thought_signature: "FALLBACK-SIG" } },
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-2",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      '',
      'data: [DONE]',
      '',
    ].join("\n\n");

    const out = await readStream(translateStream(makeFakeResponse(input), "gemini-3-thinking"));
    const events = parseSSEOutput(out);

    const startEvent = events.find((e) => e.event === "content_block_start");
    assert.ok(startEvent, "expected a content_block_start event");
    const block = (startEvent.data as { content_block: Record<string, unknown> }).content_block;
    assert.deepEqual(block.provider_metadata, { google: { thought_signature: "FALLBACK-SIG" } });
  });

  it("emits no provider_metadata when neither chunk carries vendor metadata", async () => {
    const input = [
      'data: ' + JSON.stringify({
        id: "chunk-1",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "search", arguments: "{}" },
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-2",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      '',
      'data: [DONE]',
      '',
    ].join("\n\n");

    const out = await readStream(translateStream(makeFakeResponse(input), "qwen"));
    const events = parseSSEOutput(out);

    const startEvent = events.find((e) => e.event === "content_block_start");
    assert.ok(startEvent, "expected a content_block_start event");
    const block = (startEvent.data as { content_block: Record<string, unknown> }).content_block;
    assert.equal(block.provider_metadata, undefined);
  });

  it("forwards the vendor namespace verbatim (does not remap to 'google')", async () => {
    // The streaming translator must not remap arbitrary vendor
    // namespaces to 'google' the way the typed Gemini-specific code
    // path used to. Bedrock is a clean example: top-level keys, no
    // nesting assumptions.
    const input = [
      'data: ' + JSON.stringify({
        id: "chunk-1",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "search", arguments: "{}" },
              extra_content: { bedrock: { trace_id: "trace-abc", performanceConfig: { latencyOptimized: true } } },
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-2",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      '',
      'data: [DONE]',
      '',
    ].join("\n\n");

    const out = await readStream(translateStream(makeFakeResponse(input), "bedrock/anthropic.claude-3-haiku"));
    const events = parseSSEOutput(out);

    const startEvent = events.find((e) => e.event === "content_block_start");
    assert.ok(startEvent, "expected a content_block_start event");
    const block = (startEvent.data as { content_block: Record<string, unknown> }).content_block;
    assert.deepEqual(block.provider_metadata, {
      bedrock: { trace_id: "trace-abc", performanceConfig: { latencyOptimized: true } },
    });
  });

  it("drops late vendor metadata when emitLateMetadataDelta is off (documented default)", async () => {
    // First chunk: tool_call delta with NO extra_content. content_block
    // starts without provider_metadata.
    // Second chunk: tool_call delta WITH extra_content arriving AFTER
    // content_block_start has fired. The flag is off (default) so the
    // carrier is dropped -- mirrors the pre-feature behavior so
    // deploying behind an unknown SDK client is safe.
    //
    // Note: when the flag is OFF the translator also doesn't emit a
    // synthetic content_block_start retroactively. Anthropic SSE has
    // no late-firing content_block_start equivalent (the spec only
    // exposes content_block_delta / content_block_stop after the start
    // has fired), so the gap is fundamental -- carrying the metadata
    // forward client-side is what unlocks the new event type.
    const input = [
      'data: ' + JSON.stringify({
        id: "chunk-1",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "search", arguments: "" },
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-2",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"q":"x"}' },
              extra_content: { openrouter: { provider_specific_fields: { reasoning: "too late" } } },
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-3",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      '',
      'data: [DONE]',
      '',
    ].join("\n\n");

    // Flag explicitly false -- same as default.
    const out = await readStream(translateStream(makeFakeResponse(input), "openrouter/anthropic/claude-3.5-sonnet", false));
    const events = parseSSEOutput(out);

    const startEvent = events.find((e) => e.event === "content_block_start");
    assert.ok(startEvent, "expected a content_block_start event");
    const block = (startEvent.data as { content_block: Record<string, unknown> }).content_block;
    assert.equal(
      block.provider_metadata,
      undefined,
      "with the flag off, late metadata must be dropped (no synthetic start event either)",
    );
    // No vendor_metadata_delta event should have leaked out.
    const late = events.filter((e) => e.event === "content_block_delta" && (e.data as VendorMetadataDeltaEvent | { delta: { type: string } }).delta.type === "vendor_metadata_delta");
    assert.equal(late.length, 0, "no vendor_metadata_delta events when flag is off");
  });

  it("emits a vendor_metadata_delta for late metadata when emitLateMetadataDelta is on", async () => {
    // Same scenario as the "drops late" test BUT the flag is on, so
    // the late tool_call metadata is carried through as a
    // vendor_metadata_delta event instead of being lost.
    const input = [
      'data: ' + JSON.stringify({
        id: "chunk-1",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "search", arguments: "" },
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-2",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"q":"x"}' },
              extra_content: { openrouter: { provider_specific_fields: { reasoning: "long thinking" } } },
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-3",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      '',
      'data: [DONE]',
      '',
    ].join("\n\n");

    const out = await readStream(translateStream(makeFakeResponse(input), "openrouter/anthropic/claude-3.5-sonnet", true));
    const events = parseSSEOutput(out);

    const startEvent = events.find((e) => e.event === "content_block_start");
    assert.ok(startEvent, "expected a content_block_start event");
    const block = (startEvent.data as { content_block: Record<string, unknown> }).content_block;
    assert.equal(
      block.provider_metadata,
      undefined,
      "the FIRST chunk had no metadata, so content_block_start has none either -- late metadata only arrives in the delta",
    );

    const lateDeltas = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data as VendorMetadataDeltaEvent | { delta: { type: string } })
      .filter((d) => d.delta.type === "vendor_metadata_delta") as VendorMetadataDeltaEvent[];
    assert.equal(lateDeltas.length, 1, "exactly one vendor_metadata_delta event for the single late chunk");
    assert.deepEqual(
      lateDeltas[0],
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "vendor_metadata_delta",
          provider_metadata: { openrouter: { provider_specific_fields: { reasoning: "long thinking" } } },
        },
      },
      "wire shape matches VendorMetadataDeltaEvent (types.ts), and index matches the open tool_use block",
    );
  });

  it("emits one vendor_metadata_delta per late chunk when several arrive (flag on)", async () => {
    // Multiple tool_call deltas spread across chunks, each carrying
    // independent metadata. With the flag on, each chunk produces
    // its own vendor_metadata_delta event -- no coalescing -- so the
    // client sees the metadata stream mapped 1:1 onto the upstream
    // chunk stream. Carrying the per-chunk payload verbatim (rather
    // than a synthesized rolling merge) keeps the contract simple:
    // one chunk == one delta.
    const input = [
      'data: ' + JSON.stringify({
        id: "chunk-1",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "search", arguments: "" },
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-2",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"q":"x"}' },
              extra_content: { openrouter: { provider_specific_fields: { reasoning: "first" } } },
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-3",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"q":' },
              extra_content: { openrouter: { provider_specific_fields: { reasoning: "second" } } },
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-4",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      '',
      'data: [DONE]',
      '',
    ].join("\n\n");

    const out = await readStream(translateStream(makeFakeResponse(input), "openrouter/anthropic/claude-3.5-sonnet", true));
    const events = parseSSEOutput(out);

    const lateDeltas = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data as VendorMetadataDeltaEvent | { delta: { type: string } })
      .filter((d) => d.delta.type === "vendor_metadata_delta") as VendorMetadataDeltaEvent[];

    assert.equal(lateDeltas.length, 2, "one vendor_metadata_delta per late chunk");
    assert.deepEqual(
      lateDeltas[0].delta.provider_metadata,
      { openrouter: { provider_specific_fields: { reasoning: "first" } } },
      "first delta carries the first chunk's payload verbatim",
    );
    assert.deepEqual(
      lateDeltas[1].delta.provider_metadata,
      { openrouter: { provider_specific_fields: { reasoning: "second" } } },
      "second delta carries the second chunk's payload verbatim -- no coalescing",
    );
    assert.equal(lateDeltas[0].index, 0, "index matches the open tool_use block");
    assert.equal(lateDeltas[1].index, 0, "index matches the open tool_use block");
  });

  it("still hoists pre-start metadata onto content_block_start when the flag is on (no replacement)", async () => {
    // Metadata arriving IN THE FIRST CHUNK alongside the tool_call
    // delta should still be hoisted onto content_block_start -- the
    // flag only changes the late-arrival path. A client subscribing
    // to vendor_metadata_delta for late arrivals shouldn't see the
    // pre-start metadata duplicated in a redundant delta event.
    const input = [
      'data: ' + JSON.stringify({
        id: "chunk-1",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "search", arguments: "" },
              extra_content: { google: { thought_signature: "EARLY-SIG" } },
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-2",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      '',
      'data: [DONE]',
      '',
    ].join("\n\n");

    const out = await readStream(translateStream(makeFakeResponse(input), "gemini-3-thinking", true));
    const events = parseSSEOutput(out);

    const startEvent = events.find((e) => e.event === "content_block_start");
    const block = (startEvent!.data as { content_block: Record<string, unknown> }).content_block;
    assert.deepEqual(
      block.provider_metadata,
      { google: { thought_signature: "EARLY-SIG" } },
      "pre-start metadata hoists onto content_block_start as before -- the flag does not change this path",
    );

    const lateDeltas = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data as VendorMetadataDeltaEvent | { delta: { type: string } })
      .filter((d) => d.delta.type === "vendor_metadata_delta");
    assert.equal(lateDeltas.length, 0, "no redundant vendor_metadata_delta for pre-start metadata -- it's already on the start event");
  });

  it("falls back to delta-level extra_content for late arrival when tool_call has no per-call metadata (flag on)", async () => {
    // Upstream emits the metadata at the message level (delta.extra_content)
    // rather than per-tool-call (call.extra_content). With the flag on,
    // this still produces a vendor_metadata_delta event for the open
    // tool_use block. This matches the pre-start hoist's
    // per-call-then-message fallback priority.
    const input = [
      'data: ' + JSON.stringify({
        id: "chunk-1",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "search", arguments: "" },
              // no per-call extra_content
            }],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-2",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"q":"x"}' },
              // no per-call extra_content
            }],
            extra_content: { google: { thought_signature: "LATE-FALLBACK-SIG" } },
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        id: "chunk-3",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      '',
      'data: [DONE]',
      '',
    ].join("\n\n");

    const out = await readStream(translateStream(makeFakeResponse(input), "gemini-3-thinking", true));
    const events = parseSSEOutput(out);

    const lateDeltas = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data as VendorMetadataDeltaEvent | { delta: { type: string } })
      .filter((d) => d.delta.type === "vendor_metadata_delta") as VendorMetadataDeltaEvent[];

    assert.equal(lateDeltas.length, 1, "delta-level late metadata still produces a vendor_metadata_delta");
    assert.deepEqual(
      lateDeltas[0].delta.provider_metadata,
      { google: { thought_signature: "LATE-FALLBACK-SIG" } },
      "fallback metadata chain (per-call -> delta-level) applies to the late path too",
    );
  });
});

// Image preservation + per-provider size cap (fitRequestToSize).
//
// The pre-fix behavior was: `blockText` filtered to text-only blocks,
// so anthropic image blocks were silently dropped on the way out to any
// OpenAI-compatible upstream. Conversations with images that grew
// beyond the upstream's request-size cap then failed with the upstream's
// own error (Groq's "accumulated images and attachments" message is
// particularly unhelpful). The fix preserves images as OpenAI
// image_url parts and adds fitRequestToSize, which strips oldest inline
// base64 images when the serialized body exceeds a per-provider cap.

import {
  fitRequestToSize,
  isOpenAIImagePart,
  type OpenAIContentPart,
} from "./openai-translate.js";

/** Build an N-message request with a few inline-base64 images of varying
 *  sizes. Pure helper for the test cases below. */
function buildRequestWithImages(
  imageSizesBytes: number[],
  textPerMessage: string = "x",
): AnthropicMessagesRequest {
  const messages = imageSizesBytes.map((size, mi) => {
    const base64Pad = "A".repeat(Math.max(0, size - 100));
    const blocks: unknown[] = [
      { type: "text", text: `${textPerMessage} msg${mi}` },
    ];
    if (size > 0) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64Pad },
      });
    }
    return { role: "user" as const, content: blocks as AnthropicMessage["content"] };
  });
  return {
    model: "test-model",
    messages,
    max_tokens: 100,
  };
}

describe("image preservation: Anthropic -> OpenAI translation", () => {
  it("emits an image_url content part for an Anthropic image block (base64)", () => {
    const req: AnthropicMessagesRequest = {
      model: "x",
      max_tokens: 1,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what's in this image?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        ],
      }],
    };
    const openai = toOpenAIRequest(req, "x");
    assert.equal(openai.messages.length, 1);
    const content = openai.messages[0].content;
    assert.ok(Array.isArray(content), "image-bearing message emits an array content");
    // text part first, then image_url
    const parts = content as OpenAIContentPart[];
    assert.equal(parts.length, 2);
    assert.equal(parts[0].type, "text");
    assert.ok(isOpenAIImagePart(parts[1]));
    const img = (parts[1] as { image_url: { url: string } }).image_url;
    assert.ok(img.url.startsWith("data:image/png;base64,"), `url must be a data URI, got ${img.url.slice(0, 40)}...`);
  });

  it("emits an image_url content part for a remote URL image", () => {
    const req: AnthropicMessagesRequest = {
      model: "x",
      max_tokens: 1,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: "https://example.com/foo.png" } },
        ],
      }],
    };
    const openai = toOpenAIRequest(req, "x");
    const parts = openai.messages[0].content as OpenAIContentPart[];
    assert.ok(isOpenAIImagePart(parts[0]), "URL image becomes an image_url part");
    assert.equal((parts[0] as { image_url: { url: string } }).image_url.url, "https://example.com/foo.png");
  });

  it("preserves images inside tool_result content", () => {
    const req: AnthropicMessagesRequest = {
      model: "x",
      max_tokens: 1,
      messages: [{
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "tool returned this:" },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB" } },
            ],
          },
        ],
      }],
    };
    const openai = toOpenAIRequest(req, "x");
    const toolMsg = openai.messages[0];
    assert.equal(toolMsg.role, "tool");
    assert.ok(Array.isArray(toolMsg.content));
    const parts = toolMsg.content as OpenAIContentPart[];
    assert.ok(parts.some(isOpenAIImagePart), "tool_result with image becomes a tool message with image_url");
  });

  it("text-only messages still emit a string content (legacy form preserved)", () => {
    const req: AnthropicMessagesRequest = {
      model: "x",
      max_tokens: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    const openai = toOpenAIRequest(req, "x");
    assert.equal(typeof openai.messages[0].content, "string", "text-only stays a string for compat");
    assert.equal(openai.messages[0].content, "hi");
  });
});

describe("fitRequestToSize", () => {
  it("returns the request unchanged when already under the cap", () => {
    const req = toOpenAIRequest(buildRequestWithImages([10, 10, 10]), "x");
    const result = fitRequestToSize(req, 10_000_000);
    assert.equal(result.stripped, 0);
    assert.equal(result.stillOverLimit, false);
    assert.ok(result.initialBytes <= 10_000_000);
    assert.equal(result.finalBytes, result.initialBytes);
  });

  it("strips oldest image until the body fits when over cap", () => {
    // 3 messages, each with a ~2KB image. Cap = 1.5KB total. All 3
    // images must be stripped to fit inside the 1500-byte cap (each
    // inline base64 image's serialized payload is ~2KB, and the
    // combined body with all 3 is ~6.5KB). Oldest images (msg 0, then
    // msg 1) are stripped first; the assertion checks that stripping
    // happened at all and that the body was brought under the cap.
    // The strongest assertion is finalBytes <= cap, not a specific
    // image-preservation claim, because the exact byte-count math
    // varies with JSON serialization overhead and base64 expansion.
    const req = toOpenAIRequest(buildRequestWithImages([2048, 2048, 2048]), "x");
    const cap = 1500;
    const result = fitRequestToSize(req, cap);
    assert.ok(result.stripped > 0, "must strip when over cap");
    assert.equal(result.stillOverLimit, false, "must fit after stripping");
    assert.ok(result.finalBytes <= cap, `finalBytes ${result.finalBytes} must be <= cap ${cap}`);
  });

  it("strips multiple images from the SAME message when one isn't enough", () => {
    // One message with three large images -- regression test for the
    // bug where the inner loop incorrectly continued messageLoop after
    // one strip, skipping remaining images in the same message.
    const req: AnthropicMessagesRequest = {
      model: "x",
      max_tokens: 1,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "t" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(2000) } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "B".repeat(2000) } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "C".repeat(2000) } },
        ],
      }],
    };
    const openai = toOpenAIRequest(req, "x");
    const result = fitRequestToSize(openai, 1500);
    assert.ok(result.stripped >= 2, `must strip at least 2 of 3 images, got ${result.stripped}`);
    assert.equal(result.stillOverLimit, false);
    assert.ok(result.finalBytes <= 1500);
  });

  it("returns stillOverLimit=true when no images are present but the request is still over cap", () => {
    // Pure text request -- can't strip anything.
    const req: AnthropicMessagesRequest = {
      model: "x",
      max_tokens: 1,
      messages: [{ role: "user", content: "x".repeat(5000) }],
    };
    const openai = toOpenAIRequest(req, "x");
    const result = fitRequestToSize(openai, 100);
    assert.equal(result.stripped, 0);
    assert.equal(result.stillOverLimit, true);
  });

  it("URL-only image references are not stripped (already small)", () => {
    // 5 messages each with a URL-only image -- URL strings are tiny so
    // no stripping should happen for a reasonable cap.
    const req: AnthropicMessagesRequest = {
      model: "x",
      max_tokens: 1,
      messages: Array.from({ length: 5 }).map((_, i) => ({
        role: "user" as const,
        content: [{
          type: "image",
          source: { type: "url", url: `https://example.com/img${i}.png` },
        }],
      })),
    };
    const openai = toOpenAIRequest(req, "x");
    const result = fitRequestToSize(openai, 50_000);
    assert.equal(result.stripped, 0, "URL-only images stay -- only base64 data URIs are stripped");
  });

  it("clones the request so the caller's reference is untouched", () => {
    const req = toOpenAIRequest(buildRequestWithImages([4096, 4096, 4096]), "x");
    const beforeJson = JSON.stringify(req);
    fitRequestToSize(req, 1500);
    assert.equal(JSON.stringify(req), beforeJson, "original request must not be mutated");
  });
});
