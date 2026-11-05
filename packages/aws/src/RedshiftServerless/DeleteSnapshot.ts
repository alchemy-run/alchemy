import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeServerlessAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `DeleteSnapshot` operation (IAM actions
 * `redshift-serverless:DeleteSnapshot`).
 *
 * Deletes a manual snapshot — the cleanup half of a snapshot-rotation
 * job. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.DeleteSnapshotHttp)`.
 * ### Managing Snapshots
 * **Example:** Delete an Expired Snapshot
 * ```typescript
 * // init — resolve the runtime client
 * const deleteSnapshot = yield* AWS.RedshiftServerless.DeleteSnapshot();
 *
 * yield* deleteSnapshot({ snapshotName: "pre-migration-1" });
 * ```
 *
 * @binding
 */
export interface DeleteSnapshot extends Binding.Service<
  DeleteSnapshot,
  "AWS.RedshiftServerless.DeleteSnapshot",
  () => Effect.Effect<
    (
      request: serverless.DeleteSnapshotRequest,
    ) => Effect.Effect<serverless.DeleteSnapshotResponse, serverless.DeleteSnapshotError>
  >
> {}
export const DeleteSnapshot = Binding.Service<DeleteSnapshot>(
  "AWS.RedshiftServerless.DeleteSnapshot",
);

export const DeleteSnapshotHttp = Layer.effect(
  DeleteSnapshot,
  makeServerlessAccountHttpBinding({
    tag: "AWS.RedshiftServerless.DeleteSnapshot",
    operation: serverless.deleteSnapshot,
    actions: ["redshift-serverless:DeleteSnapshot"],
  }),
);
