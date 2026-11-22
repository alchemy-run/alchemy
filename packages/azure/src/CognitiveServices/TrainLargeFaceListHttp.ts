import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { TrainLargeFaceList } from "./TrainLargeFaceList.ts";

/**
 * Implementation of {@link TrainLargeFaceList} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListsTrainRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.TrainLargeFaceList
 */
export const TrainLargeFaceListHttp = Layer.effect(
  TrainLargeFaceList,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.TrainLargeFaceList",
    operation: face.FaceListOperationsTrainLargeFaceList,
    grant: AIRole.LargeFaceListsTrain,
  }),
);
