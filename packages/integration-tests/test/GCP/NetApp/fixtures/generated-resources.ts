import * as GCP from "@alchemy.run/gcp";

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
export const ProbeStoragePool = GCP.NetApp.StoragePool("ProbeStoragePool", {
  network: "default",
  serviceLevel: "STANDARD",
  capacityGib: 2048,
  description: "alchemy-test-pool",
});
