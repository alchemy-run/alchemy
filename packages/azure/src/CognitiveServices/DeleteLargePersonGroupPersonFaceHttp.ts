import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteLargePersonGroupPersonFace } from "./DeleteLargePersonGroupPersonFace.ts";

/**
 * Implementation of {@link DeleteLargePersonGroupPersonFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupFacesDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteLargePersonGroupPersonFace
 */
export const DeleteLargePersonGroupPersonFaceHttp = Layer.effect(
  DeleteLargePersonGroupPersonFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteLargePersonGroupPersonFace",
    operation: face.DeletePersonGroupOperationLargePersonGroupPersonFace,
    grant: AIRole.LargePersonGroupFacesDelete,
  }),
);
