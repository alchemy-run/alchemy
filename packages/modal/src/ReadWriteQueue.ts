import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";
import type { ReadWriteQueueClient } from "./QueueClient.ts";

export type { ReadWriteQueueClient } from "./QueueClient.ts";

/**
 * Put and take items on a Modal Queue from any runtime. Items are JSON.
 *
 * ### Bind a queue
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Jobs } from "./Storage.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Modal.ReadWriteQueue(Jobs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* queue.put({ n: 1 });
 *         const items = yield* queue.take({ count: 10 });
 *         return yield* HttpServerResponse.json(items);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.ReadWriteQueueHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Queue
 */
export interface ReadWriteQueue extends Binding.Service<
  ReadWriteQueue,
  "Modal.ReadWriteQueue",
  (queue: Queue) => Effect.Effect<ReadWriteQueueClient>
> {}

export const ReadWriteQueue = Binding.Service<ReadWriteQueue>("Modal.ReadWriteQueue");
