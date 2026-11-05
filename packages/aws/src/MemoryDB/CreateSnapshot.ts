import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMemoryDBClusterHttpBinding, SNAPSHOT_ARN_WILDCARD } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `CreateSnapshot` operation (IAM actions
 * `memorydb:CreateSnapshot` + `memorydb:TagResource`), scoped to one
 * {@link Cluster}.
 *
 * Takes an on-demand snapshot of the bound cluster — e.g. a pre-migration
 * backup from an operational Lambda. Provide the implementation with
 * `Effect.provide(AWS.MemoryDB.CreateSnapshotHttp)`.
 * ### Managing Snapshots
 * **Example:** Take an On-Demand Snapshot
 * ```typescript
 * const createSnapshot = yield* MemoryDB.CreateSnapshot(cluster);
 *
 * const result = yield* createSnapshot({ SnapshotName: "pre-migration" });
 * // result.Snapshot.Status → "creating"
 * ```
 *
 * @binding
 */
export interface CreateSnapshot extends Binding.Service<
  CreateSnapshot,
  "AWS.MemoryDB.CreateSnapshot",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<memorydb.CreateSnapshotRequest, "ClusterName">,
    ) => Effect.Effect<memorydb.CreateSnapshotResponse, memorydb.CreateSnapshotError>
  >
> {}
export const CreateSnapshot = Binding.Service<CreateSnapshot>("AWS.MemoryDB.CreateSnapshot");

export const CreateSnapshotHttp = Layer.effect(
  CreateSnapshot,
  makeMemoryDBClusterHttpBinding({
    tag: "AWS.MemoryDB.CreateSnapshot",
    operation: memorydb.createSnapshot,
    // TagResource authorizes tag-on-create for the snapshot.
    actions: ["memorydb:CreateSnapshot", "memorydb:TagResource"],
    // The action authorizes against both the source cluster and the
    // to-be-created snapshot (whose name-based ARN is runtime data).
    extraResources: [SNAPSHOT_ARN_WILDCARD],
  }),
);
