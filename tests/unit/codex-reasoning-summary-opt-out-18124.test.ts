import test from "node:test";
import assert from "node:assert/strict";

// #18124: OpenAI's safety system flags `reasoning.effort` + `summary: "auto"` +
// `include: ["reasoning.encrypted_content"]` on gpt-6.1-sol (and the other listed
// models) as "Potentially unintended activity" next to a long system prompt. The
// opt-out covers ONLY requests translated from Chat Completions: native Codex
// Responses clients keep the defaulted summary and the encrypted reasoning include,
// which carry their reasoning continuity across turns.

const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

type WireBody = Record<string, unknown> & {
  reasoning?: Record<string, unknown>;
  include?: unknown[];
};

const CTX = { requestEndpointPath: "/responses", providerSpecificData: {} };
const MARKER = "_omnirouteSkipReasoningSummaryDefault";
const longSystemPrompt = "You are a careful assistant. ".repeat(2000);

function chatBody(effort = "medium") {
  return {
    messages: [
      { role: "system", content: longSystemPrompt },
      { role: "user", content: "hi" },
    ],
    reasoning_effort: effort,
  };
}

function translateChatToResponses(model: string, provider: string) {
  return translateRequest(
    FORMATS.OPENAI,
    FORMATS.OPENAI_RESPONSES,
    model,
    chatBody(),
    true,
    null,
    provider
  ) as Record<string, unknown>;
}

function chatToCodexWire(model: string): WireBody {
  const translated = translateChatToResponses(model, "codex");
  return new CodexExecutor().transformRequest(model, translated, true, CTX) as WireBody;
}

test("#18124 Chat-translated gpt-6.1-sol reaches the Codex wire with effort only", () => {
  const wire = chatToCodexWire("gpt-6.1-sol");
  assert.equal(wire.reasoning?.effort, "medium");
  assert.equal("summary" in (wire.reasoning ?? {}), false, "executor must not re-add summary");
  assert.equal(wire.include, undefined, "executor must not re-add the encrypted_content include");
  assert.equal(MARKER in wire, false, "internal marker must never reach the wire");
});

test("#18124 Chat-translated models outside the list keep the defaulted summary and include", () => {
  const wire = chatToCodexWire("gpt-5.5");
  assert.equal(wire.reasoning?.summary, "auto");
  assert.deepEqual(wire.include, ["reasoning.encrypted_content"]);
  assert.equal(MARKER in wire, false);
});

test("#18124 native Responses gpt-6.1-sol (no translator marker) keeps summary and encrypted include", () => {
  const wire = new CodexExecutor().transformRequest(
    "gpt-6.1-sol",
    {
      model: "gpt-6.1-sol",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      reasoning: { effort: "high" },
      _nativeCodexPassthrough: true,
    },
    true,
    CTX
  ) as WireBody;
  assert.equal(wire.reasoning?.summary, "auto");
  assert.deepEqual(wire.include, ["reasoning.encrypted_content"]);
});

test("#18124 the opt-out marker is dropped for non-Codex Responses targets", () => {
  const translated = translateChatToResponses("gpt-6.1-sol", "openai");
  assert.equal(MARKER in translated, false, "marker must not leak to other providers' upstreams");
  assert.equal(translated.include, undefined);
  assert.equal("summary" in ((translated.reasoning as Record<string, unknown>) ?? {}), false);
});

test("#18124 an explicit summary from a Chat client still reaches the Codex wire", () => {
  const translated = translateRequest(
    FORMATS.OPENAI,
    FORMATS.OPENAI_RESPONSES,
    "gpt-6.1-sol",
    {
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high", summary: "concise" },
    },
    true,
    null,
    "codex"
  ) as Record<string, unknown>;
  const wire = new CodexExecutor().transformRequest(
    "gpt-6.1-sol",
    translated,
    true,
    CTX
  ) as WireBody;
  assert.equal(wire.reasoning?.summary, "concise");
  assert.equal(MARKER in wire, false);
});
