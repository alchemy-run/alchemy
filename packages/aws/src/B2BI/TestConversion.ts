import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeB2biAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `b2bi:TestConversion`.
 *
 * Synchronously converts an inline JSON or XML document into an outbound
 * X12 EDI document — the inline counterpart of an outbound transformer's
 * conversion step. Provide the implementation with
 * `Effect.provide(AWS.B2BI.TestConversionHttp)`.
 * ### Converting Documents to EDI
 * **Example:** Convert JSON to an X12 850
 * ```typescript
 * // init — account-level, no resource argument
 * const testConversion = yield* AWS.B2BI.TestConversion();
 *
 * // runtime
 * const result = yield* testConversion({
 *   source: { fileFormat: "JSON", inputFile: { fileContent } },
 *   target: {
 *     fileFormat: "X12",
 *     formatDetails: {
 *       x12: { transactionSet: "X12_850", version: "VERSION_4010" },
 *     },
 *   },
 * });
 * // result.convertedFileContent — the generated X12 document
 * ```
 *
 * @binding
 */
export interface TestConversion extends Binding.Service<
  TestConversion,
  "AWS.B2BI.TestConversion",
  () => Effect.Effect<
    (
      request: b2bi.TestConversionRequest,
    ) => Effect.Effect<b2bi.TestConversionResponse, b2bi.TestConversionError>
  >
> {}
export const TestConversion = Binding.Service<TestConversion>("AWS.B2BI.TestConversion");

export const TestConversionHttp = Layer.effect(
  TestConversion,
  makeB2biAccountHttpBinding({
    tag: "AWS.B2BI.TestConversion",
    operation: b2bi.testConversion,
    // `target.outputSampleFile` is read through the caller's session
    // (forward-access), so the S3 read grants ride along.
    actions: ["b2bi:TestConversion", "s3:GetObject", "s3:GetObjectAttributes"],
  }),
);
