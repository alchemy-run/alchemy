import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpsertRouterQueueRequest extends Omit<
  jobRouter.UpsertJobRouterAdministrationOperationQueueRequest,
  "endpoint"
> {}

/**
 * Create or update a Job Router queue.
 *
 * Binding assigns a custom role (`AzureCommunicationDataRole`, one per stack)
 * with exactly the actions `Microsoft.Communication/CommunicationServices/Read`
 * and `/Write`, on the communication service only. The Communication
 * Services data plane has no data actions and denies Entra callers without
 * both, reads included.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpsertRouterQueueHttp}.
 *
 * ### Calling UpsertRouterQueue
 * **Example:** UpsertRouterQueue from a Function
 * ```typescript
 * // init
 * const upsertRouterQueue = yield* Azure.Communication.UpsertRouterQueue(acs);
 *
 * // runtime
 * yield* upsertRouterQueue({
 *   queueId: "support",
 *   distributionPolicyId: "longest-idle",
 *   labels: { language: "en" },
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpsertRouterQueue extends Binding.Service<
  UpsertRouterQueue,
  "Azure.Communication.UpsertRouterQueue",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpsertRouterQueueRequest,
    ) => Effect.Effect<
      jobRouter.UpsertJobRouterAdministrationOperationQueueResponse,
      jobRouter.UpsertJobRouterAdministrationOperationQueueError,
      RuntimeContext
    >
  >
> {}

export const UpsertRouterQueue = Binding.Service<UpsertRouterQueue>(
  "Azure.Communication.UpsertRouterQueue",
);
