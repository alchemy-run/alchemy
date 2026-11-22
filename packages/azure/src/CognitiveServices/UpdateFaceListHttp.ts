import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { UpdateFaceList } from "./UpdateFaceList.ts";

/**
 * Implementation of {@link UpdateFaceList} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceListsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateFaceList
 */
export const UpdateFaceListHttp = Layer.effect(
  UpdateFaceList,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.UpdateFaceList",
    operation: face.FaceListOperationsUpdateFaceList,
    grant: AIRole.FaceListsWrite,
  }),
);
