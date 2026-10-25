import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteLargePersonGroupPerson } from "./DeleteLargePersonGroupPerson.ts";

/**
 * Implementation of {@link DeleteLargePersonGroupPerson} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupPersonsDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteLargePersonGroupPerson
 */
export const DeleteLargePersonGroupPersonHttp = Layer.effect(
  DeleteLargePersonGroupPerson,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteLargePersonGroupPerson",
    operation: face.DeletePersonGroupOperationLargePersonGroupPerson,
    grant: AIRole.LargePersonGroupPersonsDelete,
  }),
);
