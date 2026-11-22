import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetPersonGroupPerson } from "./GetPersonGroupPerson.ts";

/**
 * Implementation of {@link GetPersonGroupPerson} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupPersonsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetPersonGroupPerson
 */
export const GetPersonGroupPersonHttp = Layer.effect(
  GetPersonGroupPerson,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetPersonGroupPerson",
    operation: face.GetPersonGroupOperationPersonGroupPerson,
    grant: AIRole.PersonGroupPersonsRead,
  }),
);
