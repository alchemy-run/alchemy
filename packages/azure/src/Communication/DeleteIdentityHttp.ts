import * as identity from "@distilled.cloud/azure/communication-identity";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { DeleteIdentity } from "./DeleteIdentity.ts";

/**
 * Implementation of {@link DeleteIdentity} over the distilled `communication-identity`
 * data plane. Assigns the custom `AzureCommunicationIdentityRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.DeleteIdentity
 */
export const DeleteIdentityHttp = Layer.effect(
  DeleteIdentity,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.DeleteIdentity",
    operation: identity.DeleteIdentityOperation,
    grant: CommunicationRole.Identity,
  }),
);
