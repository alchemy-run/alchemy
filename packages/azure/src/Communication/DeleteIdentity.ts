import type * as identity from "@distilled.cloud/azure/communication-identity";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface DeleteIdentityRequest extends Omit<
  identity.DeleteIdentityOperationRequest,
  "endpoint"
> {}

/**
 * Delete a Communication Services user identity, revoke its tokens, and
 * delete its data.
 *
 * Binding assigns a custom role (`AzureCommunicationIdentityRole`, one per
 * stack) with exactly the action
 * `Microsoft.Communication/CommunicationServices/Write`, on the communication
 * service only. The Communication Services data plane has no data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteIdentityHttp}.
 *
 * ### Calling DeleteIdentity
 * **Example:** DeleteIdentity from a Function
 * ```typescript
 * // init
 * const deleteIdentity = yield* Azure.Communication.DeleteIdentity(acs);
 *
 * // runtime
 * yield* deleteIdentity({ id: userId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface DeleteIdentity extends Binding.Service<
  DeleteIdentity,
  "Azure.Communication.DeleteIdentity",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: DeleteIdentityRequest,
    ) => Effect.Effect<
      identity.DeleteIdentityOperationResponse,
      identity.DeleteIdentityOperationError,
      RuntimeContext
    >
  >
> {}

export const DeleteIdentity = Binding.Service<DeleteIdentity>("Azure.Communication.DeleteIdentity");
