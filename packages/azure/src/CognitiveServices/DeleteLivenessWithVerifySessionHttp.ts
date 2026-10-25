import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteLivenessWithVerifySession } from "./DeleteLivenessWithVerifySession.ts";

/**
 * Implementation of {@link DeleteLivenessWithVerifySession} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILivenessVerifySessionsDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteLivenessWithVerifySession
 */
export const DeleteLivenessWithVerifySessionHttp = Layer.effect(
  DeleteLivenessWithVerifySession,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteLivenessWithVerifySession",
    operation: face.LivenessSessionOperationsDeleteLivenessWithVerifySession,
    grant: AIRole.LivenessVerifySessionsDelete,
  }),
);
