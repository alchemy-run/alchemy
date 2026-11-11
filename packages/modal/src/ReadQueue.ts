import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";
import type { ReadQueueClient } from "./QueueClient.ts";

export type { ReadQueueClient } from "./QueueClient.ts";

/**
 * Take items from a Modal Queue from any runtime: take (removes), peek and len. Items are JSON.
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
 *     const queue = yield* Modal.ReadQueue(Jobs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const [job] = yield* queue.take({ timeout: "5 seconds" });
 *         return yield* HttpServerResponse.json(job ?? null);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.ReadQueueHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Queue
 */
export interface ReadQueue extends Binding.Service<
  ReadQueue,
  "Modal.ReadQueue",
  (queue: Queue) => Effect.Effect<ReadQueueClient>
> {}

export const ReadQueue = Binding.Service<ReadQueue>("Modal.ReadQueue");
