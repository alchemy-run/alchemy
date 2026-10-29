import * as GCP from "@alchemy.run/gcp";

/** BackupDR resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeBackupVault = GCP.BackupDR.BackupVault("ProbeBackupVault", {
  backupMinimumEnforcedRetentionDuration: "86400s",
  description: "alchemy-test-vault",
});
