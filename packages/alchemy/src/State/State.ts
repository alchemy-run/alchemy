import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ActionState } from "./ActionState.ts";
import type { DeploymentStore } from "./Deployment.ts";
import type { ReplacedResourceState, ResourceState } from "./ResourceState.ts";

/**
 * Anything persistable under an FQN. Resources are discriminated by status
 * strings ("creating", "created", …) and Tasks by `kind: "action"`.
 */
export type PersistedState = ResourceState | ActionState;

export const isActionState = (
  s: PersistedState | undefined,
): s is ActionState => !!s && (s as any).kind === "action";

export const isResourceState = (
  s: PersistedState | undefined,
): s is ResourceState => !!s && (s as any).kind !== "task";

export class StateStoreError extends Data.TaggedError("StateStoreError")<{
  message: string;
  cause?: Error;
}> {}

/**
 * # StateWriteFence
 *
 * The optional `fence` on {@link StateService.set} / `delete` /
 * `setOutput` is a fencing token guarding head state against zombie
 * writers — the classic lease problem: a deploy pauses (GC, laptop lid,
 * network partition), its heartbeat lapses, a new deploy takes over the
 * stage, and then the old deploy wakes up and keeps writing.
 *
 * The token is the deployment version, which every backend already
 * allocates monotonically per `(stack, stage)` at `deployments.begin`.
 * A write carrying `fence: F` must be REJECTED once any version `> F`
 * has been begun — the newer begin supersedes the older lease, and
 * versions are never re-used, so the check is a plain comparison
 * against the newest allocated version.
 *
 * Enforcement strength is per backend:
 * - in-memory and the Cloudflare Durable Object check atomically with
 *   the write (single-threaded arbiter) — perfect fencing;
 * - local FS and S3 check the newest version immediately before the
 *   write — a small check-then-write window remains, so fencing is
 *   best-effort there (still a categorical improvement: a zombie that
 *   lost its lease minutes ago is caught by the very next write).
 *
 * A rejected write fails with a {@link StateStoreError} built by
 * {@link fencedWriteRejected}; the engine treats it like any other
 * fatal state write failure and aborts the zombie deploy.
 *
 * Writes WITHOUT `fence` (dashboards, CLIs, repair tooling, stores
 * that predate fencing) bypass the check — the fence protects against
 * *stale deploy sessions*, not against explicit operator writes.
 */
export const fencedWriteRejected = (request: {
  stack: string;
  stage: string;
  fence: number;
}): StateStoreError =>
  new StateStoreError({
    message:
      `fenced write rejected: deployment v${request.fence} of ` +
      `${request.stack}/${request.stage} has been superseded by a newer deployment`,
  });

/**
 * Wrap a state decode failure (malformed JSON, missing/wrong
 * `ALCHEMY_PASSWORD` for encrypted `__secret__` envelopes) in a
 * {@link StateStoreError}. Shared by every client-side store so decode
 * failures carry the same message shape everywhere.
 */
export const stateDecodeError = (what: string) => (cause: unknown) =>
  new StateStoreError({
    message: `Failed to decode state '${what}': ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    cause: cause instanceof Error ? cause : undefined,
  });

export class State extends Context.Service<
  State,
  Effect.Effect<StateService>
>()("alchemy/State") {}

/**
 * State service interface.
 *
 * Resources are keyed by FQN (namespace-qualified key) which includes
 * the full namespace path plus the logical ID. The FQN is used as the
 * storage key while logicalId remains available in the persisted state
 * for provider operations.
 */
export interface StateService {
  /**
   * Stable identifier for the State store implementation, used for
   * telemetry tagging (`alchemy.state_store.id`) so we can answer
   * "which backends are people using" without hard-coding a closed
   * union. Examples: `"local"`, `"inmemory"`, `"http"`,
   * `"cloudflare-http"`. Third-party state stores should pick a short,
   * stable, kebab-case slug.
   */
  readonly id: string;
  /**
   * Wire / behavioural contract version of this state-store
   * implementation. For local / in-process stores this is the
   * `STATE_STORE_VERSION` the CLI was built against; for HTTP-backed
   * stores it is the version reported by the deployed `/version`
   * probe.
   */
  getVersion(): Effect.Effect<number, StateStoreError, never>;
  listStacks(): Effect.Effect<readonly string[], StateStoreError, never>;
  listStages(
    stack: string,
  ): Effect.Effect<readonly string[], StateStoreError, never>;
  /**
   * Get a resource by its FQN (namespace-qualified key).
   */
  get(request: {
    stack: string;
    stage: string;
    fqn: string;
  }): Effect.Effect<PersistedState | undefined, StateStoreError, never>;
  /**
   * List top-level resources that are still in replacement cleanup.
   *
   * Any additional backlog from repeated replacements is stored recursively
   * in the returned state's `old` chain.
   */
  getReplacedResources(request: {
    stack: string;
    stage: string;
  }): Effect.Effect<
    ReadonlyArray<ReplacedResourceState>,
    StateStoreError,
    never
  >;
  /**
   * Set a resource by its FQN (namespace-qualified key).
   *
   * `fence` (optional, feature-detected): the deployment version whose
   * lease authorizes this write — see {@link StateWriteFence}.
   */
  set<V extends PersistedState>(request: {
    stack: string;
    stage: string;
    fqn: string;
    value: V;
    fence?: number;
  }): Effect.Effect<V, StateStoreError, never>;
  /**
   * Delete a resource by its FQN (namespace-qualified key).
   *
   * `fence` (optional): see {@link StateWriteFence}.
   */
  delete(request: {
    stack: string;
    stage: string;
    fqn: string;
    fence?: number;
  }): Effect.Effect<void, StateStoreError, never>;
  /**
   * Delete an entire stack, or a single stage when `stage` is provided.
   */
  deleteStack(request: {
    stack: string;
    stage?: string;
  }): Effect.Effect<void, StateStoreError, never>;
  /**
   * List all resource FQNs in a stack/stage.
   */
  list(request: {
    stack: string;
    stage: string;
  }): Effect.Effect<readonly string[], StateStoreError, never>;
  /**
   * Read the persisted stack output for `(stack, stage)`. Returns
   * `undefined` when the stack has not been deployed (or has been
   * destroyed) at this stage.
   *
   * Stack outputs are written by `apply` once the deploy succeeds and
   * read by cross-stack references (`yield* OtherStack` /
   * `OtherStack.stage.<name>` / `Output.stackRef(...)`).
   */
  getOutput(request: {
    stack: string;
    stage: string;
  }): Effect.Effect<unknown, StateStoreError, never>;
  /**
   * Persist the resolved stack output for `(stack, stage)`.
   *
   * `fence` (optional): see {@link StateWriteFence}.
   */
  setOutput(request: {
    stack: string;
    stage: string;
    value: unknown;
    fence?: number;
  }): Effect.Effect<unknown, StateStoreError, never>;
  /**
   * Read every resource in a stack/stage in one call.
   *
   * Optional (feature-detected): the dashboard and other batch readers use
   * this to avoid the N+1 `list` + per-fqn `get` pattern; when absent,
   * callers fall back to that pattern. All in-repo backends implement it.
   */
  getAll?(request: {
    stack: string;
    stage: string;
  }): Effect.Effect<
    ReadonlyMap<string, PersistedState>,
    StateStoreError,
    never
  >;
  /**
   * Deployment history (versioned journal of every deploy/destroy).
   *
   * Optional (feature-detected): older or third-party state stores may not
   * implement it, in which case the engine skips journaling and the
   * dashboard's history views are unavailable. See {@link DeploymentStore}
   * for the semantics every implementation must uphold.
   */
  deployments?: DeploymentStore;
}
