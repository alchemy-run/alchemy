import * as identity from "@distilled.cloud/azure/communication-identity";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { RevokeAccessTokens } from "./RevokeAccessTokens.ts";

/**
 * Implementation of {@link RevokeAccessTokens} over the distilled `communication-identity`
 * data plane. Assigns the custom `AzureCommunicationIdentityRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.RevokeAccessTokens
 */
export const RevokeAccessTokensHttp = Layer.effect(
  RevokeAccessTokens,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.RevokeAccessTokens",
    operation: identity.RevokeIdentityOperationAccessTokens,
    grant: CommunicationRole.Identity,
  }),
);
