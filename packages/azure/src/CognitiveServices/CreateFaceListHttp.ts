import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CreateFaceList } from "./CreateFaceList.ts";

/**
 * Implementation of {@link CreateFaceList} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceListsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateFaceList
 */
export const CreateFaceListHttp = Layer.effect(
  CreateFaceList,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CreateFaceList",
    operation: face.FaceListOperationsCreateFaceList,
    grant: AIRole.FaceListsWrite,
  }),
);
