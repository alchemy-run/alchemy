import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpsertRouterWorkerRequest extends Omit<
  jobRouter.UpsertJobRouterOperationWorkerRequest,
  "endpoint"
> {}

/**
 * Create or update a Job Router worker: its queues, channels, capacity, and
 * availability.
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
 * Provide {@link UpsertRouterWorkerHttp}.
 *
 * ### Calling UpsertRouterWorker
 * **Example:** UpsertRouterWorker from a Function
 * ```typescript
 * // init
 * const upsertRouterWorker = yield* Azure.Communication.UpsertRouterWorker(acs);
 *
 * // runtime
 * yield* upsertRouterWorker({
 *   workerId: "agent-7",
 *   queues: ["support"],
 *   capacity: 1,
 *   channels: [{ channelId: "voice", capacityCostPerJob: 1 }],
 *   availableForOffers: true,
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpsertRouterWorker extends Binding.Service<
  UpsertRouterWorker,
  "Azure.Communication.UpsertRouterWorker",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpsertRouterWorkerRequest,
    ) => Effect.Effect<
      jobRouter.UpsertJobRouterOperationWorkerResponse,
      jobRouter.UpsertJobRouterOperationWorkerError,
      RuntimeContext
    >
  >
> {}

export const UpsertRouterWorker = Binding.Service<UpsertRouterWorker>(
  "Azure.Communication.UpsertRouterWorker",
);
