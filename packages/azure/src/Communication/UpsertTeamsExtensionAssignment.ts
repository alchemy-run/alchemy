import type * as identity from "@distilled.cloud/azure/communication-identity";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpsertTeamsExtensionAssignmentRequest extends Omit<
  identity.UpsertTeamsExtensionOperationAssignmentRequest,
  "endpoint"
> {}

/**
 * Create or replace a Teams Phone extensibility access assignment.
 *
 * Binding assigns a custom role (`AzureCommunicationIdentityRole`, one per
 * stack) with exactly the action
 * `Microsoft.Communication/CommunicationServices/Write`, on the communication
 * service only. The Communication Services data plane has no data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpsertTeamsExtensionAssignmentHttp}.
 *
 * ### Calling UpsertTeamsExtensionAssignment
 * **Example:** UpsertTeamsExtensionAssignment from a Function
 * ```typescript
 * // init
 * const upsertTeamsExtensionAssignment = yield* Azure.Communication.UpsertTeamsExtensionAssignment(acs);
 *
 * // runtime
 * const assignment = yield* upsertTeamsExtensionAssignment({
 *   tenantId,
 *   objectId,
 *   principalType: "user",
 *   clientIds: [appId],
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpsertTeamsExtensionAssignment extends Binding.Service<
  UpsertTeamsExtensionAssignment,
  "Azure.Communication.UpsertTeamsExtensionAssignment",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpsertTeamsExtensionAssignmentRequest,
    ) => Effect.Effect<
      identity.TeamsExtensionAssignmentResponse,
      identity.UpsertTeamsExtensionOperationAssignmentError,
      RuntimeContext
    >
  >
> {}

export const UpsertTeamsExtensionAssignment = Binding.Service<UpsertTeamsExtensionAssignment>(
  "Azure.Communication.UpsertTeamsExtensionAssignment",
);
