import * as backup from "@distilled.cloud/aws/backup";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `StopBackupJob` operation (IAM action
 * `backup:StopBackupJob`).
 *
 * Cancels a running backup job. Only jobs for resource types that support
 * cancellation can be stopped. Provide the implementation with
 * `Effect.provide(AWS.Backup.StopBackupJobHttp)`.
 * ### Monitoring Backup Jobs
 * **Example:** Cancel A Backup Job
 * ```typescript
 * const stopBackupJob = yield* AWS.Backup.StopBackupJob();
 *
 * yield* stopBackupJob({ BackupJobId: jobId });
 * ```
 *
 * @binding
 */
export interface StopBackupJob extends Binding.Service<
  StopBackupJob,
  "AWS.Backup.StopBackupJob",
  () => Effect.Effect<
    (
      request: backup.StopBackupJobInput,
    ) => Effect.Effect<backup.StopBackupJobResponse, backup.StopBackupJobError>
  >
> {}
export const StopBackupJob = Binding.Service<StopBackupJob>("AWS.Backup.StopBackupJob");

export const StopBackupJobHttp = Layer.effect(
  StopBackupJob,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.StopBackupJob",
    operation: backup.stopBackupJob,
    actions: ["backup:StopBackupJob"],
  }),
);
