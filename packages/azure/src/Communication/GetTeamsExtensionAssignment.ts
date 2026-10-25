import type * as identity from "@distilled.cloud/azure/communication-identity";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetTeamsExtensionAssignmentRequest extends Omit<
  identity.GetTeamsExtensionOperationAssignmentRequest,
  "endpoint"
> {}

/**
 * Read a Teams Phone extensibility access assignment of a Teams user or
 * resource account.
 *
 * Binding assigns a custom role (`AzureCommunicationIdentityRole`, one per
 * stack) with exactly the action
 * `Microsoft.Communication/CommunicationServices/Write`, on the communication
 * service only. The Communication Services data plane has no data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetTeamsExtensionAssignmentHttp}.
 *
 * ### Calling GetTeamsExtensionAssignment
 * **Example:** GetTeamsExtensionAssignment from a Function
 * ```typescript
 * // init
 * const getTeamsExtensionAssignment = yield* Azure.Communication.GetTeamsExtensionAssignment(acs);
 *
 * // runtime
 * const assignment = yield* getTeamsExtensionAssignment({ tenantId, objectId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetTeamsExtensionAssignment extends Binding.Service<
  GetTeamsExtensionAssignment,
  "Azure.Communication.GetTeamsExtensionAssignment",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetTeamsExtensionAssignmentRequest,
    ) => Effect.Effect<
      identity.TeamsExtensionAssignmentResponse,
      identity.GetTeamsExtensionOperationAssignmentError,
      RuntimeContext
    >
  >
> {}

export const GetTeamsExtensionAssignment = Binding.Service<GetTeamsExtensionAssignment>(
  "Azure.Communication.GetTeamsExtensionAssignment",
);
