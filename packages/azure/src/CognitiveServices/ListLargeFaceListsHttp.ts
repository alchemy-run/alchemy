import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListLargeFaceLists } from "./ListLargeFaceLists.ts";

/**
 * Implementation of {@link ListLargeFaceLists} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListLargeFaceLists
 */
export const ListLargeFaceListsHttp = Layer.effect(
  ListLargeFaceLists,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListLargeFaceLists",
    operation: face.GetFaceListOperationLargeFaceLists,
    grant: AIRole.LargeFaceListsRead,
  }),
);
