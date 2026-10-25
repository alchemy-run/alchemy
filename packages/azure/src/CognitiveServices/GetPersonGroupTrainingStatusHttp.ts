import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetPersonGroupTrainingStatus } from "./GetPersonGroupTrainingStatus.ts";

/**
 * Implementation of {@link GetPersonGroupTrainingStatus} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupsTrainingReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetPersonGroupTrainingStatus
 */
export const GetPersonGroupTrainingStatusHttp = Layer.effect(
  GetPersonGroupTrainingStatus,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetPersonGroupTrainingStatus",
    operation: face.GetPersonGroupOperationPersonGroupTrainingStatus,
    grant: AIRole.PersonGroupsTrainingRead,
  }),
);
