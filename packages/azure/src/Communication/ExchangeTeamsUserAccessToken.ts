import type * as identity from "@distilled.cloud/azure/communication-identity";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ExchangeTeamsUserAccessTokenRequest extends Omit<
  identity.TeamsUserOperationsExchangeTeamsUserAccessTokenRequest,
  "endpoint"
> {}

/**
 * Exchange a Microsoft Entra access token of a Teams user for a
 * Communication Services access token (Teams interoperability).
 *
 * Binding assigns a custom role (`AzureCommunicationIdentityRole`, one per
 * stack) with exactly the action
 * `Microsoft.Communication/CommunicationServices/Write`, on the communication
 * service only. The Communication Services data plane has no data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ExchangeTeamsUserAccessTokenHttp}.
 *
 * ### Calling ExchangeTeamsUserAccessToken
 * **Example:** ExchangeTeamsUserAccessToken from a Function
 * ```typescript
 * // init
 * const exchangeTeamsUserAccessToken = yield* Azure.Communication.ExchangeTeamsUserAccessToken(acs);
 *
 * // runtime
 * const token = yield* exchangeTeamsUserAccessToken({ token: entraToken, appId, userId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ExchangeTeamsUserAccessToken extends Binding.Service<
  ExchangeTeamsUserAccessToken,
  "Azure.Communication.ExchangeTeamsUserAccessToken",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ExchangeTeamsUserAccessTokenRequest,
    ) => Effect.Effect<
      identity.CommunicationIdentityAccessToken,
      identity.TeamsUserOperationsExchangeTeamsUserAccessTokenError,
      RuntimeContext
    >
  >
> {}

export const ExchangeTeamsUserAccessToken = Binding.Service<ExchangeTeamsUserAccessToken>(
  "Azure.Communication.ExchangeTeamsUserAccessToken",
);
