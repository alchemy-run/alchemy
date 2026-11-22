import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CreateLivenessSession } from "./CreateLivenessSession.ts";

/**
 * Implementation of {@link CreateLivenessSession} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILivenessSessionsCreateRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateLivenessSession
 */
export const CreateLivenessSessionHttp = Layer.effect(
  CreateLivenessSession,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CreateLivenessSession",
    operation: face.CreateLivenessSessionOperationLivenessSession,
    grant: AIRole.LivenessSessionsCreate,
  }),
);
