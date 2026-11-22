import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeletePersonGroupPerson } from "./DeletePersonGroupPerson.ts";

/**
 * Implementation of {@link DeletePersonGroupPerson} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupPersonsDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeletePersonGroupPerson
 */
export const DeletePersonGroupPersonHttp = Layer.effect(
  DeletePersonGroupPerson,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeletePersonGroupPerson",
    operation: face.DeletePersonGroupOperationPersonGroupPerson,
    grant: AIRole.PersonGroupPersonsDelete,
  }),
);
