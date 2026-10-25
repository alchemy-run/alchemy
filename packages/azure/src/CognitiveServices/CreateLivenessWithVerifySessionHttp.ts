import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CreateLivenessWithVerifySession } from "./CreateLivenessWithVerifySession.ts";

/**
 * Implementation of {@link CreateLivenessWithVerifySession} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILivenessVerifySessionsCreateRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateLivenessWithVerifySession
 */
export const CreateLivenessWithVerifySessionHttp = Layer.effect(
  CreateLivenessWithVerifySession,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CreateLivenessWithVerifySession",
    operation: face.LivenessSessionOperationsCreateLivenessWithVerifySession,
    grant: AIRole.LivenessVerifySessionsCreate,
  }),
);
