import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetLivenessWithVerifySessionResult } from "./GetLivenessWithVerifySessionResult.ts";

/**
 * Implementation of {@link GetLivenessWithVerifySessionResult} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILivenessVerifySessionsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetLivenessWithVerifySessionResult
 */
export const GetLivenessWithVerifySessionResultHttp = Layer.effect(
  GetLivenessWithVerifySessionResult,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetLivenessWithVerifySessionResult",
    operation: face.LivenessSessionOperationsGetLivenessWithVerifySessionResult,
    grant: AIRole.LivenessVerifySessionsRead,
  }),
);
