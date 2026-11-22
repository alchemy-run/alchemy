import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `GetQueueAccessPolicy` request without the `url` and `queueName` the bound queue supplies. */
export interface GetQueueAccessPolicyRequest extends Omit<
  queues.GetQueueAccessPolicyRequest,
  "url" | "queueName"
> {}

/**
 * Read the stored access policies of an Azure Storage queue (Get Queue ACL) on any host.
 *
 * Binding assigns a custom role with only the `queues/getAcl/action` action
 * on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link GetQueueAccessPolicyHttp}.
 *
 * ### Reading Stored Access Policies
 * **Example:** List the policy IDs
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     // init: assigns the role on the queue
 *     const getAccessPolicy = yield* Azure.Storage.GetQueueAccessPolicy(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const policies = yield* getAccessPolicy();
 *         return yield* HttpServerResponse.json(policies.map((p) => p.Id));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetQueueAccessPolicyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetQueueAccessPolicy extends Binding.Service<
  GetQueueAccessPolicy,
  "Azure.Storage.GetQueueAccessPolicy",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: GetQueueAccessPolicyRequest,
    ) => Effect.Effect<
      queues.GetQueueAccessPolicyResponse,
      queues.GetQueueAccessPolicyError,
      RuntimeContext
    >
  >
> {}

export const GetQueueAccessPolicy = Binding.Service<GetQueueAccessPolicy>(
  "Azure.Storage.GetQueueAccessPolicy",
);
