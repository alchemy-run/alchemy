import type * as identity from "@distilled.cloud/azure/communication-identity";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface RevokeAccessTokensRequest extends Omit<
  identity.RevokeIdentityOperationAccessTokensRequest,
  "endpoint"
> {}

/**
 * Revoke every user access token of a Communication Services identity.
 *
 * Binding assigns a custom role (`AzureCommunicationIdentityRole`, one per
 * stack) with exactly the action
 * `Microsoft.Communication/CommunicationServices/Write`, on the communication
 * service only. The Communication Services data plane has no data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RevokeAccessTokensHttp}.
 *
 * ### Calling RevokeAccessTokens
 * **Example:** RevokeAccessTokens from a Function
 * ```typescript
 * // init
 * const revokeAccessTokens = yield* Azure.Communication.RevokeAccessTokens(acs);
 *
 * // runtime
 * yield* revokeAccessTokens({ id: userId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface RevokeAccessTokens extends Binding.Service<
  RevokeAccessTokens,
  "Azure.Communication.RevokeAccessTokens",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: RevokeAccessTokensRequest,
    ) => Effect.Effect<
      identity.RevokeIdentityOperationAccessTokensResponse,
      identity.RevokeIdentityOperationAccessTokensError,
      RuntimeContext
    >
  >
> {}

export const RevokeAccessTokens = Binding.Service<RevokeAccessTokens>(
  "Azure.Communication.RevokeAccessTokens",
);
