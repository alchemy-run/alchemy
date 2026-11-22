import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { TrainPersonGroup } from "./TrainPersonGroup.ts";

/**
 * Implementation of {@link TrainPersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupsTrainRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.TrainPersonGroup
 */
export const TrainPersonGroupHttp = Layer.effect(
  TrainPersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.TrainPersonGroup",
    operation: face.PersonGroupOperationsTrainPersonGroup,
    grant: AIRole.PersonGroupsTrain,
  }),
);
