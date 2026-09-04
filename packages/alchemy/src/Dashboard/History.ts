import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { StateStoreError } from "../State/State.ts";

/**
 * Deployment history — the optional durable spine of the dashboard.
 *
 * A {@link DeploymentHistory} records every deployment of a `(stack, stage)`
 * as a monotonically-versioned lifecycle record plus an append-only journal
 * of events ({@link DeploymentEvent}). The dashboard consumes it read-only:
 * the live document hydrates from the newest record's journal (so a restart
 * mid-deploy rebuilds the in-flight picture, and a closed record restores
 * the last run's decorations), and the deployment picker folds any past
 * version's journal over the current structure.
 *
 * It is feature-detected everywhere: the server and viewer take an optional
 * `history`, and without one the history endpoints 404 while everything
 * else (structure, live apply events, outputs, approvals) keeps working.
 * State stores that journal deployments plug in here; the write half
 * (`begin` / `appendEvents` / `heartbeat` / `end`) is the engine's concern
 * and deliberately not part of this read contract.
 */
export interface DeploymentHistory {
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
 * Who/what started a deployment — recorded when the deployment opens,
 * immutable for its lifetime.
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
 * Terminal outcome supplied by the engine when it closes a deployment.
 * Stores add `"abandoned"` (stale-open reconciliation) and
 * `"completed-late"` (closed after abandonment) on their own.
 */
export type DeploymentEndOutcome = "succeeded" | "failed" | "interrupted";

export type DeploymentOutcome =
  | DeploymentEndOutcome
  | "abandoned"
  | "completed-late";

/** Optional rollup recorded at close, denormalized for cheap list views. */
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
  /** Epoch millis when the deployment opened. */
  startedAt: number;
  /** Epoch millis of the most recent heartbeat (or open). */
  heartbeatAt: number;
  /** Epoch millis at close (engine end or store reconciliation). */
  endedAt?: number;
  outcome?: DeploymentOutcome;
  summary?: DeploymentSummary;
}

/**
 * One journaled event. The writer assigns `seq` (contiguous from 1 within a
 * deployment) and stamps `ts` at emission. `fqn` identifies the resource
 * for resource-scoped events and is absent for deployment-scoped ones
 * (deployment-start/end, annotations).
 *
 * The `payload` is deliberately open at the storage layer: stores persist
 * and return it verbatim. The event vocabulary the dashboard folds
 * ({@link import("./Event.ts").DashboardEvent}) is layered on top and
 * versioned independently, so the storage contract never churns when the
 * vocabulary grows.
 */
export interface DeploymentEvent {
  seq: number;
  /** Epoch millis at emission (not receipt). */
  ts: number;
  fqn?: string;
  payload: unknown;
}

/** The referenced deployment version does not exist. */
export class DeploymentNotFound extends Data.TaggedError("DeploymentNotFound")<{
  stack: string;
  stage: string;
  version: number;
}> {}
