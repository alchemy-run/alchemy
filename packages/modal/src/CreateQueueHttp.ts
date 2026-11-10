import * as queue from "@distilled.cloud/modal/queue";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenModalBinding } from "./BindingHttp.ts";
import { CreateQueue, type QueueHandle, type QueuesClientOf } from "./CreateQueue.ts";
import type { Environment } from "./Environment.ts";
import { environmentOf, listAll, operations } from "./internal.ts";
import { ensureQueue, lookupQueue, type QueueAttributes } from "./Queue.ts";
import { QueueOps, makeReadWriteQueueClient } from "./QueueClient.ts";
import { ownedName, type RuntimeOwner, RuntimeOwnerOf, unownedName } from "./RuntimeOwner.ts";

/** The operations the client calls, resolved by `ModalBindings.withCredentials`. */
export const QueuesOps = operations({
  getOrCreate: queue.queueGetOrCreate,
  delete: queue.deleteQueue,
  list: queue.listQueue,
  client: QueueOps,
});

export type QueuesOps = Effect.Success<typeof QueuesOps>;

const handleOf = (attributes: QueueAttributes, ops: QueuesOps, name: string): QueueHandle => ({
  ...makeReadWriteQueueClient(Effect.succeed(attributes.queueId), ops.client),
  queueId: Effect.succeed(attributes.queueId),
  name,
  attributes,
});

/** A queues client over an environment name resolved per call. */
export const makeQueuesClient = (
  environment: Effect.Effect<string | undefined>,
  ops: QueuesOps,
  owner: Effect.Effect<RuntimeOwner | undefined> = Effect.undefined,
): QueuesClientOf<never> => ({
  getOrCreate: (name) =>
    Effect.flatMap(Effect.all([environment, owner]), ([env, stamp]) =>
      ensureQueue(ops.getOrCreate, ownedName(stamp, name), env),
    ).pipe(Effect.map((attributes) => handleOf(attributes, ops, name))),
  get: (name) =>
    Effect.flatMap(Effect.all([environment, owner]), ([env, stamp]) =>
      lookupQueue(ops.getOrCreate, ownedName(stamp, name), env),
    ).pipe(Effect.map((attributes) => (attributes ? handleOf(attributes, ops, name) : undefined))),
  delete: (name) =>
    Effect.gen(function* () {
      const env = yield* environment;
      const found = yield* lookupQueue(ops.getOrCreate, ownedName(yield* owner, name), env);
      if (!found) return;
      yield* ops
        .delete({ queueId: found.queueId })
        .pipe(Effect.catchTag("QueueNotFound", () => Effect.void));
    }),
  list: () =>
    Effect.gen(function* () {
      const env = yield* environment;
      const stamp = yield* owner;
      const items = yield* listAll(
        (pagination) =>
          ops
            .list({ environmentName: environmentOf(env), pagination })
            .pipe(Effect.map((response) => response.queues ?? [])),
        (item) => item.createdAt,
      );
      return items.flatMap((item) => {
        const own = item.name ? unownedName(stamp, item.name) : undefined;
        return own ? [own] : [];
      });
    }),
});

/**
 * {@link CreateQueue} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the environment.
 *
 * @layer
 * @product Queue
 * @provides Modal.CreateQueue
 */
export const CreateQueueHttp = Layer.effect(
  CreateQueue,
  makeOpenModalBinding({
    tag: "Modal.CreateQueue",
    operations: QueuesOps,
    role: "contributor",
    environmentOf: (environment?: Environment) => environment?.name,
    make: Effect.fn(function* (ops, environment?: Environment) {
      const name = environment ? yield* environment.name : Effect.undefined;
      const owner = yield* RuntimeOwnerOf();
      return makeQueuesClient(name, ops, owner);
    }),
  }),
);
