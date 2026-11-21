import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ClankaError } from "./Errors.ts";

export interface InstanceStore {
  /**
   * Identifies this instance among every instance of the harness: a Durable
   * Object's id. Conversation names are only unique within it.
   */
  readonly id: string;
  /** A conversation's saved state, as the harness last wrote it. */
  readonly get: (key: string) => Effect.Effect<string | undefined, ClankaError, RuntimeContext>;
  readonly put: (key: string, value: string) => Effect.Effect<void, ClankaError, RuntimeContext>;
  readonly delete: (key: string) => Effect.Effect<void, ClankaError, RuntimeContext>;
}

/**
 * Where a harness keeps its conversations: each one's history and where
 * its executor left off. A platform's Layer decides what survives a
 * restart.
 */
export class Store extends Context.Service<
  Store,
  {
    /**
     * The store of the instance yielding the harness. Runs where the
     * harness is yielded (a Durable Object's outer Effect, once per
     * instance); performs no I/O.
     */
    readonly instance: Effect.Effect<InstanceStore>;
  }
>()("Clanka.Store") {}

let memoryInstances = 0;

/**
 * Conversations kept in memory: they last as long as the process. For
 * tests and long-lived local processes.
 *
 * @layer
 * @provides Clanka.Store
 */
export const MemoryStore: Layer.Layer<Store> = Layer.succeed(Store, {
  instance: Effect.sync(() => {
    const values = new Map<string, string>();
    const store: InstanceStore = {
      id: `memory-${++memoryInstances}`,
      get: (key) => Effect.sync(() => values.get(key)),
      put: (key, value) => Effect.sync(() => void values.set(key, value)),
      delete: (key) => Effect.sync(() => void values.delete(key)),
    };
    return store;
  }),
});
