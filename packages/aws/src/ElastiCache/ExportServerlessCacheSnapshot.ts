import * as elasticache from "@distilled.cloud/aws/elasticache";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeElastiCacheAccountHttpBinding,
  SERVERLESS_SNAPSHOT_ARN_WILDCARD,
} from "./BindingHttp.ts";

/**
 * Runtime binding for the `ExportServerlessCacheSnapshot` operation (IAM
 * action `elasticache:ExportServerlessCacheSnapshot`).
 *
 * Exports a serverless cache snapshot's data to an S3 bucket — e.g. shipping
 * a backup out of ElastiCache for offline analysis or cross-account
 * restore. Available for valkey and redis only. The target bucket must grant
 * the ElastiCache service access via its bucket policy. Provide the
 * implementation with
 * `Effect.provide(AWS.ElastiCache.ExportServerlessCacheSnapshotHttp)`.
 * ### Managing Snapshots
 * **Example:** Export a Snapshot to S3
 * ```typescript
 * const exportSnapshot = yield* ElastiCache.ExportServerlessCacheSnapshot();
 *
 * yield* exportSnapshot({
 *   ServerlessCacheSnapshotName: "nightly",
 *   S3BucketName: "my-backup-bucket",
 * });
 * ```
 *
 * @binding
 */
export interface ExportServerlessCacheSnapshot extends Binding.Service<
  ExportServerlessCacheSnapshot,
  "AWS.ElastiCache.ExportServerlessCacheSnapshot",
  () => Effect.Effect<
    (
      request: elasticache.ExportServerlessCacheSnapshotRequest,
    ) => Effect.Effect<
      elasticache.ExportServerlessCacheSnapshotResponse,
      elasticache.ExportServerlessCacheSnapshotError
    >
  >
> {}
export const ExportServerlessCacheSnapshot = Binding.Service<ExportServerlessCacheSnapshot>(
  "AWS.ElastiCache.ExportServerlessCacheSnapshot",
);

export const ExportServerlessCacheSnapshotHttp = Layer.effect(
  ExportServerlessCacheSnapshot,
  makeElastiCacheAccountHttpBinding({
    tag: "AWS.ElastiCache.ExportServerlessCacheSnapshot",
    operation: elasticache.exportServerlessCacheSnapshot,
    actions: ["elasticache:ExportServerlessCacheSnapshot"],
    // Snapshot names are runtime data. S3 access is granted to the
    // ElastiCache service via the target bucket's policy, not to the caller.
    resources: [SERVERLESS_SNAPSHOT_ARN_WILDCARD],
  }),
);
