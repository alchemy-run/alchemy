import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetLargePersonGroupPerson } from "./GetLargePersonGroupPerson.ts";

/**
 * Implementation of {@link GetLargePersonGroupPerson} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupPersonsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetLargePersonGroupPerson
 */
export const GetLargePersonGroupPersonHttp = Layer.effect(
  GetLargePersonGroupPerson,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetLargePersonGroupPerson",
    operation: face.GetPersonGroupOperationLargePersonGroupPerson,
    grant: AIRole.LargePersonGroupPersonsRead,
  }),
);
