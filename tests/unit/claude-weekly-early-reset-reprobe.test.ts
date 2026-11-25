import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  isClaudeWeeklyQuotaReprobeCandidate,
  runConnectionRecoveryTick,
} from "@/lib/quota/connectionRecovery";

/**
 * Regression coverage for the Claude subscription weekly-quota early-reset gap.
 *
 * A weekly 429 parks the connection with `rate_limited_until` at the window end
 * (days away). When the account is reset out-of-band BEFORE that end, the only
 * thing that detects it is a live usage fetch (maybeClearRecoveredQuotaState /
 * #17043), which was otherwise driven solely by the ~70-minute background sync.
 * The fast (~60s) recovery tick must re-probe such parks so the early reset is
 * detected within minutes — WITHOUT blindly clearing the authoritative cooldown
 * (#11277). It must route through a live re-probe, never clearConnectionError.
 */
describe("connectionRecovery — Claude weekly-quota early-reset reprobe", () => {
  const nowMs = 1_700_000_000_000;
  const fiveMinMs = 5 * 60 * 1000;
  const weeklyPark = (overrides: Record<string, unknown> = {}) => ({
    id: "claude-weekly-1",
    provider: "claude",
    testStatus: "unavailable",
    lastErrorType: "quota_exhausted",
    errorCode: 429,
    lastError: "This request would exceed your account's rate limit for the week (weekly quota).",
    // Park extends to the weekly window end — days in the future.
    rateLimitedUntil: new Date(nowMs + 5 * 24 * 60 * 60 * 1000).toISOString(),
    lastErrorAt: new Date(nowMs - fiveMinMs - 60_000).toISOString(),
    ...overrides,
  });

  it("flags a Claude weekly-quota park once the reprobe interval has elapsed since the last attempt", () => {
    const lastAttempt = nowMs - fiveMinMs - 60_000;
    assert.equal(
      isClaudeWeeklyQuotaReprobeCandidate(weeklyPark(), nowMs, undefined, lastAttempt),
      true
    );
  });

  it("does NOT reprobe before the interval has elapsed since the last attempt", () => {
    const lastAttempt = nowMs - 60_000;
    assert.equal(
      isClaudeWeeklyQuotaReprobeCandidate(weeklyPark(), nowMs, undefined, lastAttempt),
      false
    );
  });

  it("reprobes on the first tick when this process has never attempted the park", () => {
    assert.equal(isClaudeWeeklyQuotaReprobeCandidate(weeklyPark(), nowMs, undefined, null), true);
  });

  it("does NOT re-probe a still-exhausted park on every tick (churn regression)", () => {
    // lastErrorAt is NOT rewritten by a live fetch that still sees the window
    // exhausted, so an lastErrorAt-based gate would re-probe every 60s tick.
    // Pacing must come from the last re-probe attempt, so a fresh attempt
    // suppresses the next tick even though lastErrorAt is stale.
    const staleErrorAt = weeklyPark({
      lastErrorAt: new Date(nowMs - 6 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(
      isClaudeWeeklyQuotaReprobeCandidate(staleErrorAt, nowMs, undefined, nowMs - 60_000),
      false
    );
  });

  it("does NOT reprobe a non-Claude provider", () => {
    assert.equal(
      isClaudeWeeklyQuotaReprobeCandidate(weeklyPark({ provider: "codex" }), nowMs),
      false
    );
  });

  it("does NOT reprobe a non-429 error code", () => {
    assert.equal(isClaudeWeeklyQuotaReprobeCandidate(weeklyPark({ errorCode: 503 }), nowMs), false);
  });

  it("does NOT reprobe an unrelated error type", () => {
    assert.equal(
      isClaudeWeeklyQuotaReprobeCandidate(weeklyPark({ lastErrorType: "auth_error" }), nowMs),
      false
    );
  });

  it("does NOT reprobe a per-minute (non-weekly) Claude rate limit", () => {
    const rpm = weeklyPark({
      lastError: "Number of requests has exceeded your per-minute rate limit.",
    });
    assert.equal(isClaudeWeeklyQuotaReprobeCandidate(rpm, nowMs), false);
  });

  it("does NOT reprobe once the cooldown itself has already elapsed (cheap clear path owns it)", () => {
    const elapsed = weeklyPark({
      rateLimitedUntil: new Date(nowMs - 1000).toISOString(),
    });
    assert.equal(isClaudeWeeklyQuotaReprobeCandidate(elapsed, nowMs), false);
  });

  it("does NOT reprobe a healthy active Claude connection", () => {
    assert.equal(
      isClaudeWeeklyQuotaReprobeCandidate(weeklyPark({ testStatus: "active" }), nowMs),
      false
    );
  });

  it("tick re-probes the park via a live fetch and never blind-clears it", async () => {
    const loadConnections = mock.fn(async () => [weeklyPark()]);
    const clearConnectionError = mock.fn(async () => undefined);
    const reprobeConnection = mock.fn(async () => undefined);

    const res = await runConnectionRecoveryTick({
      nowMs,
      loadConnections,
      clearConnectionError,
      reprobeConnection,
      lastReprobeAt: new Map<string, number>(),
    });

    assert.equal(res.reprobed, 1);
    assert.deepEqual(res.reprobedIds, ["claude-weekly-1"]);
    assert.equal(reprobeConnection.mock.callCount(), 1);
    assert.equal(reprobeConnection.mock.calls[0].arguments[0], "claude-weekly-1");
    // Hard-statement rule (#11277): the park must NOT be cleared without evidence.
    assert.equal(clearConnectionError.mock.callCount(), 0);
    assert.equal(res.recovered, 0);
  });

  it("tick keeps re-probe and elapsed-cooldown recovery as disjoint paths", async () => {
    const elapsedPark = weeklyPark({
      id: "claude-elapsed",
      rateLimitedUntil: new Date(nowMs - 1000).toISOString(),
    });
    const loadConnections = mock.fn(async () => [weeklyPark(), elapsedPark]);
    const clearConnectionError = mock.fn(async () => undefined);
    const reprobeConnection = mock.fn(async () => undefined);

    const res = await runConnectionRecoveryTick({
      nowMs,
      loadConnections,
      clearConnectionError,
      reprobeConnection,
      lastReprobeAt: new Map<string, number>(),
    });

    assert.deepEqual(res.reprobedIds, ["claude-weekly-1"]);
    assert.deepEqual(res.recoveredIds, ["claude-elapsed"]);
    assert.equal(reprobeConnection.mock.callCount(), 1);
    assert.equal(clearConnectionError.mock.callCount(), 1);
  });

  it("tick does not re-probe a still-exhausted park on every 60s tick (end-to-end churn guard)", async () => {
    const lastReprobeAt = new Map<string, number>();
    const reprobeConnection = mock.fn(async () => undefined);
    const loadConnections = async () => [
      weeklyPark({ lastErrorAt: new Date(nowMs - 6 * 3_600_000).toISOString() }),
    ];

    // Tick 1: never probed -> one re-probe, stamped.
    await runConnectionRecoveryTick({ nowMs, loadConnections, reprobeConnection, lastReprobeAt });
    // Tick 2 a minute later: inside the 5-min pace -> no new re-probe.
    await runConnectionRecoveryTick({
      nowMs: nowMs + 60_000,
      loadConnections,
      reprobeConnection,
      lastReprobeAt,
    });
    // Tick 3 past the 5-min pace -> one more re-probe.
    await runConnectionRecoveryTick({
      nowMs: nowMs + fiveMinMs + 1_000,
      loadConnections,
      reprobeConnection,
      lastReprobeAt,
    });

    assert.equal(reprobeConnection.mock.callCount(), 2);
  });
});
