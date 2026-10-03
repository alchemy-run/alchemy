import * as Layer from "effect/Layer";
import {
  BackupEncryptionConfig,
  BackupEncryptionConfigProvider,
} from "./BackupEncryptionConfig.ts";
import { BackupPolicy, BackupPolicyProvider } from "./BackupPolicy.ts";
import {
  BackupProtectedItem,
  BackupProtectedItemProvider,
} from "./BackupProtectedItem.ts";
import {
  BackupProtectionContainer,
  BackupProtectionContainerProvider,
} from "./BackupProtectionContainer.ts";
import {
  BackupProtectionIntent,
  BackupProtectionIntentProvider,
} from "./BackupProtectionIntent.ts";
import {
  BackupResourceGuardProxy,
  BackupResourceGuardProxyProvider,
} from "./BackupResourceGuardProxy.ts";
import {
  BackupStorageConfig,
  BackupStorageConfigProvider,
} from "./BackupStorageConfig.ts";
import {
  BackupVaultConfig,
  BackupVaultConfigProvider,
} from "./BackupVaultConfig.ts";
import { Vault, VaultProvider } from "./Vault.ts";

export const resources = [
  BackupEncryptionConfig,
  BackupPolicy,
  BackupProtectedItem,
  BackupProtectionContainer,
  BackupProtectionIntent,
  BackupResourceGuardProxy,
  BackupStorageConfig,
  BackupVaultConfig,
  Vault,
];
export const layers = () =>
  Layer.mergeAll(
    BackupEncryptionConfigProvider(),
    BackupPolicyProvider(),
    BackupProtectedItemProvider(),
    BackupProtectionContainerProvider(),
    BackupProtectionIntentProvider(),
    BackupResourceGuardProxyProvider(),
    BackupStorageConfigProvider(),
    BackupVaultConfigProvider(),
    VaultProvider(),
  );
