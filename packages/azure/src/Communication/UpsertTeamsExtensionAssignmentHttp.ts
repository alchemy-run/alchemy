import * as identity from "@distilled.cloud/azure/communication-identity";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpsertTeamsExtensionAssignment } from "./UpsertTeamsExtensionAssignment.ts";

/**
 * Implementation of {@link UpsertTeamsExtensionAssignment} over the distilled `communication-identity`
 * data plane. Assigns the custom `AzureCommunicationIdentityRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.UpsertTeamsExtensionAssignment
 */
export const UpsertTeamsExtensionAssignmentHttp = Layer.effect(
  UpsertTeamsExtensionAssignment,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpsertTeamsExtensionAssignment",
    operation: identity.UpsertTeamsExtensionOperationAssignment,
    grant: CommunicationRole.Identity,
  }),
);
