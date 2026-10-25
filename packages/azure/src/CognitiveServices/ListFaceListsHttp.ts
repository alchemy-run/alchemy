import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListFaceLists } from "./ListFaceLists.ts";

/**
 * Implementation of {@link ListFaceLists} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceListsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListFaceLists
 */
export const ListFaceListsHttp = Layer.effect(
  ListFaceLists,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListFaceLists",
    operation: face.GetFaceListOperationFaceLists,
    grant: AIRole.FaceListsRead,
  }),
);
