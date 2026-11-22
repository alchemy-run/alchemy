import * as identity from "@distilled.cloud/azure/communication-identity";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { DeleteTeamsExtensionAssignment } from "./DeleteTeamsExtensionAssignment.ts";

/**
 * Implementation of {@link DeleteTeamsExtensionAssignment} over the distilled `communication-identity`
 * data plane. Assigns the custom `AzureCommunicationIdentityRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.DeleteTeamsExtensionAssignment
 */
export const DeleteTeamsExtensionAssignmentHttp = Layer.effect(
  DeleteTeamsExtensionAssignment,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.DeleteTeamsExtensionAssignment",
    operation: identity.DeleteTeamsExtensionOperationAssignment,
    grant: CommunicationRole.Identity,
  }),
);
