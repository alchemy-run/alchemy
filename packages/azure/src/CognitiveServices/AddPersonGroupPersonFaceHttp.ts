import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AddPersonGroupPersonFace } from "./AddPersonGroupPersonFace.ts";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";

/**
 * Implementation of {@link AddPersonGroupPersonFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupFacesWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AddPersonGroupPersonFace
 */
export const AddPersonGroupPersonFaceHttp = Layer.effect(
  AddPersonGroupPersonFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AddPersonGroupPersonFace",
    operation: face.AddPersonGroupOperationPersonGroupPersonFace,
    grant: AIRole.PersonGroupFacesWrite,
  }),
);
