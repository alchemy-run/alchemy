import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetPersonGroup } from "./GetPersonGroup.ts";

/**
 * Implementation of {@link GetPersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetPersonGroup
 */
export const GetPersonGroupHttp = Layer.effect(
  GetPersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetPersonGroup",
    operation: face.GetPersonGroupOperationPersonGroup,
    grant: AIRole.PersonGroupsRead,
  }),
);
