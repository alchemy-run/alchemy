import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListPersonGroupPersons } from "./ListPersonGroupPersons.ts";

/**
 * Implementation of {@link ListPersonGroupPersons} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupPersonsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListPersonGroupPersons
 */
export const ListPersonGroupPersonsHttp = Layer.effect(
  ListPersonGroupPersons,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListPersonGroupPersons",
    operation: face.GetPersonGroupOperationPersonGroupPersons,
    grant: AIRole.PersonGroupPersonsRead,
  }),
);
