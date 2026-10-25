import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetLargePersonGroupTrainingStatus } from "./GetLargePersonGroupTrainingStatus.ts";

/**
 * Implementation of {@link GetLargePersonGroupTrainingStatus} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupsTrainingReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetLargePersonGroupTrainingStatus
 */
export const GetLargePersonGroupTrainingStatusHttp = Layer.effect(
  GetLargePersonGroupTrainingStatus,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetLargePersonGroupTrainingStatus",
    operation: face.GetPersonGroupOperationLargePersonGroupTrainingStatus,
    grant: AIRole.LargePersonGroupsTrainingRead,
  }),
);
