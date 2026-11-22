import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { UpdatePersonGroup } from "./UpdatePersonGroup.ts";

/**
 * Implementation of {@link UpdatePersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdatePersonGroup
 */
export const UpdatePersonGroupHttp = Layer.effect(
  UpdatePersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.UpdatePersonGroup",
    operation: face.UpdatePersonGroupOperationPersonGroup,
    grant: AIRole.PersonGroupsWrite,
  }),
);
