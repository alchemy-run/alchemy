import * as fsx from "@distilled.cloud/aws/fsx";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFSxFileSystemHttpBinding } from "./BindingHttp.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Runtime binding for the `CreateBackup` operation scoped to one file system
 * (IAM actions `fsx:CreateBackup` and `fsx:TagResource` on the file system
 * ARN and on `arn:aws:fsx:*:*:backup/*` — the new backup's ARN is unknowable
 * at deploy time).
 *
 * Takes a user-initiated backup of the bound {@link FileSystem} — e.g.
 * before a risky data migration, or on an application-defined cadence
 * richer than the daily automatic backup. Pass a `ClientRequestToken` to
 * make the call idempotent. A backup already in progress surfaces the typed
 * `BackupInProgress`. Provide the implementation with
 * `Effect.provide(AWS.FSx.CreateBackupHttp)`.
 * ### Managing Backups at Runtime
 * **Example:** Take a pre-migration backup
 * ```typescript
 * const createBackup = yield* AWS.FSx.CreateBackup(files);
 *
 * const response = yield* createBackup({
 *   ClientRequestToken: `migration-${migrationId}`,
 *   Tags: [{ Key: "reason", Value: "pre-migration" }],
 * });
 * yield* Effect.log(`backup ${response.Backup?.BackupId} started`);
 * ```
 *
 * @binding
 */
export interface CreateBackup extends Binding.Service<
  CreateBackup,
  "AWS.FSx.CreateBackup",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    (
      request?: Omit<fsx.CreateBackupRequest, "FileSystemId">,
    ) => Effect.Effect<fsx.CreateBackupResponse, fsx.CreateBackupError>
  >
> {}
export const CreateBackup = Binding.Service<CreateBackup>("AWS.FSx.CreateBackup");

export const CreateBackupHttp = Layer.effect(
  CreateBackup,
  makeFSxFileSystemHttpBinding({
    tag: "AWS.FSx.CreateBackup",
    operation: fsx.createBackup,
    actions: ["fsx:CreateBackup", "fsx:TagResource"],
    // CreateBackup also authorizes on the new backup's own ARN, which is
    // unknowable at deploy time.
    extraResourceArns: ["arn:aws:fsx:*:*:backup/*"],
  }),
);
