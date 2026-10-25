import * as identity from "@distilled.cloud/azure/communication-identity";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { IssueAccessToken } from "./IssueAccessToken.ts";

/**
 * Implementation of {@link IssueAccessToken} over the distilled `communication-identity`
 * data plane. Assigns the custom `AzureCommunicationIdentityRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.IssueAccessToken
 */
export const IssueAccessTokenHttp = Layer.effect(
  IssueAccessToken,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.IssueAccessToken",
    operation: identity.IdentityOperationsIssueAccessToken,
    grant: CommunicationRole.Identity,
  }),
);
