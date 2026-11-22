import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeletePersonGroup } from "./DeletePersonGroup.ts";

/**
 * Implementation of {@link DeletePersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupsDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeletePersonGroup
 */
export const DeletePersonGroupHttp = Layer.effect(
  DeletePersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeletePersonGroup",
    operation: face.DeletePersonGroupOperationPersonGroup,
    grant: AIRole.PersonGroupsDelete,
  }),
);
