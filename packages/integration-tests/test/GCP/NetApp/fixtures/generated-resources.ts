import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";
import { NetAppNetwork } from "./network.ts";

/** NetApp resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeActiveDirectory = GCP.NetApp.ActiveDirectory("ProbeActiveDirectory", {
  domain: "ad.example.com",
  dns: "10.0.0.2",
  netBiosPrefix: "netapp",
  username: "admin",
  password: "NotARealPassword1",
  description: "alchemy-test-ad",
});
export const ProbeBackupPolicy = GCP.NetApp.BackupPolicy("ProbeBackupPolicy", {
  location: "us-central1",
  dailyBackupLimit: 2,
  weeklyBackupLimit: 1,
  monthlyBackupLimit: 1,
  description: "alchemy nightly backups",
});
export const ProbeBackupVault = GCP.NetApp.BackupVault("ProbeBackupVault", {
  description: "alchemy-test-vault",
});
export const ProbeHostGroup = GCP.NetApp.HostGroup("ProbeHostGroup", {
  hosts: ["iqn.1993-08.org.debian:01:alchemy"],
  description: "alchemy-test-hosts",
});
/** A 2 TiB pool on the suite's Private Service Access network, which volumes need. */
export const ProbeStoragePool = Effect.gen(function* () {
  const network = yield* NetAppNetwork;
  return yield* GCP.NetApp.StoragePool("ProbeStoragePool", {
    network,
    serviceLevel: "STANDARD",
    capacityGib: 2048,
    description: "alchemy-test-pool",
  });
});
export const ProbeVolume = Effect.gen(function* () {
  const pool = yield* ProbeStoragePool;
  return yield* GCP.NetApp.Volume("ProbeVolume", {
    storagePool: pool.name,
    protocols: ["NFSV3"],
    capacityGib: 100,
    shareName: "alchprobe",
  });
});
export const ProbeQuotaRule = Effect.gen(function* () {
  const volume = yield* ProbeVolume;
  return yield* GCP.NetApp.VolumesQuotaRule("ProbeQuotaRule", {
    volume: volume.name,
    type: "DEFAULT_USER_QUOTA",
    diskLimitMib: 1024,
  });
});
export const ProbeSnapshot = Effect.gen(function* () {
  const volume = yield* ProbeVolume;
  return yield* GCP.NetApp.VolumesSnapshot("ProbeSnapshot", { volume: volume.name });
});
export const ProbeVolumeBackup = Effect.gen(function* () {
  const volume = yield* ProbeVolume;
  const vault = yield* ProbeBackupVault;
  return yield* GCP.NetApp.BackupVaultsBackup("ProbeVolumeBackup", {
    backupVault: vault.name,
    sourceVolume: volume.name,
  });
});

/** CMEK through the testing project's standing key (the one NetApp's own suite uses). */
export const ProbeKmsConfig = Effect.gen(function* () {
  const project = yield* deployProject;
  return yield* GCP.NetApp.KmsConfig("ProbeKmsConfig", {
    cryptoKeyName: `projects/${project}/locations/us-central1/keyRings/alchemy-test-keyring/cryptoKeys/alchemy-test-cryptokey-enc`,
  });
});
