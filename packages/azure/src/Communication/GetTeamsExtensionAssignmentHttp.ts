import * as identity from "@distilled.cloud/azure/communication-identity";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetTeamsExtensionAssignment } from "./GetTeamsExtensionAssignment.ts";

/**
 * Implementation of {@link GetTeamsExtensionAssignment} over the distilled `communication-identity`
 * data plane. Assigns the custom `AzureCommunicationIdentityRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.GetTeamsExtensionAssignment
 */
export const GetTeamsExtensionAssignmentHttp = Layer.effect(
  GetTeamsExtensionAssignment,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetTeamsExtensionAssignment",
    operation: identity.GetTeamsExtensionOperationAssignment,
    grant: CommunicationRole.Identity,
  }),
);
