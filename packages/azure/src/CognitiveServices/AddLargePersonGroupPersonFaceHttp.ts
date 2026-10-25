import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AddLargePersonGroupPersonFace } from "./AddLargePersonGroupPersonFace.ts";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";

/**
 * Implementation of {@link AddLargePersonGroupPersonFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupFacesWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AddLargePersonGroupPersonFace
 */
export const AddLargePersonGroupPersonFaceHttp = Layer.effect(
  AddLargePersonGroupPersonFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AddLargePersonGroupPersonFace",
    operation: face.AddPersonGroupOperationLargePersonGroupPersonFace,
    grant: AIRole.LargePersonGroupFacesWrite,
  }),
);
