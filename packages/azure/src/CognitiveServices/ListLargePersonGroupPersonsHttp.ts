import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListLargePersonGroupPersons } from "./ListLargePersonGroupPersons.ts";

/**
 * Implementation of {@link ListLargePersonGroupPersons} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupPersonsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListLargePersonGroupPersons
 */
export const ListLargePersonGroupPersonsHttp = Layer.effect(
  ListLargePersonGroupPersons,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListLargePersonGroupPersons",
    operation: face.GetPersonGroupOperationLargePersonGroupPersons,
    grant: AIRole.LargePersonGroupPersonsRead,
  }),
);
