import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GroupFaces } from "./GroupFaces.ts";

/**
 * Implementation of {@link GroupFaces} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceGroupRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GroupFaces
 */
export const GroupFacesHttp = Layer.effect(
  GroupFaces,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GroupFaces",
    operation: face.FaceRecognitionOperationsGroup,
    grant: AIRole.FaceGroup,
  }),
);
