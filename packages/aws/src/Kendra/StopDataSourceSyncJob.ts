import * as kendra from "@distilled.cloud/aws/kendra";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeKendraDataSourceHttpBinding } from "./BindingHttp.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * Runtime binding for the `StopDataSourceSyncJob` operation (IAM action
 * `kendra:StopDataSourceSyncJob`), scoped to one {@link DataSource}.
 *
 * Stops the data source's currently-running sync job, if any.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.StopDataSourceSyncJobHttp)`.
 *
 * ### Syncing Data Sources
 * **Example:** Stop a Running Sync
 * ```typescript
 * const stopSync = yield* AWS.Kendra.StopDataSourceSyncJob(source);
 *
 * yield* stopSync();
 * ```
 *
 * @binding
 */
export interface StopDataSourceSyncJob extends Binding.Service<
  StopDataSourceSyncJob,
  "AWS.Kendra.StopDataSourceSyncJob",
  (
    dataSource: DataSource,
  ) => Effect.Effect<
    () => Effect.Effect<kendra.StopDataSourceSyncJobResponse, kendra.StopDataSourceSyncJobError>
  >
> {}
export const StopDataSourceSyncJob = Binding.Service<StopDataSourceSyncJob>(
  "AWS.Kendra.StopDataSourceSyncJob",
);

export const StopDataSourceSyncJobHttp = Layer.effect(
  StopDataSourceSyncJob,
  makeKendraDataSourceHttpBinding({
    tag: "AWS.Kendra.StopDataSourceSyncJob",
    operation: kendra.stopDataSourceSyncJob,
    actions: ["kendra:StopDataSourceSyncJob"],
  }),
);
