import * as neptune from "@distilled.cloud/aws/neptune";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeNeptuneClusterHttpBinding } from "./BindingHttp.ts";
import type { DBCluster } from "./DBCluster.ts";

/**
 * Runtime binding for the `CreateDBClusterSnapshot` operation (IAM actions
 * `rds:CreateDBClusterSnapshot` + `rds:AddTagsToResource`).
 *
 * Takes a manual snapshot of the bound {@link DBCluster} — e.g. a
 * pre-migration backup function or a scheduled snapshot-rotation job. The
 * cluster identifier is injected from the binding. Provide the
 * implementation with
 * `Effect.provide(AWS.Neptune.CreateDBClusterSnapshotHttp)`.
 * ### Managing Snapshots
 * **Example:** Take a Manual Snapshot
 * ```typescript
 * // init — bind the operation to the cluster
 * const createDBClusterSnapshot =
 *   yield* AWS.Neptune.CreateDBClusterSnapshot(cluster);
 *
 * // runtime
 * yield* createDBClusterSnapshot({
 *   DBClusterSnapshotIdentifier: `pre-migration-${runId}`,
 * });
 * ```
 *
 * @binding
 */
export interface CreateDBClusterSnapshot extends Binding.Service<
  CreateDBClusterSnapshot,
  "AWS.Neptune.CreateDBClusterSnapshot",
  (
    cluster: DBCluster,
  ) => Effect.Effect<
    (
      request?: Omit<neptune.CreateDBClusterSnapshotMessage, "DBClusterIdentifier">,
    ) => Effect.Effect<neptune.CreateDBClusterSnapshotResult, neptune.CreateDBClusterSnapshotError>
  >
> {}
export const CreateDBClusterSnapshot = Binding.Service<CreateDBClusterSnapshot>(
  "AWS.Neptune.CreateDBClusterSnapshot",
);

export const CreateDBClusterSnapshotHttp = Layer.effect(
  CreateDBClusterSnapshot,
  makeNeptuneClusterHttpBinding({
    tag: "AWS.Neptune.CreateDBClusterSnapshot",
    operation: neptune.createDBClusterSnapshot,
    actions: ["rds:CreateDBClusterSnapshot", "rds:AddTagsToResource"],
    // Snapshot creation authorizes against BOTH the source cluster ARN and
    // the target snapshot ARN — widen the grant to the account's Neptune
    // cluster-snapshot space (`arn:…:rds:{region}:{account}:cluster-snapshot:*`).
    extraResources: (clusterArn) => [
      `${clusterArn.split(":").slice(0, 5).join(":")}:cluster-snapshot:*`,
    ],
  }),
);
