import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CreateLargePersonGroup } from "./CreateLargePersonGroup.ts";

/**
 * Implementation of {@link CreateLargePersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateLargePersonGroup
 */
export const CreateLargePersonGroupHttp = Layer.effect(
  CreateLargePersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CreateLargePersonGroup",
    operation: face.CreatePersonGroupOperationLargePersonGroup,
    grant: AIRole.LargePersonGroupsWrite,
  }),
);
