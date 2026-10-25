import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteLargeFaceList } from "./DeleteLargeFaceList.ts";

/**
 * Implementation of {@link DeleteLargeFaceList} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListsDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteLargeFaceList
 */
export const DeleteLargeFaceListHttp = Layer.effect(
  DeleteLargeFaceList,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteLargeFaceList",
    operation: face.FaceListOperationsDeleteLargeFaceList,
    grant: AIRole.LargeFaceListsDelete,
  }),
);
