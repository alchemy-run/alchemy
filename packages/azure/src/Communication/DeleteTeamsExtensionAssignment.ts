import type * as identity from "@distilled.cloud/azure/communication-identity";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface DeleteTeamsExtensionAssignmentRequest extends Omit<
  identity.DeleteTeamsExtensionOperationAssignmentRequest,
  "endpoint"
> {}

/**
 * Remove a Teams Phone extensibility access assignment.
 *
 * Binding assigns a custom role (`AzureCommunicationIdentityRole`, one per
 * stack) with exactly the action
 * `Microsoft.Communication/CommunicationServices/Write`, on the communication
 * service only. The Communication Services data plane has no data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteTeamsExtensionAssignmentHttp}.
 *
 * ### Calling DeleteTeamsExtensionAssignment
 * **Example:** DeleteTeamsExtensionAssignment from a Function
 * ```typescript
 * // init
 * const deleteTeamsExtensionAssignment = yield* Azure.Communication.DeleteTeamsExtensionAssignment(acs);
 *
 * // runtime
 * yield* deleteTeamsExtensionAssignment({ tenantId, objectId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface DeleteTeamsExtensionAssignment extends Binding.Service<
  DeleteTeamsExtensionAssignment,
  "Azure.Communication.DeleteTeamsExtensionAssignment",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: DeleteTeamsExtensionAssignmentRequest,
    ) => Effect.Effect<
      identity.DeleteTeamsExtensionOperationAssignmentResponse,
      identity.DeleteTeamsExtensionOperationAssignmentError,
      RuntimeContext
    >
  >
> {}

export const DeleteTeamsExtensionAssignment = Binding.Service<DeleteTeamsExtensionAssignment>(
  "Azure.Communication.DeleteTeamsExtensionAssignment",
);
