import type { Storage as PiStorage } from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PiError } from "./Errors.ts";
import { fromPi } from "./internal/promise.ts";

/** One instance's storage, opened on first use. */
export interface InstanceStorage {
  /**
   * Identifies this instance among every instance of the harness: a Durable
   * Object's id, a file's path. Conversation ids are only unique within it.
   */
  readonly id: string;
  /** Open Pi's storage. Runs once per instance, on the first call. */
  readonly open: (prefix: string) => Effect.Effect<PiStorage, PiError>;
  /**
   * Whether the process can be evicted while work is pending (a Durable
   * Object). The harness then keeps a durable alarm armed and resumes from
   * it; a long-lived process resumes once, when it opens.
   */
  readonly evictable: boolean;
}

/**
 * Where a harness keeps its conversations. Pi Durable allows one owner per
 * storage, so each host provides the storage only it owns: a Durable
 * Object's SQLite, a file on a volume.
 */
export class Storage extends Context.Service<
  Storage,
  {
    /**
     * The storage of the instance yielding the harness. Runs where the
     * harness is yielded (a Durable Object's outer Effect, once per
     * instance); performs no I/O.
     */
    readonly instance: Effect.Effect<InstanceStorage>;
  }
>()("Pi.Storage") {}

/** Memory instances opened by this process: each is its own instance. */
let memoryInstances = 0;

/**
 * Keep conversations in memory: gone when the process ends. For tests.
 *
 * @layer
 * @provides Pi.Storage
 */
export const MemoryStorage: Layer.Layer<Storage> = Layer.succeed(Storage, {
  instance: Effect.sync(() => ({
    id: `memory:${++memoryInstances}`,
    evictable: false,
    open: () =>
      fromPi(async () => {
        const { MemoryStorage } = await import("@earendil-works/pi-durable/storage/memory");
        return new MemoryStorage();
      }),
  })),
});

/**
 * Keep conversations in a SQLite file, for a long-lived process that owns
 * it alone: a Fly Machine with a volume, an ECS task on EFS, a container.
 * Needs Node or Bun.
 *
 * @layer
 * @provides Pi.Storage
 */
export const SqliteFile = (path: string): Layer.Layer<Storage> =>
  Layer.succeed(Storage, {
    instance: Effect.sync((): InstanceStorage => ({
      id: path,
      evictable: false,
      open: (prefix) =>
        fromPi(async () => {
          const { openNodeSqliteStorage } =
            await import("@earendil-works/pi-durable/storage/sqlite/node");
          return openNodeSqliteStorage(path, { prefix });
        }),
    })),
  });
