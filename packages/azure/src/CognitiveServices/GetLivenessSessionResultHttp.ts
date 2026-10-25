import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetLivenessSessionResult } from "./GetLivenessSessionResult.ts";

/**
 * Implementation of {@link GetLivenessSessionResult} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILivenessSessionsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetLivenessSessionResult
 */
export const GetLivenessSessionResultHttp = Layer.effect(
  GetLivenessSessionResult,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetLivenessSessionResult",
    operation: face.GetLivenessSessionOperationLivenessSessionResult,
    grant: AIRole.LivenessSessionsRead,
  }),
);
