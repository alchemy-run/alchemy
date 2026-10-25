import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CreatePersonGroupPerson } from "./CreatePersonGroupPerson.ts";

/**
 * Implementation of {@link CreatePersonGroupPerson} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupPersonsCreateRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreatePersonGroupPerson
 */
export const CreatePersonGroupPersonHttp = Layer.effect(
  CreatePersonGroupPerson,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CreatePersonGroupPerson",
    operation: face.CreatePersonGroupOperationPersonGroupPerson,
    grant: AIRole.PersonGroupPersonsCreate,
  }),
);
