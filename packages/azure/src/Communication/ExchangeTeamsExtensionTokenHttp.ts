import * as identity from "@distilled.cloud/azure/communication-identity";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ExchangeTeamsExtensionToken } from "./ExchangeTeamsExtensionToken.ts";

/**
 * Implementation of {@link ExchangeTeamsExtensionToken} over the distilled `communication-identity`
 * data plane. Assigns the custom `AzureCommunicationIdentityRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.ExchangeTeamsExtensionToken
 */
export const ExchangeTeamsExtensionTokenHttp = Layer.effect(
  ExchangeTeamsExtensionToken,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ExchangeTeamsExtensionToken",
    operation: identity.TeamsExtensionOperationsExchangeToken,
    grant: CommunicationRole.Identity,
  }),
);
