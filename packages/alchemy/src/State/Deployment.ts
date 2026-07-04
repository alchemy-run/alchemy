import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { StateStoreError } from "./State.ts";

/**
 * Deployment history — the durable spine of the dashboard (and any other
 * frontend: TUI, native app). A state store that implements
 * {@link DeploymentStore} records every deployment of a `(stack, stage)` as
 * a monotonically-versioned, append-only journal of events plus an
 * open/closed lifecycle record.
 *
 * Design invariants (the conformance suite in
 * `test/State/deploymentStoreConformance.ts` enforces these against every
 * backend):
 *
 * - **Versions are monotonic per `(stack, stage)`**, allocated atomically at
 *   {@link DeploymentStore.begin}. Two racing `begin` calls never receive the
 *   same version.
 * - **At most one live deployment per `(stack, stage)`**: `begin` fails with
 *   {@link DeploymentInProgress} while an open version's heartbeat is fresh.
 *   Opens whose heartbeat is older than `ttlMillis` are reconciled to
 *   `"abandoned"` by the next `begin`.
 * - **Idempotent writes**: `appendEvents` dedupes by `seq` (retrying a batch
 *   after a crash never duplicates events); `end` tolerates repeat calls and
 *   already-abandoned versions (recorded as `"completed-late"`).
 * - **Crash-safe without `end`**: the open marker carries a heartbeat; a
 *   deploy that dies without calling `end` is detected and closed as
 *   `"abandoned"` by the next `begin`.
 */
export interface DeploymentStore {
  /**
   * Allocate the next version for `(stack, stage)` and open it.
   *
   * Reconciles stale opens (heartbeat older than `ttlMillis`) as
   * `"abandoned"` before allocating. Fails with {@link DeploymentInProgress}
   * when a live open version exists.
   */
  begin(request: {
    stack: string;
    stage: string;
    meta: DeploymentMeta;
    /**
     * Age in milliseconds after which an open deployment with no heartbeat
     * is considered abandoned.
     * @default 60_000
     */
    ttlMillis?: number;
    /**
     * Take over one specific open version: when the live open version is
     * exactly `supersede`, it is reconciled to `"abandoned"` regardless of
     * heartbeat freshness and the claim proceeds. Any OTHER live open still
     * fails {@link DeploymentInProgress}.
     *
     * This is the targeted takeover primitive for the engine's same-host
     * dead-pid recovery: the caller first observed `DeploymentInProgress`,
     * proved the holder cannot be alive (same host, pid gone), and retries
     * with the holder's version. Pinning the version (instead of a blanket
     * `ttlMillis: 0`) makes the takeover race-free — if a different deploy
     * claimed the stage in between, the versions no longer match and the
     * retry fails {@link DeploymentInProgress} like any other begin.
     */
    supersede?: number;
  }): Effect.Effect<
    { version: number; token: string },
    DeploymentInProgress | StateStoreError
  >;

  /**
   * Append a batch of events to an open deployment's journal.
   *
   * Idempotent per `seq`: events whose `seq` has already been stored are
   * ignored, so a crashed/retried batch never duplicates. Returns the
   * highest stored `seq`. Appends to an ended deployment are accepted
   * (journal completeness beats strictness — a deploy that lost its
   * heartbeat may still be flushing), but the token must match.
   */
  appendEvents(request: {
    stack: string;
    stage: string;
    version: number;
    token: string;
    events: readonly DeploymentEvent[];
  }): Effect.Effect<
    { ackedSeq: number },
    DeploymentTokenInvalid | DeploymentNotFound | StateStoreError
  >;

  /**
   * Refresh the open marker's heartbeat (liveness for concurrency control
   * and crash detection). A heartbeat against an already-ended deployment
   * is a silent no-op.
   */
  heartbeat(request: {
    stack: string;
    stage: string;
    version: number;
    token: string;
  }): Effect.Effect<
    void,
    DeploymentTokenInvalid | DeploymentNotFound | StateStoreError
  >;

  /**
   * Close a deployment. Idempotent: repeat calls with the same outcome are
   * no-ops; ending a version that was already reconciled to `"abandoned"`
   * records `"completed-late"` (preserving that the heartbeat was lost)
   * rather than failing.
   */
  end(request: {
    stack: string;
    stage: string;
    version: number;
    token: string;
    outcome: DeploymentEndOutcome;
    summary?: DeploymentSummary;
  }): Effect.Effect<
    void,
    DeploymentTokenInvalid | DeploymentNotFound | StateStoreError
  >;

  /**
   * List deployment records for `(stack, stage)`, newest first. When
   * `before` is given, only versions strictly less than it are returned
   * (cursor pagination: pass the last record's version).
   */
  list(request: {
    stack: string;
    stage: string;
    before?: number;
    limit?: number;
  }): Effect.Effect<readonly DeploymentRecord[], StateStoreError>;

  /**
   * Read a single deployment record, or `undefined` when the version does
   * not exist.
   */
  get(request: {
    stack: string;
    stage: string;
    version: number;
  }): Effect.Effect<DeploymentRecord | undefined, StateStoreError>;

  /**
   * Read a deployment's journal ordered by `seq` ascending. `fromSeq` is
   * inclusive; omit to read from the start.
   */
  readEvents(request: {
    stack: string;
    stage: string;
    version: number;
    fromSeq?: number;
  }): Effect.Effect<
    readonly DeploymentEvent[],
    DeploymentNotFound | StateStoreError
  >;
}

/**
 * Who/what started a deployment — recorded at `begin`, immutable for the
 * deployment's lifetime.
 */
export interface DeploymentMeta {
  /** The engine command driving this deployment. */
  command: "deploy" | "destroy";
  /** Initiator identity for the Summary view's "who" column. */
  initiator?: {
    user?: string;
    host?: string;
    pid?: number;
  };
  /** Version of alchemy that ran the deployment. */
  alchemyVersion?: string;
  /** Git commit of the app repo, when resolvable. */
  gitCommit?: string;
}

/**
 * Terminal outcome supplied by the engine at {@link DeploymentStore.end}.
 * Stores add `"abandoned"` (stale-open reconciliation) and
 * `"completed-late"` (`end` after abandonment) on their own.
 */
export type DeploymentEndOutcome = "succeeded" | "failed" | "interrupted";

export type DeploymentOutcome =
  | DeploymentEndOutcome
  | "abandoned"
  | "completed-late";

/** Optional rollup recorded at `end`, denormalized for cheap list views. */
export interface DeploymentSummary {
  /** Count per apply action, e.g. `{ create: 3, update: 1, delete: 0 }`. */
  counts?: Record<string, number>;
  /** Short digest of the failure, when `outcome` is `"failed"`. */
  error?: string;
}

/**
 * A deployment's lifecycle record. `endedAt`/`outcome` are absent while the
 * deployment is open.
 */
export interface DeploymentRecord {
  stack: string;
  stage: string;
  version: number;
  meta: DeploymentMeta;
  /** Epoch millis at `begin`. */
  startedAt: number;
  /** Epoch millis of the most recent heartbeat (or `begin`). */
  heartbeatAt: number;
  /** Epoch millis at close (engine `end` or store reconciliation). */
  endedAt?: number;
  outcome?: DeploymentOutcome;
  summary?: DeploymentSummary;
}

/**
 * One journaled event. The engine assigns `seq` (contiguous from 1 within a
 * deployment) and stamps `ts` at emission. `fqn` identifies the resource for
 * resource-scoped events and is absent for deployment-scoped ones
 * (deployment-start/end, annotations).
 *
 * The `payload` is deliberately open at the storage layer: stores persist
 * and return it verbatim. The engine-side event schema (op-start/op-end,
 * status, note, log, annotation) is layered on top and versioned
 * independently, so the storage contract never churns when the event
 * vocabulary grows.
 */
export interface DeploymentEvent {
  seq: number;
  /** Epoch millis at emission (not receipt). */
  ts: number;
  fqn?: string;
  payload: unknown;
}

/**
 * A live deployment already holds `(stack, stage)`. Carries the holder's
 * record so callers can render who is deploying and since when.
 */
export class DeploymentInProgress extends Data.TaggedError(
  "DeploymentInProgress",
)<{
  stack: string;
  stage: string;
  holder: DeploymentRecord;
}> {}

/** The supplied token does not match the deployment's open token. */
export class DeploymentTokenInvalid extends Data.TaggedError(
  "DeploymentTokenInvalid",
)<{
  stack: string;
  stage: string;
  version: number;
}> {}

/** The referenced deployment version does not exist. */
export class DeploymentNotFound extends Data.TaggedError("DeploymentNotFound")<{
  stack: string;
  stage: string;
  version: number;
}> {}

/** Default heartbeat TTL for stale-open reconciliation. */
export const DEPLOYMENT_TTL_MILLIS = 60_000;

// ---------------------------------------------------------------------------
// Shared implementation helpers
//
// Every DeploymentStore backend (in-memory, local FS, S3, Cloudflare DO)
// enforces the same lifecycle semantics. The pure pieces of those semantics
// live here so the backends only implement storage mechanics.
// ---------------------------------------------------------------------------

/**
 * Internal record shape used by plaintext backends: the public record plus
 * the open bearer token. Backends that store the token differently (e.g.
 * the Cloudflare DO stores only a hash) define their own stored shape.
 */
export interface StoredDeploymentRecord extends DeploymentRecord {
  token: string;
}

/** Strip the token and deep-copy so callers never alias internal state. */
export const toPublicRecord = (
  record: StoredDeploymentRecord,
): DeploymentRecord => {
  const { token: _token, ...rest } = record;
  return structuredClone(rest);
};

/**
 * An open record whose heartbeat is at least `ttlMillis` old is stale and
 * gets reconciled to `"abandoned"` (by the next `begin`, or server-side
 * where the backend supports it). `ttlMillis: 0` therefore means "always
 * stale"; an ended record is never stale.
 */
export const isStaleOpen = (
  record: Pick<DeploymentRecord, "endedAt" | "heartbeatAt">,
  now: number,
  ttlMillis: number,
): boolean =>
  record.endedAt === undefined && now - record.heartbeatAt >= ttlMillis;

/**
 * May a `begin` abandon this open holder and claim the next version?
 *
 * Yes when the holder is stale ({@link isStaleOpen} — its heartbeat
 * lapsed), OR when the caller passed `supersede` naming exactly this
 * version: a targeted takeover where the caller proved out-of-band that
 * the holder is dead (e.g. same-host pid check), so even a fresh
 * heartbeat does not protect it. Any other live open wins and the begin
 * fails `DeploymentInProgress`.
 *
 * Every store MUST use this predicate (inside whatever atomic claim
 * primitive it has) so takeover semantics never drift between backends.
 */
export const shouldAbandonOpen = (
  record: Pick<DeploymentRecord, "endedAt" | "heartbeatAt" | "version">,
  now: number,
  ttlMillis: number,
  supersede: number | undefined,
): boolean =>
  isStaleOpen(record, now, ttlMillis) || record.version === supersede;

/**
 * The shared `end` transition: which outcome (if any) to record when the
 * engine closes a deployment.
 *
 * - Still open — record the engine's outcome.
 * - Already reconciled to `"abandoned"` — the engine finished after the
 *   store gave up on its heartbeat; preserve that fact as
 *   `"completed-late"`.
 * - Already ended with a real outcome — idempotent no-op (`undefined`),
 *   the first outcome wins.
 */
export const endTransition = (
  record: Pick<DeploymentRecord, "endedAt" | "outcome">,
  outcome: DeploymentEndOutcome,
): DeploymentOutcome | undefined =>
  record.endedAt === undefined
    ? outcome
    : record.outcome === "abandoned"
      ? "completed-late"
      : undefined;

/** Highest seq in a batch (0 for an empty batch). */
export const maxSeqOf = (events: readonly DeploymentEvent[]): number =>
  events.reduce((max, event) => (event.seq > max ? event.seq : max), 0);

/**
 * Per-instance hint cache powering the blind-claim fast path in `begin`
 * (S3 and local FS; single-arbiter stores don't need it).
 *
 * The invariant it encodes: versions are allocated contiguously and never
 * deleted, so if this instance's own `end` closed version N, an atomic
 * exclusive-create of N+1 succeeding PROVES no newer version — and
 * therefore no live open — exists, skipping the full observe loop.
 *
 * Policy (identical across stores, so decided once here):
 * - the hint is **single-shot**: `take` consumes it, so a failed claim can
 *   never be retried blindly — the caller falls back to the observe loop,
 *   which re-seeds nothing until the next `end`;
 * - `noteClosed` only advances: a late `end` of an old abandoned version
 *   never rolls the stage's high-water mark backwards;
 * - `invalidate` clears the hint when a version is observed OPEN (the
 *   fast path only applies after our own `end` closes it again).
 */
export class ClosedVersionHint {
  private readonly newest = new Map<string, number>();

  private key(ids: { stack: string; stage: string }): string {
    return `${ids.stack}\u0000${ids.stage}`;
  }

  /** Consume the hint for `(stack, stage)` — single-shot. */
  take(ids: { stack: string; stage: string }): number | undefined {
    const key = this.key(ids);
    const version = this.newest.get(key);
    this.newest.delete(key);
    return version;
  }

  /** Record that `version` is closed. Never rolls backwards. */
  noteClosed(ids: { stack: string; stage: string }, version: number): void {
    const key = this.key(ids);
    const prev = this.newest.get(key);
    if (prev === undefined || version > prev) {
      this.newest.set(key, version);
    }
  }

  /** Drop the hint — a version was observed open. */
  invalidate(ids: { stack: string; stage: string }): void {
    this.newest.delete(this.key(ids));
  }
}
