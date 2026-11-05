import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeB2biAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `b2bi:GenerateMapping`.
 *
 * Generates a mapping template (JSONATA or XSLT) from a sample input and
 * desired output document using AI-assisted mapping — useful for building
 * self-service EDI onboarding flows where trading partners supply sample
 * documents. `mappingAccuracy` reports the model's confidence. Provide the
 * implementation with `Effect.provide(AWS.B2BI.GenerateMappingHttp)`.
 * ### Generating Mappings
 * **Example:** Generate a JSONATA Template from Samples
 * ```typescript
 * // init — account-level, no resource argument
 * const generateMapping = yield* AWS.B2BI.GenerateMapping();
 *
 * // runtime
 * const result = yield* generateMapping({
 *   inputFileContent: JSON.stringify({ customer: "acme" }),
 *   outputFileContent: JSON.stringify({ name: "acme" }),
 *   mappingType: "JSONATA",
 * });
 * // result.mappingTemplate, result.mappingAccuracy
 * ```
 *
 * @binding
 */
export interface GenerateMapping extends Binding.Service<
  GenerateMapping,
  "AWS.B2BI.GenerateMapping",
  () => Effect.Effect<
    (
      request: b2bi.GenerateMappingRequest,
    ) => Effect.Effect<b2bi.GenerateMappingResponse, b2bi.GenerateMappingError>
  >
> {}
export const GenerateMapping = Binding.Service<GenerateMapping>("AWS.B2BI.GenerateMapping");

export const GenerateMappingHttp = Layer.effect(
  GenerateMapping,
  makeB2biAccountHttpBinding({
    tag: "AWS.B2BI.GenerateMapping",
    operation: b2bi.generateMapping,
    // GenerateMapping invokes Amazon Bedrock through the caller's session
    // (verified live: "Access denied when invoking Bedrock's InvokeModel
    // API" without the grant). The account must also have Bedrock model
    // access enabled for the mapping model in the region.
    actions: ["b2bi:GenerateMapping", "bedrock:InvokeModel"],
  }),
);
