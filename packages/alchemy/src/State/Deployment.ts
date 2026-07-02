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
