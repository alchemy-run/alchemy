import * as Layer from "effect/Layer";
import { BackupInstance, BackupInstanceProvider } from "./BackupInstance.ts";
import { BackupPolicy, BackupPolicyProvider } from "./BackupPolicy.ts";
import { BackupVault, BackupVaultProvider } from "./BackupVault.ts";
import { ResourceGuard, ResourceGuardProvider } from "./ResourceGuard.ts";
import {
  ResourceGuardProxy,
  ResourceGuardProxyProvider,
} from "./ResourceGuardProxy.ts";

export const resources = [
  BackupInstance,
  BackupPolicy,
  BackupVault,
  ResourceGuard,
  ResourceGuardProxy,
];
export const layers = () =>
  Layer.mergeAll(
    BackupInstanceProvider(),
    BackupPolicyProvider(),
    BackupVaultProvider(),
    ResourceGuardProvider(),
    ResourceGuardProxyProvider(),
  );
