// Per-vendor fixture matrix.
//
// Two parallel halves share the per-vendor scripts in package.json
// (test:gemini, test:openrouter, ...) so each entry in package.json
// points at one vendor's two fixture files (response-shape + stream-
// chunks) instead of one.
//
//   1. Non-streaming capture + re-emit: drives `fromOpenAIResponse`
//      and `toOpenAIRequest` over captured upstream response shapes
//      and asserts the carrier round-trips through the next turn.
//      Re-emit can target a different model (`reroute`) for cross-
//      vendor matrix coverage -- OpenRouter -> Gemini reroute keeps
//      the reasoning hint intact across the turn boundary.
//
//   2. Streaming pre-start hoist: drives `translateStream` over
//      captured upstream SSE chunks and asserts the carrier lands on
//      `content_block_start.provider_metadata`. The late-arrival
//      cases (drop / late-delta emission under the
//      `emitLateMetadataDelta` flag) stay inline in
//      openai-translate.test.ts -- the matrix covers the streaming
//      happy path per vendor, not the streaming-flag edge cases.
//
// Fixtures live under `src/providers/fixtures/`:
//   <vendor>.json         -- non-streaming response shape (full JSON)
//   <vendor>.stream.json  -- streaming chunk array (per-chunk JSON)
//
// Adding an upstream is a one-line change: drop both JSON files in
// `src/providers/fixtures/`, the matrix picks them up. Bad values
// (typo'd `expectedOn`, non-string `reroute`, missing required
// fields, malformed `chunks`) surface here at fixture-load time with
// the offending file name in the error.
//
// Streaming fixtures are JSON files whose top-level shape mirrors
// the non-streaming shape (vendor, model, namespace, expectedOn),
// but whose payload is `chunks`: an array of chat-completions
// streaming-chunk JSON objects. The matrix assembles them into SSE
// bytes (`data: ...\n\ndata: [DONE]\n\n`) and drives them through
// `translateStream`. Streaming does NOT extend to the response_root
// placement -- that path is documented in openai-translate.ts's
// header -- so OpenRouter's provider_specific_fields surface here
// is the per-tool-call extra_content slot rather than the
// response_root one used by the non-streaming openrouter fixture.
//
// namespace is required but may be null (raw_openai case): a
// missing field is a fixture bug; null means "this upstream emits
// no vendor metadata" and the matrix asserts the carrier stays
// empty under that case.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromOpenAIResponse, toOpenAIRequest } from "./openai-translate.js";
import { translateStream } from "./openai-compatible.js";
import { makeFakeResponse, readStream, parseSSEOutput, chunksToSSE } from "./streaming-harness.js";
import type { AnthropicMessagesRequest, VendorMetadata } from "../types.js";

type ExpectedOn = "any" | "tool_use" | "text";
const EXPECTED_ON_VALUES: ExpectedOn[] = ["any", "tool_use", "text"];

interface VendorFixture {
  vendor: string;
  model: string;
  namespace: string | null;
  expectedOn?: ExpectedOn;
  reroute?: string;
  upstream: Record<string, unknown>;
}

interface VendorStreamingFixture {
  vendor: string;
  model: string;
  namespace: string | null;
  expectedOn?: ExpectedOn;
  /** Per-chunk chat-completions streaming JSON objects. The matrix
   * wraps each in `data: ...\n\n` and appends `data: [DONE]\n\n` to
   * form the upstream SSE feed. */
  chunks: Array<Record<string, unknown>>;
}

// Per-vendor scripts in package.json (test:gemini, test:openrouter,
// ...) set VENDOR=<vendor-id> so the matrix loads only that vendor's
// fixtures (both the non-streaming one and the streaming one). This
// makes "Each entry points at a fixture" literal in package.json: a
// CI badge reads test:gemini failed, not a buried it(...) label
// inside the matrix output. When VENDOR is unset (the default --
// `npm test`, `test:matrix`) every fixture loads and the runner
// reports two rows per upstream (one per matrix half).
const vendorFilter = process.env.VENDOR;
const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

// Vendor-id extraction that admits both `<vendor>.json` (non-
// streaming) and `<vendor>.stream.json` (streaming) shapes. The
// strip order matters: `.stream.json` first so the streaming suffix
// is gone before we look for `.json`. Future suffixes (e.g. a
// `.rerouted.json` family) would slot in here.
function vendorIdOf(filename: string): string {
  return filename.replace(/\.stream\.json$/, "").replace(/\.json$/, "");
}

function loadFixtures(): VendorFixture[] {
  const files = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".stream.json"));
  return files
    .filter((f) => {
      if (!vendorFilter) return true;
      // Match the bare vendor id (`gemini.json`) or a vendor/
      // prefixed-id split (`openrouter-extra.json` -> vendor
      // "openrouter"), so fixtures may grow beyond bare name over
      // time without breaking the per-vendor scripts.
      const id = vendorIdOf(f);
      return id === vendorFilter || id.startsWith(`${vendorFilter}-`);
    })
    .map((f) => {
      const raw = readFileSync(join(fixturesDir, f), "utf-8");
      const parsed = JSON.parse(raw) as Partial<VendorFixture>;
      // Runtime schema check -- below errors cite the offending file so
      // a typo'd fixture fails at load time, not as a confusing
      // assertion failure during the matrix run.
      if (typeof parsed.vendor !== "string" || !parsed.vendor) {
        throw new Error(`${f}: missing or invalid 'vendor' field`);
      }
      if (typeof parsed.model !== "string" || !parsed.model) {
        throw new Error(`${f}: missing or invalid 'model' field`);
      }
      // `namespace` is required but may be null (raw_openai case). A
      // missing field is a fixture bug, not no-vendor-metadata.
      if (!("namespace" in parsed)) {
        throw new Error(`${f}: missing required 'namespace' field (use null for fixtures with no vendor metadata)`);
      }
      if (parsed.namespace !== null && typeof parsed.namespace !== "string") {
        throw new Error(`${f}: 'namespace' must be a string or null`);
      }
      if (parsed.expectedOn !== undefined && !EXPECTED_ON_VALUES.includes(parsed.expectedOn)) {
        throw new Error(`${f}: 'expectedOn' must be one of ${EXPECTED_ON_VALUES.join(", ")} (got ${JSON.stringify(parsed.expectedOn)})`);
      }
      if (parsed.reroute !== undefined && typeof parsed.reroute !== "string") {
        throw new Error(`${f}: 'reroute' must be a string`);
      }
      if (!parsed.upstream || typeof parsed.upstream !== "object") {
        throw new Error(`${f}: missing or invalid 'upstream' field`);
      }
      return parsed as VendorFixture;
    });
}

function loadStreamingFixtures(): VendorStreamingFixture[] {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".stream.json"));
  return files
    .filter((f) => {
      if (!vendorFilter) return true;
      const id = vendorIdOf(f);
      return id === vendorFilter || id.startsWith(`${vendorFilter}-`);
    })
    .map((f) => {
      const raw = readFileSync(join(fixturesDir, f), "utf-8");
      const parsed = JSON.parse(raw) as Partial<VendorStreamingFixture>;
      if (typeof parsed.vendor !== "string" || !parsed.vendor) {
        throw new Error(`${f}: missing or invalid 'vendor' field`);
      }
      if (typeof parsed.model !== "string" || !parsed.model) {
        throw new Error(`${f}: missing or invalid 'model' field`);
      }
      if (!("namespace" in parsed)) {
        throw new Error(`${f}: missing required 'namespace' field (use null for fixtures with no vendor metadata)`);
      }
      if (parsed.namespace !== null && typeof parsed.namespace !== "string") {
        throw new Error(`${f}: 'namespace' must be a string or null`);
      }
      if (parsed.expectedOn !== undefined && !EXPECTED_ON_VALUES.includes(parsed.expectedOn)) {
        throw new Error(`${f}: 'expectedOn' must be one of ${EXPECTED_ON_VALUES.join(", ")} (got ${JSON.stringify(parsed.expectedOn)})`);
      }
      if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
        throw new Error(`${f}: 'chunks' must be a non-empty array`);
      }
      return parsed as VendorStreamingFixture;
    });
}

function namespaceIn(meta: VendorMetadata | undefined, namespace: string): boolean {
  return !!meta && typeof meta === "object" && namespace in meta;
}

function makeLabel(fixture: VendorFixture): string {
  const capture = fixture.namespace
    ? fixture.expectedOn && fixture.expectedOn !== "any"
      ? `captures the "${fixture.namespace}" namespace on a ${fixture.expectedOn} block`
      : `captures the "${fixture.namespace}" namespace on at least one block`
    : "leaves the carrier empty (no vendor metadata upstream)";
  const emit = fixture.reroute && fixture.reroute !== fixture.model
    ? `re-emits to ${fixture.reroute}`
    : `re-emits to ${fixture.model}`;
  return `${fixture.vendor}: ${capture}; ${emit}`;
}

function makeStreamingLabel(fixture: VendorStreamingFixture): string {
  const hoist = fixture.namespace
    ? fixture.expectedOn && fixture.expectedOn !== "any"
      ? `hoists "${fixture.namespace}" onto content_block_start (${fixture.expectedOn} block)`
      : `hoists "${fixture.namespace}" onto content_block_start`
    : "emits no provider_metadata on content_block_start (no vendor metadata)";
  return `${fixture.vendor} (streaming): ${hoist}`;
}



describe("vendor matrix -- per-upstream fixture capture + re-emit", () => {
  const fixtures = loadFixtures();

  if (vendorFilter && fixtures.length === 0) {
    throw new Error(
      `VENDOR=${vendorFilter} filtered out every non-streaming fixture in ${fixturesDir} -- check the per-vendor script's vendor id against the JSON filename (drop .json off the right)`,
    );
  }

  for (const fixture of fixtures) {
    it(makeLabel(fixture), () => {
      const upstream = fixture.upstream as unknown as Parameters<typeof fromOpenAIResponse>[0];
      const anthropic = fromOpenAIResponse(upstream, fixture.model);

      // CAPTURE SIDE: when namespace is set, the carrier must land on
      // the asserted block type. expectedOn="any" accepts presence on
      // any block; "tool_use" / "text" tighten to specific block
      // types so regressions on the wrong block surface here. When
      // namespace is null (raw_openai case), NO block should carry
      // provider_metadata -- that's the "the translator never invents
      // vendor metadata" guarantee.
      if (fixture.namespace) {
        const target = fixture.expectedOn ?? "any";
        const namespace = fixture.namespace;
        const found = anthropic.content.some((b) => {
          const meta = (b as { provider_metadata?: VendorMetadata }).provider_metadata;
          if (!namespaceIn(meta, namespace)) return false;
          if (target === "any") return true;
          return b.type === target;
        });
        assert.ok(
          found,
          `[${fixture.vendor}] expected provider_metadata containing namespace "${namespace}" on a block matching expectedOn="${target}", got: ${JSON.stringify(anthropic.content, null, 2)}`,
        );
      } else {
        for (const block of anthropic.content) {
          assert.equal(
            (block as { provider_metadata?: unknown }).provider_metadata,
            undefined,
            `[${fixture.vendor}] expected no provider_metadata on any block, got: ${JSON.stringify(block)}`,
          );
        }
      }

      // RE-EMIT SIDE: build a next-turn request from the captured
      // content (mimicking Claude Code's transcript carry-over) and
      // verify the namespace survives into the outgoing extra_body.
      // When the fixture has a `reroute` target, the re-emit requests
      // a DIFFERENT upstream model -- this is the cross-vendor matrix
      // shape and exercises harder integration beyond same-vendor
      // round-trip. When no namespace was expected upstream, outgoing
      // extra_body should also be absent -- no carrier pollution.
      const targetModel = fixture.reroute ?? fixture.model;
      const nextTurn: AnthropicMessagesRequest = {
        model: targetModel,
        max_tokens: 100,
        messages: [
          { role: "user", content: "follow-up" },
          { role: "assistant", content: anthropic.content } as AnthropicMessagesRequest["messages"][number],
        ],
      };
      const outgoing = toOpenAIRequest(nextTurn, targetModel);
      const assistant = outgoing.messages.find((m) => m.role === "assistant") as
        | { extra_body?: VendorMetadata }
        | undefined;

      if (fixture.namespace) {
        assert.ok(
          assistant?.extra_body && namespaceIn(assistant.extra_body, fixture.namespace),
          `[${fixture.vendor}] expected outgoing extra_body to contain namespace "${fixture.namespace}" (target=${targetModel}), got: ${JSON.stringify(assistant?.extra_body)}`,
        );
      } else {
        assert.equal(
          assistant?.extra_body,
          undefined,
          `[${fixture.vendor}] expected no extra_body on outgoing (target=${targetModel}), got: ${JSON.stringify(assistant?.extra_body)}`,
        );
      }
    });
  }
});

describe("vendor streaming matrix -- per-upstream SSE pre-start hoist", () => {
  const streamingFixtures = loadStreamingFixtures();

  if (vendorFilter && streamingFixtures.length === 0) {
    throw new Error(
      `VENDOR=${vendorFilter} filtered out every streaming fixture in ${fixturesDir} -- check the per-vendor script's vendor id against the JSON filename (drop .stream.json off the right)`,
    );
  }

  for (const fixture of streamingFixtures) {
    it(makeStreamingLabel(fixture), async () => {
      const sse = chunksToSSE(fixture.chunks);
      const fakeResponse = makeFakeResponse(sse);
      const out = await readStream(translateStream(fakeResponse, fixture.model));
      const events = parseSSEOutput(out);

      // Pin to the block type the streaming fixture declared via
      // expectedOn; default to "tool_use" because the streaming
      // carrier shape has vendor metadata emitted on tool_call
      // deltas (the streaming translator hoists via
      // pendingToolMetadata, not via message-level delta). A future
      // text-only streaming fixture (e.g. a Gemini thought-only
      // return where the carrier surfaces on a text block) opts in
      // via `expectedOn: "text"`; `expectedOn: "any"` accepts
      // either block type. Without this parametrisation the matrix
      // would silently break for any non-tool_use streaming fixture,
      // even though the schema's `expectedOn` field advertises
      // support.
      const target = fixture.expectedOn ?? "tool_use";
      const startEvent = events.find(
        (e) =>
          e.event === "content_block_start" &&
          (target === "any" ||
            (e.data as { content_block: { type: string } }).content_block.type === target),
      );
      assert.ok(
        startEvent,
        `[${fixture.vendor}] expected a content_block_start event matching expectedOn="${target}", got: ${JSON.stringify(events.filter((e) => e.event === "content_block_start"))}`,
      );

      const block = (startEvent!.data as {
        content_block: { type: string; provider_metadata?: VendorMetadata };
      }).content_block;

      // PRE-START HOIST ASSERTION. When namespace is set, the
      // carrier must land on content_block_start with the asserted
      // block type. expectedOn tightens: "tool_use" requires the
      // block to be a tool_use block (with provider_metadata on
      // it); "text" requires it to be a text block; "any" accepts
      // either. When namespace is null, content_block_start has NO
      // provider_metadata -- the translator never invents vendor
      // state on the streaming side either.
      if (fixture.namespace) {
        const target = fixture.expectedOn ?? "any";
        if (target !== "any") {
          assert.equal(
            block.type,
            target,
            `[${fixture.vendor}] expected content_block type="${target}", got type="${block.type}"`,
          );
        }
        assert.ok(
          namespaceIn(block.provider_metadata, fixture.namespace),
          `[${fixture.vendor}] expected provider_metadata containing namespace "${fixture.namespace}" on content_block_start, got: ${JSON.stringify(block.provider_metadata)}`,
        );
      } else {
        assert.equal(
          block.provider_metadata,
          undefined,
          `[${fixture.vendor}] expected no provider_metadata on content_block_start, got: ${JSON.stringify(block.provider_metadata)}`,
        );
      }
    });
  }
});
