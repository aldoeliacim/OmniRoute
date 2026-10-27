import test from "node:test";
import assert from "node:assert/strict";

import { getMuseUsage } from "../../open-sse/services/usage/museCode.ts";

test("Muse usage accepts missing metadata without credentials", async () => {
  const result = await getMuseUsage(undefined, {});
  assert.equal(result.provider, "muse-code");
  assert.equal(result.plan, "unknown");
  assert.equal(result.isSubsActive, undefined);
  assert.deepEqual(result.details, []);
});

for (const active of [true, false]) {
  test(`Muse usage preserves subscription metadata when active=${active}`, async () => {
    const result = await getMuseUsage(undefined, {
      subsTierName: "Synthetic tier",
      subsTierId: "synthetic-tier",
      isSubsActive: active,
      hasPaymentMethod: false,
    });
    assert.equal(result.plan, "Synthetic tier");
    assert.equal(result.subsTierId, "synthetic-tier");
    assert.equal(result.isSubsActive, active);
    assert.equal(result.hasPaymentMethod, false);
    assert.match(String(result.message), active ? /\(active\)/ : /\(inactive\)/);
  });
}
