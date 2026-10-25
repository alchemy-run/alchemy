import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CreateLargeFaceList } from "./CreateLargeFaceList.ts";

/**
 * Implementation of {@link CreateLargeFaceList} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateLargeFaceList
 */
export const CreateLargeFaceListHttp = Layer.effect(
  CreateLargeFaceList,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CreateLargeFaceList",
    operation: face.FaceListOperationsCreateLargeFaceList,
    grant: AIRole.LargeFaceListsWrite,
  }),
);
