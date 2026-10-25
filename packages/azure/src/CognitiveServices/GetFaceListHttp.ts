import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetFaceList } from "./GetFaceList.ts";

/**
 * Implementation of {@link GetFaceList} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceListsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetFaceList
 */
export const GetFaceListHttp = Layer.effect(
  GetFaceList,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetFaceList",
    operation: face.FaceListOperationsGetFaceList,
    grant: AIRole.FaceListsRead,
  }),
);
