import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { TrainLargePersonGroup } from "./TrainLargePersonGroup.ts";

/**
 * Implementation of {@link TrainLargePersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupsTrainRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.TrainLargePersonGroup
 */
export const TrainLargePersonGroupHttp = Layer.effect(
  TrainLargePersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.TrainLargePersonGroup",
    operation: face.PersonGroupOperationsTrainLargePersonGroup,
    grant: AIRole.LargePersonGroupsTrain,
  }),
);
