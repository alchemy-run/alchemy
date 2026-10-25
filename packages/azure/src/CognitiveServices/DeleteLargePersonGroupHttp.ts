import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteLargePersonGroup } from "./DeleteLargePersonGroup.ts";

/**
 * Implementation of {@link DeleteLargePersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupsDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteLargePersonGroup
 */
export const DeleteLargePersonGroupHttp = Layer.effect(
  DeleteLargePersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteLargePersonGroup",
    operation: face.DeletePersonGroupOperationLargePersonGroup,
    grant: AIRole.LargePersonGroupsDelete,
  }),
);
