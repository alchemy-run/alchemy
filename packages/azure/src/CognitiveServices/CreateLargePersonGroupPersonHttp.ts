import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CreateLargePersonGroupPerson } from "./CreateLargePersonGroupPerson.ts";

/**
 * Implementation of {@link CreateLargePersonGroupPerson} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupPersonsCreateRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateLargePersonGroupPerson
 */
export const CreateLargePersonGroupPersonHttp = Layer.effect(
  CreateLargePersonGroupPerson,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CreateLargePersonGroupPerson",
    operation: face.CreatePersonGroupOperationLargePersonGroupPerson,
    grant: AIRole.LargePersonGroupPersonsCreate,
  }),
);
