import * as backup from "@distilled.cloud/aws/backup";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `ListRestoreJobs` operation (IAM action
 * `backup:ListRestoreJobs`).
 *
 * Lists the account's restore jobs, with optional filters (status, account,
 * time window). Provide the implementation with
 * `Effect.provide(AWS.Backup.ListRestoreJobsHttp)`.
 * ### Restoring Recovery Points
 * **Example:** List Running Restore Jobs
 * ```typescript
 * const listRestoreJobs = yield* AWS.Backup.ListRestoreJobs();
 *
 * const page = yield* listRestoreJobs({ ByStatus: "RUNNING" });
 * ```
 *
 * @binding
 */
export interface ListRestoreJobs extends Binding.Service<
  ListRestoreJobs,
  "AWS.Backup.ListRestoreJobs",
  () => Effect.Effect<
    (
      request?: backup.ListRestoreJobsInput,
    ) => Effect.Effect<backup.ListRestoreJobsOutput, backup.ListRestoreJobsError>
  >
> {}
export const ListRestoreJobs = Binding.Service<ListRestoreJobs>("AWS.Backup.ListRestoreJobs");

export const ListRestoreJobsHttp = Layer.effect(
  ListRestoreJobs,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.ListRestoreJobs",
    operation: backup.listRestoreJobs,
    actions: ["backup:ListRestoreJobs"],
  }),
);
