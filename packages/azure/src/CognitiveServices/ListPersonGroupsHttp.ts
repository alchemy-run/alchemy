import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListPersonGroups } from "./ListPersonGroups.ts";

/**
 * Implementation of {@link ListPersonGroups} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListPersonGroups
 */
export const ListPersonGroupsHttp = Layer.effect(
  ListPersonGroups,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListPersonGroups",
    operation: face.GetPersonGroupOperationPersonGroups,
    grant: AIRole.PersonGroupsRead,
  }),
);
