import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteFaceList } from "./DeleteFaceList.ts";

/**
 * Implementation of {@link DeleteFaceList} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceListsDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteFaceList
 */
export const DeleteFaceListHttp = Layer.effect(
  DeleteFaceList,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteFaceList",
    operation: face.FaceListOperationsDeleteFaceList,
    grant: AIRole.FaceListsDelete,
  }),
);
