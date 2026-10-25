import * as identity from "@distilled.cloud/azure/communication-identity";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { CreateIdentity } from "./CreateIdentity.ts";

/**
 * Implementation of {@link CreateIdentity} over the distilled `communication-identity`
 * data plane. Assigns the custom `AzureCommunicationIdentityRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.CreateIdentity
 */
export const CreateIdentityHttp = Layer.effect(
  CreateIdentity,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.CreateIdentity",
    operation: identity.CreateIdentityOperation,
    grant: CommunicationRole.Identity,
  }),
);
