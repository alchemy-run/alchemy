import { memoryRunStore, type RunStore } from "@alchemy.run/ai/Runs";
import { InMemory } from "@yielded/agent";
import type { ThreadHistory } from "@yielded/agent/thread-history";
import type { Callbacks } from "alchemy/Callback";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface InstanceHistory {
  /**
   * Identifies this instance among every instance of the harness: a Durable
   * Object's id. Thread names are only unique within it.
   */
  readonly id: string;
  /**
   * Yielded's history for this instance. Built once per instance, on the
   * first run, and kept for as long as the instance lives.
   */
  readonly layer: Layer.Layer<ThreadHistory, unknown, RuntimeContext>;
  /** Where submitted runs are recorded until they end. */
  readonly runs: RunStore;
  /**
   * The durable callbacks of an instance that can be evicted: what the
   * harness registers its wake-up with, so a submitted run an instance
   * did not live to finish is run again.
   */
  readonly callbacks?: Layer.Layer<Callbacks>;
}

/**
 * Where a harness keeps its Threads: what each Run reads the conversation
 * from and appends to. A platform's Layer decides what survives a restart.
 */
export class History extends Context.Service<
  History,
  {
    /**
     * The history of the instance yielding the harness. Runs where the
     * harness is yielded (a Durable Object's outer Effect, once per
     * instance); performs no I/O.
     */
    readonly instance: Effect.Effect<InstanceHistory>;
  }
>()("YieldedAgent.History") {}

let memoryInstances = 0;

/**
 * Threads kept in memory: they last as long as the process, and a run cut
 * off by a restart is gone. For tests and long-lived local processes.
 *
 * @layer
 * @provides YieldedAgent.History
 */
export const MemoryHistory: Layer.Layer<History> = Layer.succeed(History, {
  instance: Effect.sync(() => ({
    id: `memory-${++memoryInstances}`,
    layer: InMemory.layer,
    runs: memoryRunStore(),
  })),
});
