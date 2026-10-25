import type * as identity from "@distilled.cloud/azure/communication-identity";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ExchangeTeamsExtensionTokenRequest extends Omit<
  identity.TeamsExtensionOperationsExchangeTokenRequest,
  "endpoint"
> {}

/**
 * Exchange a Teams Phone extensibility token for a Communication Services
 * user access token.
 *
 * Binding assigns a custom role (`AzureCommunicationIdentityRole`, one per
 * stack) with exactly the action
 * `Microsoft.Communication/CommunicationServices/Write`, on the communication
 * service only. The Communication Services data plane has no data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ExchangeTeamsExtensionTokenHttp}.
 *
 * ### Calling ExchangeTeamsExtensionToken
 * **Example:** ExchangeTeamsExtensionToken from a Function
 * ```typescript
 * // init
 * const exchangeTeamsExtensionToken = yield* Azure.Communication.ExchangeTeamsExtensionToken(acs);
 *
 * // runtime
 * const result = yield* exchangeTeamsExtensionToken({ body: { token: teamsToken, appId, userId } });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ExchangeTeamsExtensionToken extends Binding.Service<
  ExchangeTeamsExtensionToken,
  "Azure.Communication.ExchangeTeamsExtensionToken",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ExchangeTeamsExtensionTokenRequest,
    ) => Effect.Effect<
      identity.CommunicationIdentityAccessTokenResult,
      identity.TeamsExtensionOperationsExchangeTokenError,
      RuntimeContext
    >
  >
> {}

export const ExchangeTeamsExtensionToken = Binding.Service<ExchangeTeamsExtensionToken>(
  "Azure.Communication.ExchangeTeamsExtensionToken",
);
