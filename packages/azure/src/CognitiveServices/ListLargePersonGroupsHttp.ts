import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListLargePersonGroups } from "./ListLargePersonGroups.ts";

/**
 * Implementation of {@link ListLargePersonGroups} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListLargePersonGroups
 */
export const ListLargePersonGroupsHttp = Layer.effect(
  ListLargePersonGroups,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListLargePersonGroups",
    operation: face.GetPersonGroupOperationLargePersonGroups,
    grant: AIRole.LargePersonGroupsRead,
  }),
);
