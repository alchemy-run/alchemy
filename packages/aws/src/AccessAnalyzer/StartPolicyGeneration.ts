import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAccessAnalyzerAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `access-analyzer:StartPolicyGeneration`.
 *
 * Starts generating a least-privilege policy for a principal from its access
 * activity (optionally a CloudTrail trail). Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.StartPolicyGenerationHttp)`.
 * ### Policy Generation
 * **Example:** Generate a Policy for a Role
 * ```typescript
 * const startGeneration =
 *   yield* AWS.AccessAnalyzer.StartPolicyGeneration();
 * const { jobId } = yield* startGeneration({
 *   policyGenerationDetails: { principalArn: roleArn },
 * });
 * ```
 *
 * @binding
 */
export interface StartPolicyGeneration extends Binding.Service<
  StartPolicyGeneration,
  "AWS.AccessAnalyzer.StartPolicyGeneration",
  () => Effect.Effect<
    (
      request: aa.StartPolicyGenerationRequest,
    ) => Effect.Effect<aa.StartPolicyGenerationResponse, aa.StartPolicyGenerationError>
  >
> {}

export const StartPolicyGeneration = Binding.Service<StartPolicyGeneration>(
  "AWS.AccessAnalyzer.StartPolicyGeneration",
);

export const StartPolicyGenerationHttp = Layer.effect(
  StartPolicyGeneration,
  makeAccessAnalyzerAccountHttpBinding({
    tag: "AWS.AccessAnalyzer.StartPolicyGeneration",
    operation: aa.startPolicyGeneration,
    actions: ["access-analyzer:StartPolicyGeneration"],
  }),
);
