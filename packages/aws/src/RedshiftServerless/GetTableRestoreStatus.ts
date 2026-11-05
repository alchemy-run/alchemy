import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeServerlessAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `GetTableRestoreStatus` operation (IAM actions
 * `redshift-serverless:GetTableRestoreStatus`).
 *
 * Polls one table-restore request started with
 * {@link RestoreTableFromSnapshot} or {@link RestoreTableFromRecoveryPoint}. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.GetTableRestoreStatusHttp)`.
 * ### Restoring Data
 * **Example:** Poll a Table Restore
 * ```typescript
 * // init — resolve the runtime client
 * const getTableRestoreStatus = yield* AWS.RedshiftServerless.GetTableRestoreStatus();
 *
 * const { tableRestoreStatus } = yield* getTableRestoreStatus({
 *   tableRestoreRequestId,
 * });
 * ```
 *
 * @binding
 */
export interface GetTableRestoreStatus extends Binding.Service<
  GetTableRestoreStatus,
  "AWS.RedshiftServerless.GetTableRestoreStatus",
  () => Effect.Effect<
    (
      request: serverless.GetTableRestoreStatusRequest,
    ) => Effect.Effect<
      serverless.GetTableRestoreStatusResponse,
      serverless.GetTableRestoreStatusError
    >
  >
> {}
export const GetTableRestoreStatus = Binding.Service<GetTableRestoreStatus>(
  "AWS.RedshiftServerless.GetTableRestoreStatus",
);

export const GetTableRestoreStatusHttp = Layer.effect(
  GetTableRestoreStatus,
  makeServerlessAccountHttpBinding({
    tag: "AWS.RedshiftServerless.GetTableRestoreStatus",
    operation: serverless.getTableRestoreStatus,
    actions: ["redshift-serverless:GetTableRestoreStatus"],
  }),
);
