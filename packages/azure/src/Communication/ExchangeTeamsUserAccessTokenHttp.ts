import * as identity from "@distilled.cloud/azure/communication-identity";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ExchangeTeamsUserAccessToken } from "./ExchangeTeamsUserAccessToken.ts";

/**
 * Implementation of {@link ExchangeTeamsUserAccessToken} over the distilled `communication-identity`
 * data plane. Assigns the custom `AzureCommunicationIdentityRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.ExchangeTeamsUserAccessToken
 */
export const ExchangeTeamsUserAccessTokenHttp = Layer.effect(
  ExchangeTeamsUserAccessToken,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ExchangeTeamsUserAccessToken",
    operation: identity.TeamsUserOperationsExchangeTeamsUserAccessToken,
    grant: CommunicationRole.Identity,
  }),
);
