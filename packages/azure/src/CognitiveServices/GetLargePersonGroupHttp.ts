import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetLargePersonGroup } from "./GetLargePersonGroup.ts";

/**
 * Implementation of {@link GetLargePersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetLargePersonGroup
 */
export const GetLargePersonGroupHttp = Layer.effect(
  GetLargePersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetLargePersonGroup",
    operation: face.GetPersonGroupOperationLargePersonGroup,
    grant: AIRole.LargePersonGroupsRead,
  }),
);
