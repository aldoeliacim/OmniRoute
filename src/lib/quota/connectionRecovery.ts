/**
 * connectionRecovery.ts — Proactive recovery of provider connections whose
 * transient cooldown has elapsed.
 *
 * Today the cooldown released by `markAccountUnavailable()` (testStatus
 * 'unavailable' + a future `rateLimitedUntil`) is recovered LAZILY: a connection
 * only becomes eligible again when the next real request reads it in
 * `getProviderCredentials` (src/sse/services/auth.ts). The first request after
 * the cooldown window therefore pays the latency of re-discovering a healthy
 * connection.
 *
 * Modeled on gpt-load's CronChecker, this module identifies the subset of
 * connections that are cooling down with an already-elapsed window and clears
 * their error state OUTSIDE the request hot path, so they are restored before
 * the next real request arrives.
 *
 * This file holds the PURE selection logic (`selectRecoverableConnections`,
 * `isRecoverableCooldownConnection`) — no DB, no network, time injected — plus a
 * thin async tick (`runConnectionRecoveryTick`) that wires the helper to the DB.
 * The tick is NOT auto-started on import; the caller (startup bootstrap) decides
 * when to schedule it, so importing this module in tests never spawns a timer.
 */

import { cooldownUntilMs } from "@omniroute/open-sse/services/accountFallback.ts";
import { readStoredVerificationUrl } from "@omniroute/open-sse/services/antigravityVerification.ts";
import { isClaudeWeeklyQuota429Signal } from "@omniroute/open-sse/services/usage/claudeQuota.ts";
import { isAutomatedTestProcess } from "@/shared/utils/testProcess";

/**
 * The transient-cooldown status written by `markAccountUnavailable()` for a
 * recoverable failure. Only connections in this status are candidates for
 * proactive recovery.
 */
export const RECOVERABLE_COOLDOWN_STATUS = "unavailable";

/**
 * Terminal connection statuses that must NEVER be auto-recovered — they stay
 * unavailable until credentials/settings change or an operator resets them.
 * Mirrors `isTerminalConnectionStatus` (src/sse/services/auth.ts) and
 * `TERMINAL_STATUSES` (src/lib/db/providers.ts::clearStaleCrashCooldowns).
 *
 * NOTE: `credits_exhausted` is NOT terminal for metered providers (Antigravity,
 * Gemini) whose quotas reset on a time window. It is recovered by a separate
 * periodic probe — see `isCreditsExhaustedReprobeCandidate` below.
 */
export const TERMINAL_CONNECTION_STATUSES = new Set<string>(["banned", "expired"]);

/**
 * Status that marks an account as out of metered credits. Unlike terminal
 * statuses, credits reset on a time window (daily RPD, monthly quota, etc.)
 * so these accounts must be re-probed periodically.
 */
export const CREDITS_EXHAUSTED_STATUS = "credits_exhausted";

/**
 * How long to wait before re-probing a credits_exhausted connection.
 * Default: 30 minutes. Antigravity/Gemini RPD windows are daily, but probing
 * sooner catches manual quota resets (new billing cycle, plan upgrade, etc.).
 */
const DEFAULT_CREDITS_REPROBE_MS = 30 * 60 * 1000;

/**
 * How long to wait before re-probing a Claude subscription weekly-quota park.
 * Default: 5 minutes. A weekly 429 persists `rate_limited_until` at the window
 * end (days away). The evidence-based recovery that detects an *early*,
 * out-of-band reset (maybeClearRecoveredQuotaState / #17043) only runs on a
 * live usage fetch, which is otherwise driven solely by the ~70-minute
 * background sync scheduler. Without this re-probe an account that was reset
 * early stayed parked for up to one or two sync cycles (≈70–140 min) until an
 * operator manually cleared it. Re-probing on the fast (≈60s) recovery tick at
 * this cadence drives that same evidence check within ~5 minutes. It does NOT
 * clear the cooldown blindly: fetchAndPersistProviderLimits only releases the
 * park on positive replenishment evidence, preserving the hard-statement rule
 * that a real upstream 429 cooldown is authoritative (#11277).
 */
const DEFAULT_CLAUDE_WEEKLY_REPROBE_MS = 5 * 60 * 1000;

/** Minimal connection shape needed to decide recoverability. */
export interface RecoverableConnectionInput {
  id: string;
  testStatus?: string | null;
  rateLimitedUntil?: string | null;
  lastErrorAt?: string | null;
  lastErrorType?: string | null;
  /** The provider slug (e.g. "claude"). Used to scope the Claude weekly-quota re-probe. */
  provider?: string | null;
  /** The persisted upstream error text, used to confirm weekly-quota provenance (#11277). */
  lastError?: string | null;
  /** The persisted upstream HTTP status (e.g. 429). */
  errorCode?: string | number | null;
  /** A Google "verify your account" link is stored (Antigravity 403 VALIDATION_REQUIRED). */
  verificationPending?: boolean;
}

/** Project a provider-connection row onto the fields the recovery tick reads. */
export function toRecoverableConnectionInput(
  row: Record<string, unknown>
): RecoverableConnectionInput {
  return {
    id: typeof row.id === "string" ? row.id : "",
    testStatus: typeof row.testStatus === "string" ? row.testStatus : null,
    rateLimitedUntil: typeof row.rateLimitedUntil === "string" ? row.rateLimitedUntil : null,
    lastErrorAt: typeof row.lastErrorAt === "string" ? row.lastErrorAt : null,
    lastErrorType: typeof row.lastErrorType === "string" ? row.lastErrorType : null,
    provider: typeof row.provider === "string" ? row.provider : null,
    lastError: typeof row.lastError === "string" ? row.lastError : null,
    errorCode:
      typeof row.errorCode === "string" || typeof row.errorCode === "number" ? row.errorCode : null,
    verificationPending: readStoredVerificationUrl(row.providerSpecificData) !== null,
  };
}

function normalizeStatus(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

/**
 * Parse a stored timestamp (ISO string, numeric epoch, or epoch string) into
 * epoch ms. Tolerates the same shapes as cooldownUntilMs — the
 * last_error_at / rate_limited_until TEXT columns hold mixed encodings
 * (#3954) — but is named for what it is: any persisted instant.
 */
function parseStoredInstant(value: string | null | undefined): number {
  return cooldownUntilMs(value);
}

/**
 * True when `rateLimitedUntil` is set and its instant is at or before `nowMs`
 * (the cooldown window has elapsed). Tolerates ISO strings and numeric-epoch
 * strings — the `rate_limited_until` TEXT column can hold either (#3954).
 */
function hasElapsedCooldown(rateLimitedUntil: string | null | undefined, nowMs: number): boolean {
  if (!rateLimitedUntil) return false;
  const ms = cooldownUntilMs(rateLimitedUntil);
  return Number.isFinite(ms) && ms <= nowMs;
}

/**
 * Transient test statuses whose stale label can be proactively cleared once
 * any cooldown window has elapsed:
 *   - 'unavailable' — the classic markAccountUnavailable() cooldown status
 *   - 'error' — a failed connection test (probe/upstream error). #9623 gives
 *     these a 30s cooldown; after it elapses (or when the row predates that
 *     fix and carries no cooldown at all), the label is stale visual noise:
 *     request-path selection never filtered on it in the first place, so the
 *     recovery tick clears it to keep the dashboard honest.
 */
const RECOVERABLE_TRANSIENT_STATUSES = new Set([RECOVERABLE_COOLDOWN_STATUS, "error"]);

/**
 * Grace period after a test failure before a no-cooldown 'error' label becomes
 * recoverable: the #9623 cooldown write and the recovery tick race, so a
 * label younger than this window is left alone (avoids healthy→error flicker
 * when the cooldown write is delayed or failed).
 */
const ERROR_LABEL_GRACE_MS = 60 * 1000;

/**
 * Decide whether a single connection is a proactive-recovery candidate:
 *   - has a real id, AND
 *   - testStatus is a transient cooldown status ('unavailable' / 'error'), AND
 *   - the cooldown window has elapsed — for 'unavailable' that means
 *     rateLimitedUntil is set and in the past; for 'error' a missing
 *     rateLimitedUntil (pre-#9623 rows) counts as elapsed once the label is
 *     older than the grace period, AND
 *   - is NOT in a terminal state (banned / expired).
 *
 * Pure — `nowMs` is injected so callers/tests control the clock.
 */
export function isRecoverableCooldownConnection(
  connection: RecoverableConnectionInput | null | undefined,
  nowMs: number
): boolean {
  if (!connection || typeof connection.id !== "string" || connection.id.length === 0) {
    return false;
  }
  const status = normalizeStatus(connection.testStatus);
  if (!RECOVERABLE_TRANSIENT_STATUSES.has(status)) return false;
  if (TERMINAL_CONNECTION_STATUSES.has(status)) return false; // defensive; transient statuses are never terminal
  // Not stale noise: Google still blocks the account until it is verified, and a passing
  // connection test (which drops the stored link) is what clears this label.
  if (connection.verificationPending === true) return false;
  if (status === RECOVERABLE_COOLDOWN_STATUS) {
    return hasElapsedCooldown(connection.rateLimitedUntil, nowMs);
  }
  // 'error': cooldown elapsed, or no cooldown recorded at all (stale label)
  // once the label itself is past the grace period. A row with NEITHER
  // cooldown NOR timestamp is unverifiable — leave it alone (conservative:
  // a bad write to lastErrorAt must not flip a fresh error back to healthy).
  if (!connection.rateLimitedUntil) {
    const sinceMs = parseStoredInstant(connection.lastErrorAt);
    if (Number.isFinite(sinceMs) && sinceMs > 0) {
      return nowMs - sinceMs >= ERROR_LABEL_GRACE_MS;
    }
    return false;
  }
  return hasElapsedCooldown(connection.rateLimitedUntil, nowMs);
}

/**
 * Decide whether a credits_exhausted connection is due for a re-probe:
 *   - has a real id, AND
 *   - testStatus === 'credits_exhausted', AND
 *   - enough time has passed since it was marked (lastErrorAt or rateLimitedUntil),
 *     defaulting to 30 min if no timestamp is available (always reprobe on first tick).
 *
 * Pure — `nowMs` and `reprobeMs` are injected so callers/tests control the clock.
 */

export const EXPIRED_REPROBE_BLOCKLIST = new Set([
  "account_deactivated",
  "invalid_grant",
  "unrecoverable_refresh_error",
  "provider_deprecated",
  "no_refresh_token",
]);

/**
 * Re-probe `expired` after the same window as credits_exhausted.
 * API-key 401s and OAuth races were persisted as expired and then never
 * retried (combo pre-skip + health-check skip). Do not reopen a real
 * deactivation / invalid_grant.
 */
export function isExpiredReprobeCandidate(
  connection: RecoverableConnectionInput | null | undefined,
  nowMs: number,
  reprobeMs: number = DEFAULT_CREDITS_REPROBE_MS
): boolean {
  if (!connection || typeof connection.id !== "string" || connection.id.length === 0) {
    return false;
  }
  if (normalizeStatus(connection.testStatus) !== "expired") return false;
  const err = (connection.lastErrorType || "").trim().toLowerCase();
  if (EXPIRED_REPROBE_BLOCKLIST.has(err)) return false;
  const sinceMs = cooldownUntilMs(connection.lastErrorAt || connection.rateLimitedUntil || "");
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) return true;
  return nowMs - sinceMs >= reprobeMs;
}

export function isCreditsExhaustedReprobeCandidate(
  connection: RecoverableConnectionInput | null | undefined,
  nowMs: number,
  reprobeMs: number = DEFAULT_CREDITS_REPROBE_MS
): boolean {
  if (!connection || typeof connection.id !== "string" || connection.id.length === 0) {
    return false;
  }
  const status = normalizeStatus(connection.testStatus);
  if (status !== CREDITS_EXHAUSTED_STATUS) return false;
  // Use lastErrorAt (when the 429 happened) as the cooldown start; fall back
  // to rateLimitedUntil, then to 0 (always reprobe if no timestamp).
  const sinceMs = cooldownUntilMs(connection.lastErrorAt || connection.rateLimitedUntil || "");
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) return true; // no timestamp → reprobe
  return nowMs - sinceMs >= reprobeMs;
}

/**
 * True when a Claude subscription weekly-quota park is due for an evidence-based
 * re-probe. The park persists `rate_limited_until` at the (days-away) weekly
 * window end, so its cooldown has NOT elapsed; the fast recovery tick must
 * therefore drive the live usage fetch that can detect an early, out-of-band
 * reset (maybeClearRecoveredQuotaState / #17043) instead of waiting for the
 * ~70-minute background sync. Scoped tightly to the Claude weekly-429 signal so
 * it never re-probes an RPM or monthly-spend cooldown.
 */
export function isClaudeWeeklyQuotaReprobeCandidate(
  connection: RecoverableConnectionInput | null | undefined,
  nowMs: number,
  reprobeMs: number = DEFAULT_CLAUDE_WEEKLY_REPROBE_MS,
  lastReprobeAtMs: number | null = null
): boolean {
  if (!connection || typeof connection.id !== "string" || connection.id.length === 0) {
    return false;
  }
  if (normalizeStatus(connection.testStatus) !== RECOVERABLE_COOLDOWN_STATUS) return false;
  if (normalizeStatus(connection.provider) !== "claude") return false;
  const err = (connection.lastErrorType || "").trim().toLowerCase();
  if (err !== "quota_exhausted" && err !== "rate_limited") return false;
  if (Number(connection.errorCode) !== 429) return false;
  if (!isClaudeWeeklyQuota429Signal(connection.lastError)) return false;
  // Only while the persisted cooldown is still in the future: an elapsed
  // cooldown is already handled by the cheap clear path, so the two sets stay
  // disjoint and we never double-handle a connection.
  if (hasElapsedCooldown(connection.rateLimitedUntil, nowMs)) return false;
  // Pace off the LAST RE-PROBE this process performed, not lastErrorAt. A live
  // fetch that still sees the window exhausted never rewrites lastErrorAt, so
  // gating on it would re-probe every tick instead of every reprobeMs. The
  // first probe (no prior attempt recorded) fires on this tick.
  if (lastReprobeAtMs === null || !Number.isFinite(lastReprobeAtMs)) return true;
  return nowMs - lastReprobeAtMs >= reprobeMs;
}

/**
 * Per-connection time of the last Claude weekly-quota re-probe this process
 * issued. Process-local on purpose: losing it on restart only causes one extra
 * probe per park, which is cheap and safe; the evidence gate still decides.
 */
function getLastReprobeMap(): Map<string, number> {
  const state = getRecoveryState() as { lastReprobeAt?: Map<string, number> };
  if (!state.lastReprobeAt) state.lastReprobeAt = new Map<string, number>();
  return state.lastReprobeAt;
}

/**
 * From a list of connections, return only those whose transient cooldown has
 * elapsed OR whose credits_exhausted status is due for a re-probe.
 * Pure, non-mutating, time injected.
 */
export function selectRecoverableConnections<T extends RecoverableConnectionInput>(
  connections: readonly T[] | null | undefined,
  nowMs: number
): T[] {
  if (!Array.isArray(connections)) return [];
  return connections.filter(
    (connection) =>
      isRecoverableCooldownConnection(connection, nowMs) ||
      isCreditsExhaustedReprobeCandidate(connection, nowMs) ||
      isExpiredReprobeCandidate(connection, nowMs)
  );
}

/** Result of one recovery tick (handy for logging / tests of the wiring). */
export interface ConnectionRecoveryTickResult {
  scanned: number;
  recovered: number;
  recoveredIds: string[];
  /** Claude weekly-quota parks re-probed (evidence-based; not blindly cleared). */
  reprobed: number;
  reprobedIds: string[];
}

/**
 * Run one proactive-recovery pass: load active provider connections, select the
 * subset whose transient cooldown has elapsed, and clear their error state via
 * `clearAccountError` so they are eligible again before the next real request.
 *
 * Dependencies are injected (default to the real DB / auth modules) so the tick
 * can be unit-tested without a live database. Best-effort and never throws — a
 * failure to recover one connection must not abort the others or the scheduler.
 *
 * NOTE: not auto-started on import. The startup bootstrap is responsible for
 * scheduling it (see runConnectionRecoveryTick usage in the report).
 */
export async function runConnectionRecoveryTick(
  deps: {
    nowMs?: number;
    loadConnections?: () => Promise<RecoverableConnectionInput[]>;
    clearConnectionError?: (
      connectionId: string,
      current: RecoverableConnectionInput
    ) => Promise<void>;
    logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
    reprobeConnection?: (connectionId: string) => Promise<void>;
    /** Per-connection last re-probe time (ms). Defaults to process-wide state. */
    lastReprobeAt?: Map<string, number>;
  } = {}
): Promise<ConnectionRecoveryTickResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const result: ConnectionRecoveryTickResult = {
    scanned: 0,
    recovered: 0,
    recoveredIds: [],
    reprobed: 0,
    reprobedIds: [],
  };

  let connections: RecoverableConnectionInput[];
  try {
    const load =
      deps.loadConnections ??
      (async () => {
        // Lazy import keeps this module loadable (and the pure helpers testable)
        // without a full DB/auth graph.
        const { getProviderConnections } = await import("@/lib/db/providers");
        // Load both active and inactive — inactive connections may be
        // credits_exhausted and due for a re-probe.
        const [activeRows, inactiveRows] = await Promise.all([
          getProviderConnections({ isActive: true }) as Promise<Array<Record<string, unknown>>>,
          getProviderConnections({ isActive: false }) as Promise<Array<Record<string, unknown>>>,
        ]);
        const rows = [...(activeRows || []), ...(inactiveRows || [])];
        return (Array.isArray(rows) ? rows : []).map(toRecoverableConnectionInput);
      });
    connections = await load();
  } catch (err) {
    deps.logger?.warn?.(
      `[ConnectionRecovery] failed to load connections: ${err instanceof Error ? err.message : String(err)}`
    );
    return result;
  }

  result.scanned = connections.length;
  const recoverable = selectRecoverableConnections(connections, nowMs);
  const lastReprobe = deps.lastReprobeAt ?? getLastReprobeMap();
  const reprobeCandidates = connections.filter((connection) =>
    isClaudeWeeklyQuotaReprobeCandidate(
      connection,
      nowMs,
      DEFAULT_CLAUDE_WEEKLY_REPROBE_MS,
      lastReprobe.get(connection.id) ?? null
    )
  );
  if (recoverable.length === 0 && reprobeCandidates.length === 0) return result;

  const clear =
    deps.clearConnectionError ??
    (async (connectionId: string, current: RecoverableConnectionInput) => {
      const { clearAccountError } = await import("@/sse/services/auth");
      await clearAccountError(connectionId, current);
    });

  for (const connection of recoverable) {
    try {
      await clear(connection.id, connection);
      result.recovered += 1;
      result.recoveredIds.push(connection.id);
    } catch (err) {
      deps.logger?.warn?.(
        `[ConnectionRecovery] failed to recover ${connection.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // The re-probe itself is injected (wired by the startup bootstrap) so this
  // core lib leaf never couples to the heavy provider-limits (DB/network/
  // executor) module graph. The injected probe does NOT clear the cooldown
  // directly: the live usage fetch releases the park only on positive
  // replenishment evidence (maybeClearRecoveredQuotaState / #17043), honouring
  // the rule that a real upstream 429 cooldown is authoritative (#11277).
  const reprobe = deps.reprobeConnection;
  if (reprobe && reprobeCandidates.length > 0) {
    for (const connection of reprobeCandidates) {
      // Stamp the attempt BEFORE awaiting, so a slow or failing probe still
      // counts toward pacing and cannot cause a per-tick retry storm.
      lastReprobe.set(connection.id, nowMs);
      try {
        await reprobe(connection.id);
        result.reprobed += 1;
        result.reprobedIds.push(connection.id);
      } catch (err) {
        deps.logger?.warn?.(
          `[ConnectionRecovery] failed to re-probe ${connection.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  if (result.recovered > 0) {
    deps.logger?.info?.(
      `[ConnectionRecovery] proactively restored ${result.recovered} connection(s) with elapsed cooldown`
    );
  }
  if (result.reprobed > 0) {
    deps.logger?.info?.(
      `[ConnectionRecovery] re-probed ${result.reprobed} Claude weekly-quota park(s) for an early reset`
    );
  }
  return result;
}

// ── Scheduler (opt-out, low frequency) ──────────────────────────────────────
// Mirrors src/lib/tokenHealthCheck.ts: a globalThis-guarded singleton so HMR /
// double-import never stacks timers, an unref'd interval so it never holds the
// process open, and a self-disable in build/test processes. NOT auto-started on
// import — startup bootstrap calls initConnectionRecoveryScheduler().

const DEFAULT_TICK_MS = 60 * 1000; // re-validate elapsed cooldowns every 60s
const MIN_TICK_MS = 5 * 1000; // floor to avoid hot-looping if misconfigured
const RECOVERY_LOG_PREFIX = "[ConnectionRecovery]";
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

declare global {
  var __omnirouteConnRecovery:
    { initialized: boolean; interval: ReturnType<typeof setInterval> | null } | undefined;
}

function getRecoveryState() {
  if (!globalThis.__omnirouteConnRecovery) {
    globalThis.__omnirouteConnRecovery = { initialized: false, interval: null };
  }
  return globalThis.__omnirouteConnRecovery;
}

function isEnvFlagEnabled(name: string): boolean {
  const value = typeof process !== "undefined" ? process.env[name] : undefined;
  return !!value && TRUE_ENV_VALUES.has(value.trim().toLowerCase());
}

function isBuildProcess(): boolean {
  return typeof process !== "undefined" && process.env.NEXT_PHASE === "phase-production-build";
}

function isRecoverySchedulerDisabled(): boolean {
  return (
    isEnvFlagEnabled("OMNIROUTE_DISABLE_CONNECTION_RECOVERY") ||
    isEnvFlagEnabled("OMNIROUTE_DISABLE_BACKGROUND_SERVICES") ||
    isBuildProcess() ||
    isAutomatedTestProcess()
  );
}

/**
 * Resolve the tick interval (ms) from OMNIROUTE_CONNECTION_RECOVERY_INTERVAL_MS,
 * falling back to the 60s default and clamping to a small floor.
 */
export function resolveConnectionRecoveryIntervalMs(
  rawValue: string | undefined = typeof process !== "undefined"
    ? process.env.OMNIROUTE_CONNECTION_RECOVERY_INTERVAL_MS
    : undefined
): number {
  if (!rawValue) return DEFAULT_TICK_MS;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TICK_MS;
  return Math.max(MIN_TICK_MS, Math.floor(parsed));
}

/**
 * Start the proactive connection-recovery scheduler (idempotent). No-op in
 * build/test processes or when disabled via env. Each tick runs
 * runConnectionRecoveryTick() against the real DB.
 */
export function initConnectionRecoveryScheduler(
  options: {
    /**
     * Live re-probe for a Claude weekly-quota park, injected by the startup
     * bootstrap so this core lib leaf never statically couples to the heavy
     * provider-limits module graph. When omitted, weekly parks are left to the
     * slower background sync (unchanged legacy behaviour).
     */
    reprobeConnection?: (connectionId: string) => Promise<void>;
  } = {}
): void {
  const state = getRecoveryState();
  if (state.initialized || isRecoverySchedulerDisabled()) return;
  state.initialized = true;

  const tickMs = resolveConnectionRecoveryIntervalMs();
  const tickLogger = {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
  };

  const runTick = () => {
    runConnectionRecoveryTick({
      logger: tickLogger,
      reprobeConnection: options.reprobeConnection,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${RECOVERY_LOG_PREFIX} tick error (non-fatal): ${msg}`);
    });
  };

  console.log(
    `${RECOVERY_LOG_PREFIX} Starting proactive cooldown recovery (tick every ${Math.round(tickMs / 1000)}s)`
  );

  // Delay the first tick a little so it never piles onto cold-start work.
  const timer = setTimeout(() => {
    runTick();
    state.interval = setInterval(runTick, tickMs);
    (state.interval as { unref?: () => void } | undefined)?.unref?.();
  }, 15_000);
  (timer as { unref?: () => void } | undefined)?.unref?.();
}

/** Stop the scheduler (tests / hot-reload). */
export function stopConnectionRecoveryScheduler(): void {
  const state = getRecoveryState();
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
  state.initialized = false;
}
