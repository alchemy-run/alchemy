import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListLargeFaceListFaces } from "./ListLargeFaceListFaces.ts";

/**
 * Implementation of {@link ListLargeFaceListFaces} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListFacesReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListLargeFaceListFaces
 */
export const ListLargeFaceListFacesHttp = Layer.effect(
  ListLargeFaceListFaces,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListLargeFaceListFaces",
    operation: face.FaceListOperationsGetLargeFaceListFaces,
    grant: AIRole.LargeFaceListFacesRead,
  }),
);
