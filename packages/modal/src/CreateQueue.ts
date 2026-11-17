import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { QueuesOps } from "./CreateQueueHttp.ts";
import type { Environment } from "./Environment.ts";
import type { ErrorOf, OpError } from "./internal.ts";
import type { ensureQueue, lookupQueue } from "./Queue.ts";
import type { QueueAttributes } from "./Queue.ts";
import type { ReadWriteQueueClient } from "./QueueClient.ts";

/** A queue created or found at runtime: its attributes plus a read-write client. */
export interface QueueHandle extends ReadWriteQueueClient {
  readonly queueId: Effect.Effect<string>;
  readonly name: string;
  /** The attributes, to pass where a `Modal.Queue` is accepted (e.g. sandbox mounts). */
  readonly attributes: QueueAttributes;
}

/** Get, create, list and delete queues by name in one environment. */
export interface QueuesClientOf<R> {
  /** The queue named `name`, created when missing (Modal's own get-or-create). */
  getOrCreate(name: string): Effect.Effect<QueueHandle, ErrorOf<typeof ensureQueue>, R>;
  /** The queue named `name`, or `undefined`. */
  get(name: string): Effect.Effect<QueueHandle | undefined, ErrorOf<typeof lookupQueue>, R>;
  /** Delete the queue named `name` (no-op when missing). */
  delete(
    name: string,
  ): Effect.Effect<
    void,
    | ErrorOf<typeof lookupQueue>
    | Exclude<OpError<QueuesOps, "delete">, { readonly _tag: "QueueNotFound" }>,
    R
  >;
  /** Names of every queue in the environment. */
  list(): Effect.Effect<ReadonlyArray<string>, OpError<QueuesOps, "list">, R>;
}

/** A QueuesClient whose calls run inside a deployed runtime. */
export type QueuesClient = QueuesClientOf<RuntimeContext>;

/**
 * Create queues by name at runtime: one per user, session or task.
 * Modal's native shape is get-or-create by name, so `getOrCreate` is
 * idempotent and safe to call on every request.
 *
 * Bind it to a `Modal.Environment` to keep these runtime objects in their
 * own namespace (or to nothing, for the workspace's default environment).
 * They aren't in Alchemy state: deleting the environment removes them.
 *
 * Objects created at run time are tagged with the stack, stage and binding
 * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) and are not deleted when
 * the stack is destroyed. A Modal queue has only a name, so the tags become
 * its name prefix, `Modal.runtimePrefix({ stack, stage, id })`: list them
 * with `modal queue list` and delete the ones whose name starts with it.
 *
 * ### One queue per user
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Agents, Coder } from "./Coder.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queues = yield* Modal.CreateQueue(Agents);
 *     const sandboxes = yield* Modal.CreateSandbox(Coder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const user = request.headers["x-user"] ?? "anonymous";
 *         const inbox = yield* queues.getOrCreate(`inbox-${user}`);
 *         yield* inbox.put({ task: "review" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(Modal.CreateQueueHttp, Modal.CreateSandboxHttp))),
 * ) {}
 * ```
 *
 * @binding
 * @product Queue
 */
export interface CreateQueue extends Binding.Service<
  CreateQueue,
  "Modal.CreateQueue",
  (environment?: Environment) => Effect.Effect<QueuesClient>
> {}

export const CreateQueue = Binding.Service<CreateQueue>("Modal.CreateQueue");
