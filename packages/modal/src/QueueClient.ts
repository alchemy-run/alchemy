import * as queue from "@distilled.cloud/modal/queue";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { decodeJson, encodeJson, type ModalValueNotJson } from "./BindingHttp.ts";
import { type OpError, operations, seconds } from "./internal.ts";

/** The queue operations the clients call, resolved by `ModalBindings.withCredentials`. */
export const QueueOps = operations({
  clearQueue: queue.clearQueue,
  getQueue: queue.getQueue,
  putQueue: queue.putQueue,
  queueLen: queue.queueLen,
  queueNextItems: queue.queueNextItems,
});

export type QueueOps = Effect.Success<typeof QueueOps>;

/** A queue call's error: the operation's typed errors, and items that aren't JSON. */
export type QueueError<K extends keyof QueueOps> = OpError<QueueOps, K> | ModalValueNotJson;

/** Which partition of a queue a call uses; omitted means the default partition. */
export interface QueuePartitionOptions {
  readonly partition?: string;
}

/**
 * Take items from one queue. Items are JSON (the bytes of `JSON.stringify`),
 * so Python consumers read them with `json.loads`.
 */
export interface ReadQueueClient {
  readonly queueId: Effect.Effect<string>;
  /**
   * Remove and return up to `count` items, waiting up to `timeout` for the
   * first one (an empty array when none arrived).
   */
  take<A = unknown>(
    options?: QueuePartitionOptions & {
      readonly count?: number;
      readonly timeout?: number | string;
    },
  ): Effect.Effect<ReadonlyArray<A>, QueueError<"getQueue">, RuntimeContext>;
  /** Items currently in the queue, without removing them. */
  peek<A = unknown>(
    options?: QueuePartitionOptions,
  ): Effect.Effect<ReadonlyArray<A>, QueueError<"queueNextItems">, RuntimeContext>;
  /** Number of items in a partition (or, with `total`, in every partition). */
  len(
    options?: QueuePartitionOptions & { readonly total?: boolean },
  ): Effect.Effect<number, OpError<QueueOps, "queueLen">, RuntimeContext>;
}

/** Put items into one queue. */
export interface WriteQueueClient {
  readonly queueId: Effect.Effect<string>;
  /** Append one item. */
  put(
    value: unknown,
    options?: QueuePartitionOptions & { readonly partitionTtl?: number | string },
  ): Effect.Effect<void, OpError<QueueOps, "putQueue">, RuntimeContext>;
  /** Append many items in order. */
  putMany(
    values: Iterable<unknown>,
    options?: QueuePartitionOptions & { readonly partitionTtl?: number | string },
  ): Effect.Effect<void, OpError<QueueOps, "putQueue">, RuntimeContext>;
  /** Remove every item of a partition (or of all partitions). */
  clear(
    options?: QueuePartitionOptions & { readonly all?: boolean },
  ): Effect.Effect<void, OpError<QueueOps, "clearQueue">, RuntimeContext>;
}

/** Put and take items. */
export interface ReadWriteQueueClient extends ReadQueueClient, WriteQueueClient {}

export const makeReadQueueClient = (
  queueId: Effect.Effect<string>,
  ops: QueueOps,
): ReadQueueClient => ({
  queueId,
  take: <A>(options: Parameters<ReadQueueClient["take"]>[0] = {}) =>
    Effect.gen(function* () {
      const id = yield* queueId;
      const { values } = yield* ops.getQueue({
        queueId: id,
        partitionKey: options.partition,
        nValues: options.count ?? 1,
        timeout: seconds(options.timeout) ?? 0,
      });
      return yield* Effect.forEach(values ?? [], (value) => decodeJson<A>(value));
    }),
  peek: <A>(options: QueuePartitionOptions = {}) =>
    Effect.gen(function* () {
      const id = yield* queueId;
      const { items } = yield* ops.queueNextItems({
        queueId: id,
        partitionKey: options.partition,
        itemPollTimeout: 0,
      });
      return yield* Effect.forEach(items ?? [], (item) => decodeJson<A>(item.value ?? ""));
    }),
  len: (options = {}) =>
    Effect.gen(function* () {
      const id = yield* queueId;
      const response = yield* ops.queueLen({
        queueId: id,
        partitionKey: options.partition,
        total: options.total,
      });
      return response.len ?? 0;
    }),
});

export const makeWriteQueueClient = (
  queueId: Effect.Effect<string>,
  ops: QueueOps,
): WriteQueueClient => {
  const putMany: WriteQueueClient["putMany"] = (values, options = {}) =>
    Effect.gen(function* () {
      const id = yield* queueId;
      const encoded = yield* Effect.forEach([...values], (value) => encodeJson(value));
      yield* ops.putQueue({
        queueId: id,
        values: encoded,
        partitionKey: options.partition,
        partitionTtlSeconds: seconds(options.partitionTtl),
      });
    });
  return {
    queueId,
    put: (value, options) => putMany([value], options),
    putMany,
    clear: (options = {}) =>
      Effect.gen(function* () {
        const id = yield* queueId;
        yield* ops.clearQueue({
          queueId: id,
          partitionKey: options.partition,
          allPartitions: options.all,
        });
      }),
  };
};

export const makeReadWriteQueueClient = (
  queueId: Effect.Effect<string>,
  ops: QueueOps,
): ReadWriteQueueClient => ({
  ...makeReadQueueClient(queueId, ops),
  ...makeWriteQueueClient(queueId, ops),
});
