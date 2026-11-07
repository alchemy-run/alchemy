import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";
import type { WriteQueueClient } from "./QueueClient.ts";

export type { WriteQueueClient } from "./QueueClient.ts";

/**
 * Put items into a Modal Queue from any runtime. Items are JSON, so a Python consumer reads them with `json.loads`.
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
 *     const queue = yield* Modal.WriteQueue(Jobs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* queue.put({ repo: "alchemy-run/alchemy", command: "pnpm test" });
 *         return HttpServerResponse.text("queued");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.WriteQueueHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Queue
 */
export interface WriteQueue extends Binding.Service<
  WriteQueue,
  "Modal.WriteQueue",
  (queue: Queue) => Effect.Effect<WriteQueueClient>
> {}

export const WriteQueue = Binding.Service<WriteQueue>("Modal.WriteQueue");
