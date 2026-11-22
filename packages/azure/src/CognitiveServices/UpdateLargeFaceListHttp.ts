import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { UpdateLargeFaceList } from "./UpdateLargeFaceList.ts";

/**
 * Implementation of {@link UpdateLargeFaceList} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateLargeFaceList
 */
export const UpdateLargeFaceListHttp = Layer.effect(
  UpdateLargeFaceList,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.UpdateLargeFaceList",
    operation: face.FaceListOperationsUpdateLargeFaceList,
    grant: AIRole.LargeFaceListsWrite,
  }),
);
