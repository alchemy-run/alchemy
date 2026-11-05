import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeServerlessNamespaceHttpBinding, serverlessArnPrefix } from "./BindingHttp.ts";
import type { Namespace } from "./Namespace.ts";

/**
 * Runtime binding for the `RestoreTableFromRecoveryPoint` operation (IAM actions
 * `redshift-serverless:RestoreTableFromRecoveryPoint`).
 *
 * Restores a single table from an automatic recovery point into the bound
 * {@link Namespace} under a new name. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.RestoreTableFromRecoveryPointHttp)`.
 * ### Restoring Data
 * **Example:** Restore One Table from a Recovery Point
 * ```typescript
 * // init — resolve the runtime client
 * const restoreTable = yield* AWS.RedshiftServerless.RestoreTableFromRecoveryPoint(namespace);
 *
 * yield* restoreTable({
 *   workgroupName,
 *   recoveryPointId,
 *   sourceDatabaseName: "dev",
 *   sourceTableName: "orders",
 *   newTableName: "orders_restored",
 * });
 * ```
 *
 * @binding
 */
export interface RestoreTableFromRecoveryPoint extends Binding.Service<
  RestoreTableFromRecoveryPoint,
  "AWS.RedshiftServerless.RestoreTableFromRecoveryPoint",
  (
    namespace: Namespace,
  ) => Effect.Effect<
    (
      request: Omit<serverless.RestoreTableFromRecoveryPointRequest, "namespaceName">,
    ) => Effect.Effect<
      serverless.RestoreTableFromRecoveryPointResponse,
      serverless.RestoreTableFromRecoveryPointError
    >
  >
> {}
export const RestoreTableFromRecoveryPoint = Binding.Service<RestoreTableFromRecoveryPoint>(
  "AWS.RedshiftServerless.RestoreTableFromRecoveryPoint",
);

export const RestoreTableFromRecoveryPointHttp = Layer.effect(
  RestoreTableFromRecoveryPoint,
  makeServerlessNamespaceHttpBinding({
    tag: "AWS.RedshiftServerless.RestoreTableFromRecoveryPoint",
    operation: serverless.restoreTableFromRecoveryPoint,
    actions: ["redshift-serverless:RestoreTableFromRecoveryPoint"],
    // The operation authorizes against sibling resource ARNs (snapshots,
    // recovery points, the serving workgroup) in addition to the namespace.
    extraResources: (arn) => {
      const prefix = serverlessArnPrefix(arn);
      return [`${prefix}:recoverypoint/*`, `${prefix}:workgroup/*`];
    },
  }),
);
