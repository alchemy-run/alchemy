import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetLargeFaceListTrainingStatus } from "./GetLargeFaceListTrainingStatus.ts";

/**
 * Implementation of {@link GetLargeFaceListTrainingStatus} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListsTrainingReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetLargeFaceListTrainingStatus
 */
export const GetLargeFaceListTrainingStatusHttp = Layer.effect(
  GetLargeFaceListTrainingStatus,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetLargeFaceListTrainingStatus",
    operation: face.FaceListOperationsGetLargeFaceListTrainingStatus,
    grant: AIRole.LargeFaceListsTrainingRead,
  }),
);
