import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `SetQueueAccessPolicy` request without the `url` and `queueName` the bound queue supplies. */
export interface SetQueueAccessPolicyRequest extends Omit<
  queues.SetQueueAccessPolicyRequest,
  "url" | "queueName"
> {}

/**
 * Replace the stored access policies of an Azure Storage queue (Set Queue ACL) on any host. An empty `body` removes every policy.
 *
 * Binding assigns a custom role with only the `queues/setAcl/action` action
 * on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link SetQueueAccessPolicyHttp}.
 *
 * ### Setting Stored Access Policies
 * **Example:** Grant a read-and-process SAS policy for a day
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     // init: assigns the role on the queue
 *     const setAccessPolicy = yield* Azure.Storage.SetQueueAccessPolicy(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const now = new Date();
 *         yield* setAccessPolicy({
 *           body: [
 *             {
 *               Id: "consumer",
 *               AccessPolicy: {
 *                 Start: now.toISOString(),
 *                 Expiry: new Date(now.getTime() + 86_400_000).toISOString(),
 *                 Permission: "rp",
 *               },
 *             },
 *           ],
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetQueueAccessPolicyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetQueueAccessPolicy extends Binding.Service<
  SetQueueAccessPolicy,
  "Azure.Storage.SetQueueAccessPolicy",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: SetQueueAccessPolicyRequest,
    ) => Effect.Effect<
      queues.SetQueueAccessPolicyResponse,
      queues.SetQueueAccessPolicyError,
      RuntimeContext
    >
  >
> {}

export const SetQueueAccessPolicy = Binding.Service<SetQueueAccessPolicy>(
  "Azure.Storage.SetQueueAccessPolicy",
);
