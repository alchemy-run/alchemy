import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ReplacedResourceState, ResourceState } from "./ResourceState.ts";

export class StateStoreError extends Data.TaggedError("StateStoreError")<{
  message: string;
  cause?: Error;
}> {}

export class State extends Context.Service<State, StateService>()(
  "alchemy/State",
) {}

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
  }): Effect.Effect<ResourceState | undefined, StateStoreError, never>;
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
   */
  set<V extends ResourceState>(request: {
    stack: string;
    stage: string;
    fqn: string;
    value: V;
  }): Effect.Effect<V, StateStoreError, never>;
  /**
   * Delete a resource by its FQN (namespace-qualified key).
   */
  delete(request: {
    stack: string;
    stage: string;
    fqn: string;
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
}
