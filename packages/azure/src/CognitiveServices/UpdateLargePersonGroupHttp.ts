import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { UpdateLargePersonGroup } from "./UpdateLargePersonGroup.ts";

/**
 * Implementation of {@link UpdateLargePersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateLargePersonGroup
 */
export const UpdateLargePersonGroupHttp = Layer.effect(
  UpdateLargePersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.UpdateLargePersonGroup",
    operation: face.UpdatePersonGroupOperationLargePersonGroup,
    grant: AIRole.LargePersonGroupsWrite,
  }),
);
