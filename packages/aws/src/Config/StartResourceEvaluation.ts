import * as config from "@distilled.cloud/aws/config-service";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `config:StartResourceEvaluation` — proactively
 * evaluate a hypothetical resource configuration against your PROACTIVE
 * Config rules before the resource is deployed.
 *
 * Provide `Config.StartResourceEvaluationHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * ### Proactive Resource Evaluation
 * **Example:** Evaluate a Resource Before Deploying
 * ```typescript
 * // init — grants config:StartResourceEvaluation
 * const startResourceEvaluation = yield* AWS.Config.StartResourceEvaluation();
 *
 * // runtime
 * const result = yield* startResourceEvaluation({
 *   EvaluationMode: "PROACTIVE",
 *   ResourceDetails: {
 *     ResourceId: "my-bucket",
 *     ResourceType: "AWS::S3::Bucket",
 *     ResourceConfiguration: JSON.stringify({
 *       BucketName: "my-bucket",
 *     }),
 *     ResourceConfigurationSchemaType: "CFN_RESOURCE_SCHEMA",
 *   },
 * });
 * console.log(result.ResourceEvaluationId);
 * ```
 *
 * @binding
 */
export interface StartResourceEvaluation extends Binding.Service<
  StartResourceEvaluation,
  "AWS.Config.StartResourceEvaluation",
  () => Effect.Effect<
    (
      request: config.StartResourceEvaluationRequest,
    ) => Effect.Effect<config.StartResourceEvaluationResponse, config.StartResourceEvaluationError>
  >
> {}

export const StartResourceEvaluation = Binding.Service<StartResourceEvaluation>(
  "AWS.Config.StartResourceEvaluation",
);

export const StartResourceEvaluationHttp = Layer.effect(
  StartResourceEvaluation,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.StartResourceEvaluation",
    operation: config.startResourceEvaluation,
    // cloudformation:DescribeType is a dependent action: Config validates
    // the CFN_RESOURCE_SCHEMA resource type schema with the CALLER's
    // permissions and rejects with AccessDeniedException without it
    // (observed live; see the StartResourceEvaluation API reference).
    actions: ["config:StartResourceEvaluation", "cloudformation:DescribeType"],
  }),
);
