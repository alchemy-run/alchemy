import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `inspector2:BatchGetMemberEc2DeepInspectionStatus`.
 *
 * Retrieves Amazon Inspector deep inspection activation status of multiple member accounts within
 * your organization. You must be the delegated administrator of an organization in Amazon Inspector to
 * use this API.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.BatchGetMemberEc2DeepInspectionStatusHttp)`.
 * ### Organization & Members
 * **Example:** Read Members' Deep Inspection Status
 * ```typescript
 * // init
 * const batchGetMemberEc2DeepInspectionStatus = yield* AWS.Inspector2.BatchGetMemberEc2DeepInspectionStatus();
 *
 * // runtime
 * const { accountIds } = yield* batchGetMemberEc2DeepInspectionStatus();
 * ```
 *
 * @binding
 */
export interface BatchGetMemberEc2DeepInspectionStatus extends Binding.Service<
  BatchGetMemberEc2DeepInspectionStatus,
  "AWS.Inspector2.BatchGetMemberEc2DeepInspectionStatus",
  () => Effect.Effect<
    (
      request?: inspector2.BatchGetMemberEc2DeepInspectionStatusRequest,
    ) => Effect.Effect<
      inspector2.BatchGetMemberEc2DeepInspectionStatusResponse,
      inspector2.BatchGetMemberEc2DeepInspectionStatusError
    >
  >
> {}
export const BatchGetMemberEc2DeepInspectionStatus =
  Binding.Service<BatchGetMemberEc2DeepInspectionStatus>(
    "AWS.Inspector2.BatchGetMemberEc2DeepInspectionStatus",
  );

export const BatchGetMemberEc2DeepInspectionStatusHttp = Layer.effect(
  BatchGetMemberEc2DeepInspectionStatus,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.BatchGetMemberEc2DeepInspectionStatus",
    operation: inspector2.batchGetMemberEc2DeepInspectionStatus,
    actions: ["inspector2:BatchGetMemberEc2DeepInspectionStatus"],
  }),
);
