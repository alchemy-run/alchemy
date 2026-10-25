import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { UpdateLargePersonGroupPersonFace } from "./UpdateLargePersonGroupPersonFace.ts";

/**
 * Implementation of {@link UpdateLargePersonGroupPersonFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupFacesWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateLargePersonGroupPersonFace
 */
export const UpdateLargePersonGroupPersonFaceHttp = Layer.effect(
  UpdateLargePersonGroupPersonFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.UpdateLargePersonGroupPersonFace",
    operation: face.UpdatePersonGroupOperationLargePersonGroupPersonFace,
    grant: AIRole.LargePersonGroupFacesWrite,
  }),
);
