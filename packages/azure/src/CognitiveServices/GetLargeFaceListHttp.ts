import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetLargeFaceList } from "./GetLargeFaceList.ts";

/**
 * Implementation of {@link GetLargeFaceList} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetLargeFaceList
 */
export const GetLargeFaceListHttp = Layer.effect(
  GetLargeFaceList,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetLargeFaceList",
    operation: face.FaceListOperationsGetLargeFaceList,
    grant: AIRole.LargeFaceListsRead,
  }),
);
