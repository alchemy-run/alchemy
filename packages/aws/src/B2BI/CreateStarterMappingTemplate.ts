import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeB2biAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `b2bi:CreateStarterMappingTemplate`.
 *
 * Generates a starter mapping template (JSONATA or XSLT) for a given X12
 * transaction set — a scaffold covering every field of the transaction that
 * can be edited down to the desired mapping. Optionally writes the template
 * to S3 via `outputSampleLocation`. Provide the implementation with
 * `Effect.provide(AWS.B2BI.CreateStarterMappingTemplateHttp)`.
 * ### Generating Mappings
 * **Example:** Scaffold a JSONATA Template for X12 850
 * ```typescript
 * // init — account-level, no resource argument
 * const createStarterMappingTemplate =
 *   yield* AWS.B2BI.CreateStarterMappingTemplate();
 *
 * // runtime
 * const result = yield* createStarterMappingTemplate({
 *   mappingType: "JSONATA",
 *   templateDetails: {
 *     x12: { transactionSet: "X12_850", version: "VERSION_4010" },
 *   },
 * });
 * // result.mappingTemplate — the generated starter template
 * ```
 *
 * @binding
 */
export interface CreateStarterMappingTemplate extends Binding.Service<
  CreateStarterMappingTemplate,
  "AWS.B2BI.CreateStarterMappingTemplate",
  () => Effect.Effect<
    (
      request: b2bi.CreateStarterMappingTemplateRequest,
    ) => Effect.Effect<
      b2bi.CreateStarterMappingTemplateResponse,
      b2bi.CreateStarterMappingTemplateError
    >
  >
> {}
export const CreateStarterMappingTemplate = Binding.Service<CreateStarterMappingTemplate>(
  "AWS.B2BI.CreateStarterMappingTemplate",
);

export const CreateStarterMappingTemplateHttp = Layer.effect(
  CreateStarterMappingTemplate,
  makeB2biAccountHttpBinding({
    tag: "AWS.B2BI.CreateStarterMappingTemplate",
    operation: b2bi.createStarterMappingTemplate,
    // `outputSampleLocation` is written through the caller's session
    // (forward-access), so the S3 write grant rides along.
    actions: ["b2bi:CreateStarterMappingTemplate", "s3:PutObject"],
  }),
);
