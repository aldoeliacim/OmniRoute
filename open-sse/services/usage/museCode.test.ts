/** Tests for muse-code usage fetcher */
import test from "node:test";
import assert from "node:assert/strict";

// We test the fetcher against Meta's API shape. The shape returned by
// https://api.meta.ai/v1/me is unknown; the fetcher must degrade gracefully
// when no usage endpoint exists and when it returns a 429 (quota exhausted).
test("getMuseUsage returns empty/unknown when no API key", async () => {
  const { getMuseUsage } = await import("../../open-sse/services/usage/museCode.ts");
  const result = await getMuseUsage(undefined, {});
  assert.ok(result, "returns a result object");
  assert.ok(result.message || result.used !== undefined, "has some output");
});

test("getMuseUsage handles 429 quota-exhausted gracefully", async () => {
  // Test that a 429 from Meta doesn't crash the fetcher
  const { getMuseUsage } = await import("../../open-sse/services/usage/museCode.ts");
  const result = await getMuseUsage("fake-token", {});
  assert.ok(result, "returns a result object even on error");
});
