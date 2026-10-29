import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

/** Backup for GKE channels the generated bindings bind (plans need a GKE cluster). */
export const ProbeBackupChannel = Effect.gen(function* () {
  const project = yield* deployProject;
  return yield* GCP.GKEBackup.BackupChannel("ProbeBackupChannel", {
    destinationProject: `projects/${project}`,
  });
});
export const ProbeRestoreChannel = Effect.gen(function* () {
  const project = yield* deployProject;
  return yield* GCP.GKEBackup.RestoreChannel("ProbeRestoreChannel", {
    destinationProject: `projects/${project}`,
  });
});
