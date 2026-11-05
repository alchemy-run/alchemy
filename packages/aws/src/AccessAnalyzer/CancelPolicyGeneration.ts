import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAccessAnalyzerAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `access-analyzer:CancelPolicyGeneration`.
 *
 * Cancels an in-progress policy-generation job. Provide the implementation
 * with `Effect.provide(AWS.AccessAnalyzer.CancelPolicyGenerationHttp)`.
 * ### Policy Generation
 * **Example:** Cancel a Generation Job
 * ```typescript
 * const cancelGeneration =
 *   yield* AWS.AccessAnalyzer.CancelPolicyGeneration();
 * yield* cancelGeneration({ jobId });
 * ```
 *
 * @binding
 */
export interface CancelPolicyGeneration extends Binding.Service<
  CancelPolicyGeneration,
  "AWS.AccessAnalyzer.CancelPolicyGeneration",
  () => Effect.Effect<
    (
      request: aa.CancelPolicyGenerationRequest,
    ) => Effect.Effect<aa.CancelPolicyGenerationResponse, aa.CancelPolicyGenerationError>
  >
> {}

export const CancelPolicyGeneration = Binding.Service<CancelPolicyGeneration>(
  "AWS.AccessAnalyzer.CancelPolicyGeneration",
);

export const CancelPolicyGenerationHttp = Layer.effect(
  CancelPolicyGeneration,
  makeAccessAnalyzerAccountHttpBinding({
    tag: "AWS.AccessAnalyzer.CancelPolicyGeneration",
    operation: aa.cancelPolicyGeneration,
    actions: ["access-analyzer:CancelPolicyGeneration"],
  }),
);
