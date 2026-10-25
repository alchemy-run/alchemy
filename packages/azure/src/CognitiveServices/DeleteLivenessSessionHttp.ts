import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteLivenessSession } from "./DeleteLivenessSession.ts";

/**
 * Implementation of {@link DeleteLivenessSession} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILivenessSessionsDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteLivenessSession
 */
export const DeleteLivenessSessionHttp = Layer.effect(
  DeleteLivenessSession,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteLivenessSession",
    operation: face.DeleteLivenessSessionOperationLivenessSession,
    grant: AIRole.LivenessSessionsDelete,
  }),
);
