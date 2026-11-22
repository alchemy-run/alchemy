import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { UpdateLargePersonGroupPerson } from "./UpdateLargePersonGroupPerson.ts";

/**
 * Implementation of {@link UpdateLargePersonGroupPerson} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupPersonsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateLargePersonGroupPerson
 */
export const UpdateLargePersonGroupPersonHttp = Layer.effect(
  UpdateLargePersonGroupPerson,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.UpdateLargePersonGroupPerson",
    operation: face.UpdatePersonGroupOperationLargePersonGroupPerson,
    grant: AIRole.LargePersonGroupPersonsWrite,
  }),
);
