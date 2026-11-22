import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { UpdatePersonGroupPerson } from "./UpdatePersonGroupPerson.ts";

/**
 * Implementation of {@link UpdatePersonGroupPerson} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupPersonsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdatePersonGroupPerson
 */
export const UpdatePersonGroupPersonHttp = Layer.effect(
  UpdatePersonGroupPerson,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.UpdatePersonGroupPerson",
    operation: face.UpdatePersonGroupOperationPersonGroupPerson,
    grant: AIRole.PersonGroupPersonsWrite,
  }),
);
