import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface CancelAllCallMediaOperationsRequest extends Omit<
  callAutomation.CancelCallMediaAllMediaOperationsRequest,
  "endpoint"
> {}

/**
 * Cancel every running media operation (play, recognize) in the call.
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
 * Provide {@link CancelAllCallMediaOperationsHttp}.
 *
 * ### Calling CancelAllCallMediaOperations
 * **Example:** CancelAllCallMediaOperations from a Function
 * ```typescript
 * // init
 * const cancelAllCallMediaOperations = yield* Azure.Communication.CancelAllCallMediaOperations(acs);
 *
 * // runtime
 * yield* cancelAllCallMediaOperations({ callConnectionId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface CancelAllCallMediaOperations extends Binding.Service<
  CancelAllCallMediaOperations,
  "Azure.Communication.CancelAllCallMediaOperations",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: CancelAllCallMediaOperationsRequest,
    ) => Effect.Effect<
      callAutomation.CancelCallMediaAllMediaOperationsResponse,
      callAutomation.CancelCallMediaAllMediaOperationsError,
      RuntimeContext
    >
  >
> {}

export const CancelAllCallMediaOperations = Binding.Service<CancelAllCallMediaOperations>(
  "Azure.Communication.CancelAllCallMediaOperations",
);
