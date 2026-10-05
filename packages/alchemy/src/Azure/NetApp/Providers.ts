import * as Layer from "effect/Layer";
import { Account, AccountProvider } from "./Account.ts";
import { BackupPolicy, BackupPolicyProvider } from "./BackupPolicy.ts";
import { BackupVault, BackupVaultProvider } from "./BackupVault.ts";
import { Bucket, BucketProvider } from "./Bucket.ts";
import { Cache, CacheProvider } from "./Cache.ts";
import { CapacityPool, CapacityPoolProvider } from "./CapacityPool.ts";
import { Snapshot, SnapshotProvider } from "./Snapshot.ts";
import { SnapshotPolicy, SnapshotPolicyProvider } from "./SnapshotPolicy.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import { VolumeGroup, VolumeGroupProvider } from "./VolumeGroup.ts";
import { VolumeQuotaRule, VolumeQuotaRuleProvider } from "./VolumeQuotaRule.ts";

export const resources = [
  Account,
  BackupPolicy,
  BackupVault,
  Bucket,
  Cache,
  CapacityPool,
  Snapshot,
  SnapshotPolicy,
  Volume,
  VolumeGroup,
  VolumeQuotaRule,
];
export const layers = () =>
  Layer.mergeAll(
    AccountProvider(),
    BackupPolicyProvider(),
    BackupVaultProvider(),
    BucketProvider(),
    CacheProvider(),
    CapacityPoolProvider(),
    SnapshotProvider(),
    SnapshotPolicyProvider(),
    VolumeProvider(),
    VolumeGroupProvider(),
    VolumeQuotaRuleProvider(),
  );
