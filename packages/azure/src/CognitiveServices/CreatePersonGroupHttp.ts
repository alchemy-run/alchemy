import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CreatePersonGroup } from "./CreatePersonGroup.ts";

/**
 * Implementation of {@link CreatePersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreatePersonGroup
 */
export const CreatePersonGroupHttp = Layer.effect(
  CreatePersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CreatePersonGroup",
    operation: face.CreatePersonGroupOperationPersonGroup,
    grant: AIRole.PersonGroupsWrite,
  }),
);
