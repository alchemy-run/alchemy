import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Effect from "effect/Effect";

/** Backup for GKE channels the generated bindings bind (plans need a GKE cluster). */
export const ProbeBackupChannel = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  return yield* GCP.GKEBackup.BackupChannel("ProbeBackupChannel", {
    destinationProject: `projects/${project}`,
  });
});
export const ProbeRestoreChannel = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  return yield* GCP.GKEBackup.RestoreChannel("ProbeRestoreChannel", {
    destinationProject: `projects/${project}`,
  });
});
